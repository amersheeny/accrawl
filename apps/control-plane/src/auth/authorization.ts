import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/client';
import { keyGrantsConnection, refreshApiKeyContext } from './apiKeys';
import { refreshDeviceContext } from '../data/devices';
import { getUserDataStore } from '../storage';

export async function actorCanAccessConnection(
  db: Db,
  req: FastifyRequest,
  connectionId: string,
): Promise<boolean> {
  let actorOwner = req.operatorSubject;
  if (!actorOwner && req.device) {
    const device = await refreshDeviceContext(db, req.device);
    if (!device || !device.connectionGrants.includes(connectionId)) return false;
    actorOwner = device.ownerSubject;
  }
  if (!actorOwner && req.apiKey) {
    const key = await refreshApiKeyContext(db, req.apiKey);
    if (!key || !keyGrantsConnection(key, connectionId)) return false;
    actorOwner = key.ownerSubject;
  }
  if (!actorOwner) return false;
  return (await getUserDataStore(db))
    .actorOwnsConnection(actorOwner, connectionId);
}

export async function actorCanAccessSession(
  db: Db,
  req: FastifyRequest,
  sessionId: string,
): Promise<boolean> {
  if (req.operatorSubject) {
    return (await getUserDataStore(db)).actorOwnsSync(
      req.operatorSubject,
      sessionId,
    );
  }
  const connectionId = await (await getUserDataStore(db))
    .getSyncConnectionId(sessionId);
  return connectionId != null
    && actorCanAccessConnection(db, req, connectionId);
}

export async function actorCanAccessAccount(
  db: Db,
  req: FastifyRequest,
  accountId: string,
): Promise<boolean> {
  const store = await getUserDataStore(db);
  if (req.operatorSubject) {
    return store.actorOwnsAccount(req.operatorSubject, accountId);
  }

  const connectionId = await store.getAccountConnectionId(accountId);
  if (!connectionId) return false;
  if (req.device) {
    const device = await refreshDeviceContext(db, req.device);
    return !!device
      && device.connectionGrants.includes(connectionId)
      && store.actorOwnsConnection(device.ownerSubject, connectionId);
  }
  if (req.apiKey) {
    const key = await refreshApiKeyContext(db, req.apiKey);
    return !!key
      && keyGrantsConnection(key, connectionId)
      && store.actorOwnsConnection(key.ownerSubject, connectionId);
  }
  return false;
}
