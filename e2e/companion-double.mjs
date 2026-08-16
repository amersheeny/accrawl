/**
 * Companion double — a Node stand-in for the phone's TunnelService.kt, speaking the SAME wire protocol.
 *
 * This is the device side of the device-proxy tunnel: in production the operator's Android companion
 * (companion/.../TunnelService.kt) is the EXIT node of a SOCKS5 bridge the engine runs, so the bank only
 * ever sees the phone's residential IP. This module replicates that phone EXACTLY — same poll, same WS,
 * same {connect|data|close}/{connected|data|close|error} JSON framing, same real-socket relay — so the
 * e2e can drive + assert the tunnel end to end without an emulator.
 *
 * It also serves as the EXECUTION ORACLE for the e2e: every (host,port) it opens and every byte it relays
 * each way is recorded, so the harness can prove the bank traffic demonstrably flowed THROUGH this double
 * (the phone) rather than direct from the engine.
 *
 * Wire protocol (byte-for-byte the engine's contract; see apps/engine/src/tunnel/tunnel-server.ts):
 *   engine → phone:  {type:'connect', connId, host, port}
 *                    {type:'data',    connId, data:<base64>}
 *                    {type:'close',   connId}
 *   phone → engine:  {type:'connected', connId}
 *                    {type:'data',      connId, data:<base64>}
 *                    {type:'close',     connId}
 *                    {type:'error',     connId, message}
 *
 * Token issuance is the REAL path: poll GET /api/sessions/awaiting-tunnel with an `acdv_` device token to
 * obtain {sessionId, tunnelToken, engineWsUrl} (the control-plane mints a fresh, session+device-bound HMAC
 * token per call), then present that tunnelToken as `Authorization: Bearer` when opening the WS. No shortcut.
 *
 * Host mapping: with a SOCKS5 proxy, Chrome performs REMOTE DNS — it sends the bank's hostname (not a
 * pre-resolved IP) to the proxy. The real phone resolves the bank's public hostname over its own network;
 * here the fake bank lives on loopback, so `hostMap` rewrites the bank host → 127.0.0.1 before the socket
 * connect. This is purely the double's DNS step standing in for the phone's; the engine/SOCKS5 path is
 * untouched and never learns the IP.
 */
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Resolve `ws` from the engine workspace (it depends on ws); fall back to Node 22's global WebSocket.
function loadWebSocket() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const base of [path.resolve(here, '../apps/engine'), path.resolve(here, '..')]) {
    try {
      const req = createRequire(path.join(base, 'package.json'));
      return req('ws').WebSocket;
    } catch { /* try next */ }
  }
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  throw new Error('No WebSocket implementation available (install `ws` or run on Node >= 22).');
}
const WebSocketImpl = loadWebSocket();

/**
 * Start a companion double.
 *
 * @param {object} opts
 * @param {string} opts.controlPlaneUrl  Base URL of the control-plane (e.g. http://127.0.0.1:4102).
 * @param {string} opts.deviceToken      An `acdv_` device token from POST /api/devices/pair.
 * @param {Record<string,string>} [opts.hostMap]  host → host rewrite applied before the socket connect
 *                                                 (stands in for the phone's DNS; e.g. bank host → 127.0.0.1).
 * @param {number} [opts.pollIntervalMs] Awaiting-tunnel poll cadence (default 1000; the phone uses 6000).
 * @param {(m:string)=>void} [opts.log]  Log sink (default console.log with a [companion-double] tag).
 * @returns {{ stop: ()=>Promise<void>, summary: ()=>object, waitForRelay: (ms?:number)=>Promise<boolean> }}
 */
