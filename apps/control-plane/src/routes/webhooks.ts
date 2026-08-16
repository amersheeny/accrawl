/**
 * Webhook management (operator-only) — register endpoints to receive HMAC-signed crawl-outcome
 * notifications (Accrawl as a data provider).
 *
 *  POST   /api/webhooks   { url, events } -> 201 { id, url, events, secret, ... }  (secret shown ONCE)
 *  GET    /api/webhooks                    -> { webhooks: [...] }  (NEVER the secret)
 *  DELETE /api/webhooks/:id                -> 204 | 404
 */
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client';
import { requireOperator } from '../auth/middleware';
import { isBlockedAddress, mappedToIpv4 } from '../lib/ssrf';
import { createWebhook, listWebhooks, deleteWebhook, WEBHOOK_EVENTS } from '../data/webhooks';
import { requireOperatorSubject } from '../auth/subjects';
import { hostedCell } from '../tenancy/directory';
import { getUserDataStore } from '../storage';

/**
 * Whether a webhook URL is safe to register. https-only (a plaintext endpoint would expose the notification
 * and let the HMAC be stripped in transit), EXCEPT a co-located loopback receiver which the self-hoster may
 * point at over http. A literal private/metadata IP (169.254.169.254, RFC-1918, etc.) is rejected so a
 * registration can't turn Accrawl's signed POST into an SSRF probe of the internal network. Delivery performs
 * a second, socket-bound DNS check and pins the connection to the validated public address, so a hostname that
 * later changes or attempts DNS rebinding is rejected at connect time.
 */
export function isSafeWebhookUrl(raw: string, allowLoopback = !hostedCell): boolean {
  let p: URL;
  try {
    p = new URL(raw);
  } catch {
    return false;
  }
  const host = p.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return allowLoopback;
  }
  if (p.protocol !== 'https:') return false;
  if (net.isIP(host) && isBlockedAddress(mappedToIpv4(host) ?? host)) return false; // literal private/metadata IP
  return true;
}

const createSchema = z.object({
  url: z.string().url().refine(isSafeWebhookUrl, {
    message: 'Enter a public HTTPS webhook URL. URLs for private networks or cloud metadata services are not allowed.',
  }),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/webhooks', { preHandler: requireOperator }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { id, secret, view } = await createWebhook(
      db,
      parsed.data,
      requireOperatorSubject(req),
    );
    await (await getUserDataStore()).writeAudit({ actorType: 'operator', actorId: req.operatorSubject, action: 'webhook.create', targetType: 'webhook', targetId: id, sourceIp: req.ip });
    // The signing secret is returned ONCE here and never shown again (listWebhooks omits it).
    return reply.code(201).send({ ...view, secret });
  });

  app.get('/api/webhooks', { preHandler: requireOperator }, async (req) => {
    return { webhooks: await listWebhooks(db, requireOperatorSubject(req)) };
  });

  app.delete('/api/webhooks/:id', { preHandler: requireOperator }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deleteWebhook(db, id, requireOperatorSubject(req));
    if (!ok) return reply.code(404).send({ error: 'webhook not found' });
    await (await getUserDataStore()).writeAudit({ actorType: 'operator', actorId: req.operatorSubject, action: 'webhook.delete', targetType: 'webhook', targetId: id, sourceIp: req.ip });
    return reply.code(204).send();
  });
}
