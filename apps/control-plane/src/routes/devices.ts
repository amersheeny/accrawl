import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../db/client';
import { requireOperator, requireDevice } from '../auth/middleware';
import {
  listDeviceProxyConnections, listDevices, revokeDeviceAccess, updateDevicePush,
} from '../data/devices';
import {
  approvePairingIntent,
  cancelPairingIntent,
  claimPairingIntent,
  completePairingIntent,
  createPairingIntent,
  getPairingIntent,
} from '../data/device-pairing';
import { requireOperatorSubject } from '../auth/subjects';
import { getUserDataStore } from '../storage';

const PUSH_TRANSPORTS = ['fcm', 'unifiedpush', 'websocket'] as const;
const createIntentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  connectionGrants: z.array(z.string().uuid()).max(100),
});
const publicPairingSchema = z.object({
  pairingCode: z.string().regex(/^acpair_[A-Za-z0-9_-]{40,}$/),
  claim: z.string().regex(/^acclaim_[A-Za-z0-9_-]{40,}$/),
});
const pushSchema = z.object({
  pushTransport: z.enum(PUSH_TRANSPORTS),
  pushToken: z.string().min(1).max(4096),
});

function companionTransportAllowed(req: FastifyRequest): boolean {
  if (req.protocol === 'https') return true;
  return process.env.NODE_ENV !== 'production'
    && process.env.ACCRAWL_COMPANION_ALLOW_INSECURE_HTTP === '1';
}

