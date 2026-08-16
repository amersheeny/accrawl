/**
 * Accrawl control-plane API server (Fastify).
 *
 * Phase-2 scaffold: boots Fastify with a health route. Routes for institutions,
 * connections, sessions (+ SSE), OTP, jobs, and the data API are added in
 * subsequent units, behind operator auth + scoped API-key auth.
 */
import type { FastifyPluginCallback } from 'fastify';
import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { config } from './config';
import { versionRoutes } from './routes/version';
import { setupRoutes } from './routes/setup';
import { authRoutes } from './routes/auth';
import { institutionRoutes } from './routes/institutions';
import { connectionRoutes } from './routes/connections';
import { crawlRoutes } from './routes/crawl';
import { sessionRoutes } from './routes/sessions';
import { deviceRoutes } from './routes/devices';
import { accountRoutes } from './routes/accounts';
import { webhookRoutes } from './routes/webhooks';
import { openApiRoutes } from './routes/openapi';
import { emailOtpRoutes } from './routes/email-otp';
import { oauthClientRoutes } from './routes/oauth-clients';
import { oauthRoutes, registerFormBodyParser } from './routes/oauth';
import { oauthGrantRoutes } from './routes/oauth-grants';
import { organizationShareRoutes } from './routes/organization-shares';
import { companionRoutes } from './routes/companion';
import { apiErrorHandler } from './lib/error-handler';
import { bindTenant } from './tenancy/context';
import { hostedCell, tenantDirectory } from './tenancy/directory';
import { runAsTenant } from './tenancy/context';
import { acceptTrustedOperatorIdentity } from './auth/middleware';
import { requestTenantHost } from './tenancy/request-host';
import { workerBrokerRoutes } from './routes/worker-broker';
import { hostedWorkerPlane } from './orchestration/hosted-worker-plane';
import { hostedCrawlLifecycleRoutes } from './routes/hosted-crawl-lifecycle';
import { internalEngineWakeRoutes } from './routes/internal-engine-wake';