export function startCompanionDouble(opts) {
  const {
    controlPlaneUrl,
    deviceToken,
    hostMap = {},
    pollIntervalMs = 1000,
    log = (m) => console.log('[companion-double]', m),
  } = opts;
  if (!controlPlaneUrl || !deviceToken) throw new Error('controlPlaneUrl and deviceToken are required');

  // ── Oracle state ────────────────────────────────────────────────────
  // Records the ground truth of what physically flowed through the double (the phone).
  const oracle = {
    polls: 0,                 // awaiting-tunnel polls issued
    tunnelsOpened: 0,         // WS tunnels opened to the engine
    connects: [],             // [{ connId, host, port, mappedHost, sessionId }] — every CONNECT the engine asked for
    bytesEngineToBank: 0,     // engine → phone → bank (base64-decoded payload written to the real socket)
    bytesBankToEngine: 0,     // bank → phone → engine (payload read off the real socket, relayed back)
    errors: [],               // [{ connId, host, port, message }]
    lastSessionId: null,
  };
  let relayResolvers = [];
  function notifyRelay() {
    if (oracle.bytesBankToEngine > 0 && oracle.bytesEngineToBank > 0) {
      for (const r of relayResolvers) r(true);
      relayResolvers = [];
    }
  }

  let running = true;
  let activeWs = null;
  const sockets = new Map();   // connId -> net.Socket
  let pollTimer = null;

  // ── Awaiting-tunnel poll (real token-issuance path) ─────────────────
  async function fetchAwaitingTunnel() {
    oracle.polls++;
    const r = await fetch(`${controlPlaneUrl.replace(/\/+$/, '')}/api/sessions/awaiting-tunnel`, {
      headers: { authorization: `Bearer ${deviceToken}`, accept: 'application/json' },
    });
    if (r.status === 401) { log('device token rejected (401) — re-pair this device'); return null; }
    if (!r.ok) throw new Error(`awaiting-tunnel HTTP ${r.status}`);
    const body = await r.json();
    return Array.isArray(body.sessions) ? body.sessions : [];
  }

  function pollLoop() {
    if (!running) return;
    const reschedule = () => { if (running) pollTimer = setTimeout(pollLoop, pollIntervalMs); };
    // Already holding a live tunnel? Leave it be until it closes (one tunnel at a time, like the phone).
    if (activeWs && activeWs.readyState === WebSocketImpl.OPEN) return reschedule();
    fetchAwaitingTunnel()
      .then((awaiting) => {
        if (awaiting && awaiting.length > 0 && !(activeWs && activeWs.readyState === WebSocketImpl.OPEN)) {
          openTunnel(awaiting[0]);
        }
      })
      .catch((e) => log(`tunnel poll failed: ${e.message}`))
      .finally(reschedule);
  }

  // ── One live tunnel (the phone side of the wire protocol) ───────────
  function openTunnel(s) {
    const sep = s.engineWsUrl.includes('?') ? '&' : '?';
    const wsUrl = `${s.engineWsUrl}${sep}sessionId=${encodeURIComponent(s.sessionId)}`;
    oracle.lastSessionId = s.sessionId;
    oracle.tunnelsOpened++;
    log(`opening tunnel for session ${s.sessionId} -> ${wsUrl}`);

    // Present the tunnel token as Authorization: Bearer (the engine accepts that or ?token=).
    const ws = new WebSocketImpl(wsUrl, { headers: { authorization: `Bearer ${s.tunnelToken}` } });
    activeWs = ws;

    const send = (msg) => { if (ws.readyState === WebSocketImpl.OPEN) ws.send(JSON.stringify(msg)); };

    ws.on('open', () => log(`tunnel up for session ${s.sessionId}`));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { log('invalid tunnel message'); return; }
      switch (msg.type) {
        case 'connect': onConnect(msg.connId, msg.host, msg.port, s.sessionId, send); break;
        case 'data':    onData(msg.connId, msg.data); break;
        case 'close':   onClose(msg.connId); break;
        default:        log(`unknown tunnel message type: ${msg.type}`);
      }
    });

    ws.on('close', () => {
      log(`tunnel closed for session ${s.sessionId}`);
      for (const [, sock] of sockets) { try { sock.destroy(); } catch { /* */ } }
      sockets.clear();
      if (activeWs === ws) activeWs = null;
    });
    ws.on('error', (err) => log(`tunnel ws error for session ${s.sessionId}: ${err.message}`));
  }

  // ── Engine → phone ──────────────────────────────────────────────────

  function onConnect(connId, host, port, sessionId, send) {
    const mappedHost = hostMap[host] ?? host;
    oracle.connects.push({ connId, host, port, mappedHost, sessionId });
    log(`CONNECT connId=${connId} -> ${host}:${port}${mappedHost !== host ? ` (resolved to ${mappedHost})` : ''}`);

    // Open the REAL TCP socket to the target — its local IP is THIS process (the phone stand-in). The
    // engine never opens this socket; the bank's bytes physically traverse the double.
    const socket = net.connect({ host: mappedHost, port }, () => {
      sockets.set(connId, socket);
      send({ type: 'connected', connId });
    });

    socket.on('data', (chunk) => {
      oracle.bytesBankToEngine += chunk.length;
      send({ type: 'data', connId, data: chunk.toString('base64') });
      notifyRelay();
    });

    socket.on('end', () => {
      if (sockets.delete(connId)) send({ type: 'close', connId }); // clean EOF → close the engine's half
    });

    socket.on('error', (err) => {
      if (sockets.delete(connId)) {
        oracle.errors.push({ connId, host, port, message: err.message });
        send({ type: 'error', connId, message: err.message });
      } else {
        // Connect itself failed before the socket was tracked.
        oracle.errors.push({ connId, host, port, message: err.message });
        send({ type: 'error', connId, message: err.message });
      }
    });

    socket.on('close', () => { sockets.delete(connId); });
  }

  function onData(connId, dataB64) {
    const socket = sockets.get(connId);
    if (!socket) return; // already closed
    const bytes = Buffer.from(dataB64, 'base64');
    oracle.bytesEngineToBank += bytes.length;
    socket.write(bytes);
    notifyRelay();
  }

  function onClose(connId) {
    const socket = sockets.get(connId);
    if (socket) { sockets.delete(connId); try { socket.end(); } catch { /* */ } }
  }

  // ── Public surface ──────────────────────────────────────────────────

  function summary() {
    const bankConnects = oracle.connects.filter((c) => c.port !== 0);
    return {
      polls: oracle.polls,
      tunnelsOpened: oracle.tunnelsOpened,
      connectCount: oracle.connects.length,
      connects: oracle.connects,
      distinctTargets: [...new Set(bankConnects.map((c) => `${c.host}:${c.port}`))],
      bytesEngineToBank: oracle.bytesEngineToBank,
      bytesBankToEngine: oracle.bytesBankToEngine,
      errors: oracle.errors,
      lastSessionId: oracle.lastSessionId,
    };
  }

  /** Resolve true once the double has carried bytes in BOTH directions (the bank traffic flowed through). */
  function waitForRelay(ms = 120000) {
    if (oracle.bytesBankToEngine > 0 && oracle.bytesEngineToBank > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      relayResolvers.push(resolve);
      setTimeout(() => resolve(oracle.bytesBankToEngine > 0 && oracle.bytesEngineToBank > 0), ms);
    });
  }

  async function stop() {
    running = false;
    if (pollTimer) clearTimeout(pollTimer);
    for (const [, sock] of sockets) { try { sock.destroy(); } catch { /* */ } }
    sockets.clear();
    if (activeWs) { try { activeWs.close(); } catch { /* */ } activeWs = null; }
  }

  pollLoop();
  return { stop, summary, waitForRelay };
}