async function fenceRevokedDeviceCrawls(sessionIds: string[]): Promise<void> {
  const store = await getUserDataStore();
  for (const sessionId of sessionIds) {
    await store.cancelSession(sessionId);
  }
}

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/devices/pairing-intents', { preHandler: requireOperator }, async (req, reply) => {
    const parsed = createIntentSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const result = await createPairingIntent(db, parsed.data, requireOperatorSubject(req));
      await (await getUserDataStore()).writeAudit({
        actorType: 'operator',
        actorId: req.operatorSubject,
        action: 'device.pairing_request.create',
        targetType: 'device_pairing_intent',
        targetId: result.intent.id,
        sourceIp: req.ip,
      });
      return reply
        .header('Cache-Control', 'no-store')
        .code(201)
        .send({ ...result.intent, pairingCode: result.pairingCode });
    } catch (error) {
      if (error instanceof Error && /connection grants/.test(error.message)) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get('/api/devices/pairing-intents/:id', { preHandler: requireOperator }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const intent = await getPairingIntent(db, id, requireOperatorSubject(req));
    if (!intent) {
      return reply.code(404).send({
        error: 'This pairing request is no longer available. Start pairing again.',
      });
    }
    return reply.header('Cache-Control', 'no-store').send(intent);
  });

  app.post('/api/devices/pairing-intents/:id/approve', { preHandler: requireOperator }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const status = await approvePairingIntent(db, id, requireOperatorSubject(req));
    if (status == null) {
      return reply.code(404).send({
        error: 'This pairing request is no longer available. Start pairing again.',
      });
    }
    if (status !== 'approved') return reply.code(409).send({ status });
    await (await getUserDataStore()).writeAudit({
      actorType: 'operator',
      actorId: req.operatorSubject,
      action: 'device.pairing_request.approve',
      targetType: 'device_pairing_intent',
      targetId: id,
      sourceIp: req.ip,
    });
    return reply.header('Cache-Control', 'no-store').send({ status });
  });

  app.delete('/api/devices/pairing-intents/:id', { preHandler: requireOperator }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const cancelled = await cancelPairingIntent(db, id, requireOperatorSubject(req));
    if (!cancelled) {
      return reply.code(404).send({
        error: 'This pairing request is no longer active. Start pairing again.',
      });
    }
    return reply.code(204).send();
  });

  app.post('/api/devices/pairing/claim', async (req, reply) => {
    if (!companionTransportAllowed(req)) {
      return reply.code(426).send({
        error: 'Use HTTPS to pair the companion app.',
      });
    }
    const parsed = publicPairingSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'This pairing request is invalid. Start pairing again.',
      });
    }
    const result = await claimPairingIntent(db, parsed.data.pairingCode, parsed.data.claim);
    return reply.header('Cache-Control', 'no-store').send(result);
  });

  app.post('/api/devices/pairing/complete', async (req, reply) => {
    if (!companionTransportAllowed(req)) {
      return reply.code(426).send({
        error: 'Use HTTPS to pair the companion app.',
      });
    }
    const parsed = publicPairingSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'This pairing request is invalid. Start pairing again.',
      });
    }
    const result = await completePairingIntent(db, parsed.data.pairingCode, parsed.data.claim);
    return reply
      .header('Cache-Control', 'no-store')
      .code(result.status === 'paired' ? 201 : 200)
      .send(result);
  });

  app.get('/api/devices', { preHandler: requireOperator }, async (req) => {
    return { devices: await listDevices(db, requireOperatorSubject(req)) };
  });

  // The companion's view of its own pairing: its operator-chosen name, how many connections it was
  // granted, and which of those currently have the device proxy enabled. The proxy list is the
  // companion's signal for whether to run its standing watch service at all — a pairing with none runs
  // no service and shows no standing notification. Counts/labels only; no financial data.
  app.get('/api/devices/self', { preHandler: requireDevice }, async (req) => {
    const device = req.device!;
    const deviceProxyConnections = await listDeviceProxyConnections(db, device);
    return {
      name: device.name,
      connectionCount: device.connectionGrants.length,
      deviceProxyConnections: deviceProxyConnections.map((c) => ({ label: c.label })),
    };
  });

  app.delete('/api/devices/self', { preHandler: requireDevice }, async (req, reply) => {
    const device = req.device!;
    const result = await revokeDeviceAccess(
      db,
      device.id,
      device.ownerSubject,
      device.credentialHash,
    );
    if (!result.revoked) {
      return reply.code(401).send({
        error: 'This device’s access has already been revoked.',
      });
    }
    await fenceRevokedDeviceCrawls(result.sessionIds);
    await (await getUserDataStore()).writeAudit({
      actorType: 'device',
      actorId: device.id,
      action: 'device.revoke_self',
      targetType: 'device',
      targetId: device.id,
      sourceIp: req.ip,
    });
    return reply.code(204).send();
  });

  app.delete('/api/devices/:id', { preHandler: requireOperator }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const result = await revokeDeviceAccess(db, id, requireOperatorSubject(req));
    if (!result.revoked) return reply.code(404).send({ error: 'device not found' });
    await fenceRevokedDeviceCrawls(result.sessionIds);
    await (await getUserDataStore()).writeAudit({
      actorType: 'operator',
      actorId: req.operatorSubject,
      action: 'device.revoke',
      targetType: 'device',
      targetId: id,
      sourceIp: req.ip,
    });
    return reply.code(204).send();
  });

  /**
   * What a paired Companion needs in order to receive a wake from THIS deployment.
   *
   * A background wake on Android is delivered by the platform's push service, and an app can only
   * receive one if it registered with the same project the sender sends through. That used to be baked
   * into the app at build time, which welded every published build to one deployment: a self-hoster's
   * own sender could not reach an app registered elsewhere, so they had to rebuild the app from source
   * to be able to use it at all.
   *
   * Asking the deployment it is paired with removes that. One build works against any deployment,
   * because the answer arrives after pairing rather than at compile time. None of these four values is
   * a secret — they are readable inside every app that ships with them — but the route is still
   * device-authenticated, because nothing here needs to be answerable to a stranger.
   */
  app.get('/api/devices/push-config', { preHandler: requireDevice }, async (_req, reply) => {
    const client = config.companionPushClient;
    if (!client) {
      // A deployment that sends no wakes is a working deployment: the operator types the code into the
      // console instead. Say that plainly rather than returning a half-filled configuration the app
      // would try, and fail, to register with.
      return reply.code(404).send({
        error: 'this deployment does not send Companion wake-ups',
        code: 'push_not_configured',
      });
    }
    return reply.send(client);
  });

  app.post('/api/devices/push', { preHandler: requireDevice }, async (req, reply) => {
    const parsed = pushSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'pushTransport + pushToken required' });
    if (!(await updateDevicePush(
      db,
      req.device!,
      parsed.data.pushTransport,
      parsed.data.pushToken,
    ))) {
      return reply.code(401).send({
        error: 'access is no longer authorized',
        code: 'access_revoked',
      });
    }
    return reply.code(204).send();
  });
}