export async function buildServer(opts: { rateLimit?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
    bodyLimit: 2 * 1024 * 1024,
    // The control-plane sits behind exactly one front proxy (Caddy) and is never host-published, so the
    // real client IP is the LAST hop appended to X-Forwarded-For. Trust exactly one hop — NOT `true`
    // (trust the whole chain), which would let an attacker spoof X-Forwarded-For and get a fresh
    // rate-limit bucket per forged IP, defeating the login brute-force throttle. With `1`, req.ip is
    // Caddy's appended address and client-supplied leftmost XFF entries are ignored.
    trustProxy: 1,
  });

  // Resolve the tenant before any authentication or database access. In self-hosted mode there is one
  // implicit tenant and every Host is accepted for backwards compatibility. A hosted cell fails closed
  // on an unknown Host; a bearer token is never enough to select or cross into another tenant.
  app.addHook('onRequest', (req, reply, done) => {
    // Kubernetes probes do not carry a tenant hostname. This endpoint is deliberately
    // process-only: it performs no authentication or database access and exposes no
    // tenant data. Every application route still requires exact Host resolution.
    if (req.raw.url === '/healthz') {
      done();
      return;
    }
    const tenant = hostedCell
      ? tenantDirectory.resolveHost(requestTenantHost(
        req.headers,
        config.trustInternalTenantHostHeader,
      ))
      : tenantDirectory.tenants[0];
    if (!tenant) {
      void reply.code(421).send();
      return;
    }
    bindTenant(tenant, () => {
      acceptTrustedOperatorIdentity(req);
      done();
    });
  });

  // Rate limiting: a generous global safety net + a strict per-route limit on /api/auth/login (the
  // master-password brute-force target). Skipped under test so the shared-server suites don't accumulate
  // hits across cases; a dedicated test forces it on to verify the login throttle.
  if (opts.rateLimit ?? config.nodeEnv !== 'test') {
    // Declared with this app's own fastify types. The plugin ships its type built on the copy of
    // fastify it resolves for itself, and fastify 5.12 made the two no longer interchangeable, so
    // registering it directly stopped compiling even though the object is exactly what register wants.
    // Naming the type here restores one declaration for both sides; the options below stay checked
    // against the plugin's own RateLimitPluginOptions.
    const rateLimit = (await import('@fastify/rate-limit'))
      .default as unknown as FastifyPluginCallback<RateLimitPluginOptions>;
    await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  }

  // Accept application/x-www-form-urlencoded (the OAuth token endpoint + the consent form) alongside JSON.
  registerFormBodyParser(app);

  // Tolerate a TRULY EMPTY body on application/json requests. Browsers and HTTP clients routinely send
  // `content-type: application/json` on a request that carries no payload (every DELETE, a no-body POST like
  // /cancel); Fastify's default JSON parser rejects that with 400 "Body cannot be empty…" BEFORE the route
  // (and its auth) ever runs. Only a ZERO-LENGTH body is treated as `{}` (so each route's own validation
  // decides, and handlers reading req.body properties see missing fields, not a TypeError). EVERYTHING else —
  // including a whitespace-only body — is delegated to Fastify's DEFAULT secure JSON parser, so prototype-/
  // constructor-poisoning protection (secure-json-parse) and invalid-JSON 400s are fully preserved.
  const secureJsonParser = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.length === 0) { done(null, {}); return; }
    secureJsonParser(req, text, done);
  });

  // 5xx responses must not leak internal error detail; 4xx keep their (safe) messages.
  app.setErrorHandler(apiErrorHandler);

  // Security headers on every control-plane response. The control-plane serves ONLY the JSON API + the OAuth
  // consent HTML — none of it is ever meant to be embedded — so deny framing outright: this shuts down
  // clickjacking / UI-redress of the /oauth/authorize consent page (where an overlay could trick the operator
  // into typing their password + approving a grant). nosniff is cheap hardening.
  //
  // The referrer policy is `same-origin`, NOT `no-referrer`, and the difference is load-bearing rather than
  // stylistic. The consent page submits a real HTML form, and Fetch's "append a request Origin header" step
  // sends a non-GET NAVIGATION with `Origin: null` when the policy is `no-referrer`. So the page's own privacy
  // header erased the only evidence the origin check downstream has, `new URL('null')` threw, and EVERY
  // approval was refused with a bodyless 403 — measured in production on 2026-08-06. It hit form posts alone:
  // a fetch() is sent in cors mode, which carries the real origin under any policy, so signing in worked while
  // nothing behind it did.
  //
  // `same-origin` sends the real origin on a same-origin submission and `null` on a cross-origin one, which is
  // exactly the question a CSRF check is asking. It still sends nothing at all cross-origin, so it keeps the
  // property `no-referrer` was chosen for: an authorization `code` in a redirect URL cannot leak onward via
  // Referer. Every stricter-sounding alternative is worse here — `strict-origin-when-cross-origin` would leak
  // this origin to third parties, and `no-referrer` breaks the flow outright.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Frame-Options', 'DENY');
    // The console holds the operator's bearer token in localStorage, so script injection here is not a
    // defacement — it reads the token and with it every account's financial data and the ability to
    // start a crawl. `frame-ancestors` alone said nothing about scripts; this states the whole policy.
    //
    // Every directive is what the shipped code actually needs, verified against the built bundle:
    //   script-src 'self'   the console loads ONE external module script and no inline script, and the
    //                       server-rendered consent page has none either — so the directive that closes
    //                       the token-theft path costs nothing.
    //   style-src           'unsafe-inline' is required: the console sets style attributes on elements
    //                       and the consent page carries an inline <style>. Injected CSS cannot read a
    //                       token, so this is a far smaller concession than leaving script-src unset.
    //   img-src blob:       session screenshots are fetched as blobs and shown via createObjectURL.
    //   object-src/base-uri closed outright; neither is used, and both are classic injection levers.
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'accrawl-control-plane',
    env: config.nodeEnv,
  }));
  app.get('/healthz', async () => ({ status: 'ok' }));

  await app.register(versionRoutes);
  if (!hostedCell) await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(institutionRoutes);
  await app.register(connectionRoutes);
  await app.register(crawlRoutes);
  await app.register(sessionRoutes);
  await app.register(deviceRoutes);
  await app.register(accountRoutes);
  await app.register(webhookRoutes);
  await app.register(openApiRoutes);
  await app.register(emailOtpRoutes);
  await app.register(oauthClientRoutes);
  await app.register(oauthRoutes);
  await app.register(oauthGrantRoutes);
  await app.register(organizationShareRoutes);
  await app.register(companionRoutes);
  await app.register(internalEngineWakeRoutes);
  // Mounted only when this deployment actually runs its crawls somewhere else, which is exactly when
  // it has registered the machinery those routes need. Asking the registry rather than reading a
  // configuration value means the routes cannot be mounted with nothing behind them.
  if (hostedCell && hostedWorkerPlane()) {
    await app.register(workerBrokerRoutes);
    await app.register(hostedCrawlLifecycleRoutes);
  }

  return app;
}

/**
 * Start the control-plane and keep it running.
 *
 * Exported so a deployment that supplies its own providers can register them and then start this exact
 * server, rather than reimplementing the boot sequence and drifting from it.
 */
