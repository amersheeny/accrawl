/**
 * Crawl-now route: trigger an immediate crawl for a connection. OPERATOR-ONLY — retrieval is the deployment
 * owner's own concern, never a capability the public API hands out. Consumers read already-retrieved data and
 * take freshness from it; connections otherwise refresh on their own schedule.
 *
 *   POST /api/connections/:id/crawl  -> 202 { sessionId } | 404 not-found | 409 already running | 502 failed-early
 *
 * Non-blocking: the request returns after the session is created and the worker
 * transport durably acknowledges dispatch — it does NOT await the whole crawl.
 * The web client then navigates to the returned
 * session's live monitor (SSE) to watch progress and submit a 2FA code. A crawl that fails BEFORE dispatch
 * (locked, unverified domain, non-crawlable status) still resolves synchronously here so the operator gets
 * the real reason; once dispatch starts, the run continues detached and its outcome is logged/surfaced via
 * the session record, never awaited by the HTTP request.
 *
 * The early return is driven off the transport acknowledgement, not a
 * timer/poll, so a request-scoped runtime cannot stop before dispatch commits.
 * A per-process lease owner tags the session so the reaper can attribute a
 * crashed run.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { HOSTED_COPY, type CrawlAck, type CrawlRequest } from '@accrawl/contracts';
import { db } from '../db/client';
import { requireOperatorOrApiKey } from '../auth/middleware';
import { actorCanAccessConnection } from '../auth/authorization';
import { dispatchCrawlToEngine } from '../orchestration/dispatch-engine';
import { getUserDataStore } from '../storage';

const hasUnexpectedBody = (body: unknown): boolean =>
  body != null
  && (
    typeof body !== 'object'
    || Array.isArray(body)
    || Object.keys(body as Record<string, unknown>).length > 0
  );

const LEASE_OWNER = `${hostname()}:${randomUUID().slice(0, 8)}`;

export async function crawlRoutes(app: FastifyInstance): Promise<void> {
  // An owner in the console, or an expiring key they minted for their own automation. A third-party
  // grant cannot reach here: the guard refuses OAuth access tokens outright, and the scope is not one
  // OAuth can even ask for. Which connections either may drive is decided below, per request.
  app.post('/api/connections/:id/crawl', { preHandler: requireOperatorOrApiKey('write:crawl') }, async (req, reply) => {
    if (hasUnexpectedBody(req.body)) {
      return reply.code(400).send({ error: HOSTED_COPY.crawlRequestBodyMustBeEmpty });
    }
    const connectionId = (req.params as { id: string }).id;
    // An operator drives only their own connections. This is the connection-level
    // authorization the auth guard defers to the handler.
    if (!(await actorCanAccessConnection(db, req, connectionId))) {
      return reply.code(404).send({ error: HOSTED_COPY.connectionNotFound });
    }
    const actorType = 'operator';
    const actorId = req.operatorSubject ?? null;
    const store = await getUserDataStore();
    // The injected dispatch wraps the real engine call so we can publish the sessionId the moment runCrawl
    // reaches dispatch (lock acquired, credentials assembled) — that's when the run is committed enough to
    // hand the operator a live monitor, and before the long engine round-trip we must NOT block on.
    let signalDispatching!: (sessionId: string) => void;
    const dispatching = new Promise<string>((resolve) => { signalDispatching = resolve; });
    const dispatchCrawl = async (request: CrawlRequest): Promise<CrawlAck> => {
      const acknowledgement = await dispatchCrawlToEngine(request);
      // A scale-to-zero runtime may throttle CPU as soon as this HTTP response
      // ends. Publish the session only after the transport has durably accepted
      // the worker execution, never merely because dispatch was entered.
      if (acknowledgement.accepted) signalDispatching(request.sessionId);
      return acknowledgement;
    };

    // Kick off the crawl detached. We race two real signals: "dispatch durably
    // accepted" (return the session id) vs. "runCrawl resolved before an
    // accepted dispatch" (locked or an early/transport failure).
    const run = store.runCrawl(
      { dispatchCrawl, leaseOwner: LEASE_OWNER },
      { connectionId },
    );
    // The detached run's outcome is surfaced via the session record; here we only guarantee a failure is
    // never swallowed (an unexpected throw escapes runCrawl's own try/catch only in pathological cases).
    run.catch((err) => req.log.error({ err, connectionId }, 'detached crawl run rejected'));

    const outcome = await Promise.race([
      dispatching.then((sessionId) => ({ kind: 'dispatching' as const, sessionId })),
      run.then((result) => ({ kind: 'settled' as const, result })),
    ]);

    if (outcome.kind === 'dispatching') {
      await store.writeAudit({ actorType, actorId, action: 'connection.crawl_now', targetType: 'connection', targetId: connectionId, sourceIp: req.ip });
      return reply.code(202).send({ sessionId: outcome.sessionId });
    }

    // Settled before dispatch: locked (a crawl already runs) or an early refusal (unverified/non-crawlable).
    const { result } = outcome;
    if (result.outcome === 'locked') {
      return reply.code(409).send({ error: HOSTED_COPY.crawlAlreadyRunning });
    }
    await store.writeAudit({ actorType, actorId, action: 'connection.crawl_now', targetType: 'connection', targetId: connectionId, sourceIp: req.ip });
    // It reached a terminal state without ever dispatching → an early failure. Report it directly.
    return reply.code(502).send({
      ...result,
      error: result.error === HOSTED_COPY.refreshStartFailure
        ? HOSTED_COPY.crawlStartFailure
        : result.error,
    });
  });
}