export async function startControlPlane(): Promise<void> {
  // Before anything binds a port: a deployment configured for an implementation nobody registered
  // cannot serve a crawl, and should say so now rather than look healthy until someone asks for one.
  const [{ assertPersistenceBackendRegistered }, { assertEngineDispatcherRegistered }] = await Promise.all([
    import('./storage'),
    import('./orchestration/dispatch-engine'),
  ]);
  assertPersistenceBackendRegistered();
  assertEngineDispatcherRegistered();

  const app = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`accrawl control-plane listening on :${config.port}`);

  // Hosted services scale to zero, so no process timer owns crawl rotation.
  // The timer below is only an outbox repair sweep: cold starts and warm
  // instances both retry any durable `taskArmed: false` generation left by a
  // transient failure of the queue that holds a deferred callback.
  let hostedScheduleRepairTimer: NodeJS.Timeout | undefined;
  const { getHostedCrawlLifecycleStore, hostedCrawlLifecycleAvailable } = await import('./storage');
  if (await hostedCrawlLifecycleAvailable()) {
    let sweepInFlight: Promise<void> | null = null;
    const repairHostedSchedules = (): Promise<void> => {
      if (sweepInFlight) return sweepInFlight;
      sweepInFlight = (async () => {
        for (const tenant of tenantDirectory.tenants) {
          try {
            const armed = await runAsTenant(tenant, async () =>
              (await getHostedCrawlLifecycleStore()).ensureScheduledConnections());
            app.log.info({ tenantId: tenant.id, armed }, 'hosted crawl schedules checked');
          } catch (err) {
            app.log.error({ err, tenantId: tenant.id }, 'hosted crawl schedule repair failed');
          }
        }
      })().finally(() => { sweepInFlight = null; });
      return sweepInFlight;
    };
    await repairHostedSchedules();
    hostedScheduleRepairTimer = setInterval(() => {
      void repairHostedSchedules();
    }, 60_000);
    hostedScheduleRepairTimer.unref();
  }

  // Lazily start the pg-boss scheduler (only loads pg-boss when enabled).
  const bosses: PgBoss[] = [];
  if (config.schedulerEnabled) {
    const { startScheduler } = await import('./scheduling/pgboss');
    for (const tenant of tenantDirectory.tenants) {
      bosses.push(await runAsTenant(tenant, () => startScheduler(tenant)));
    }
  }

  // Email-OTP watcher: a no-op unless an ENABLED IMAP config is set (lazy import so the IMAP client isn't
  // loaded when unused). Polls the operator's inbox and relays OTP emails to awaiting sessions.
  const emailOtpWatchers: Array<{ stop: () => Promise<void> }> = [];
  if (!hostedCell) {
    const { startEmailOtpWatcher } = await import('./email-otp/watcher');
    const { db } = await import('./db/client');
    for (const tenant of tenantDirectory.tenants) {
      const watcher = await runAsTenant(
        tenant,
        () => startEmailOtpWatcher(db, {
          log: (m) => app.log.info({ tenantId: tenant.id }, m),
        }),
      );
      emailOtpWatchers.push(watcher);
    }
  }

  // Graceful shutdown. Docker/compose/orchestrators send SIGTERM (then SIGKILL after a grace period) on
  // stop, `compose down`, or a redeploy. Without handling it the process is killed mid-flight: in-flight
  // HTTP (e.g. a crawl-orchestration request) is cut off and pg-boss jobs are left 'active' until they
  // expire. So: stop accepting + drain in-flight HTTP (app.close), let pg-boss finish active jobs and
  // close its own pool (boss.stop graceful), then drain the app's Postgres pool (sql.end). Idempotent —
  // a second signal during shutdown is ignored.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received — shutting down gracefully`);
    // Bound the shutdown: if a drain hangs (a never-completing in-flight request, a stuck boss.stop), force
    // exit before the orchestrator's SIGKILL rather than hang. unref() so the timer never by itself keeps
    // the process alive once the clean path finishes. Compose sets stop_grace_period > this so the
    // orchestrator gives the watchdog room to run.
    const watchdog = setTimeout(() => {
      app.log.error('graceful shutdown exceeded 25s — forcing exit');
      process.exit(1);
    }, 25_000);
    watchdog.unref();
    try {
      if (hostedScheduleRepairTimer) clearInterval(hostedScheduleRepairTimer);
      await Promise.all(emailOtpWatchers.map((watcher) => watcher.stop()));
      await app.close();
      await Promise.all(bosses.map((boss) => boss.stop({ graceful: true, timeout: 15_000 })));
      const { closeDatabasePools } = await import('./db/client');
      await closeDatabasePools();
    } catch (err) {
      app.log.error({ err }, 'error during graceful shutdown');
    } finally {
      clearTimeout(watchdog);
      process.exit(0);
    }
  };
  // process.on (NOT once): the handler must stay registered so a repeated same-signal during the drain is
  // swallowed by the `shuttingDown` guard. With `once`, a second SIGTERM would hit Node's default handler
  // and kill the drain mid-flight.
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
