/**
 * Minimal SOCKS5 Server (CONNECT-only, no-auth, localhost-only)
 *
 * Implements just enough of RFC 1928 for Playwright's proxy support:
 * - Greeting: no-auth method only
 * - Command: CONNECT only (TCP proxy)
 * - Address types: IPv4, domain name, IPv6
 *
 * Each accepted CONNECT emits a callback with the target host/port
 * and the client socket. The caller is responsible for bridging the
 * socket to the actual destination (via WebSocket tunnel to APK).
 */

import net from 'net';

export interface Socks5Connection {
  connId: number;
  host: string;
  port: number;
  /** The SOCKS5 client socket (Playwright side). Caller pipes data to/from this. */
  socket: net.Socket;
  /** Call this after the remote end connects to send SOCKS5 success reply. */
  sendSuccess: () => void;
  /** Call this if the remote connection fails to send SOCKS5 failure reply. */
  sendFailure: () => void;
}

export type OnConnectCallback = (conn: Socks5Connection) => void;

export interface Socks5Server {
  /** Localhost port the SOCKS5 server is listening on */
  port: number;
  /** Register a callback for new CONNECT requests */
  onConnect: (cb: OnConnectCallback) => void;
  /** Shut down the server */
  close: () => Promise<void>;
}

/**
 * Max time a freshly-accepted client socket may take to finish the SOCKS5 handshake (greeting + CONNECT
 * request) before we destroy it. Without this, a client that connects and stalls pre-CONNECT (never
 * sending the request) keeps the socket — and thus a pending close() — alive forever. Cleared the moment
 * the CONNECT callback fires (the socket is then owned by the bridge for the connection's full lifetime).
 */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Create a SOCKS5 server on a random localhost port.
 * Returns the port and a way to handle incoming CONNECT requests.
 */
export function createSocks5Server(): Promise<Socks5Server> {
  return new Promise((resolve, reject) => {
    let nextConnId = 1;
    let connectCallback: OnConnectCallback | null = null;

    // Track EVERY accepted socket (not just post-CONNECT ones) so close() can destroy clients that are
    // still mid-handshake. A pre-CONNECT socket is otherwise invisible to teardown and hangs server.close()
    // until the OS closes it. Added on 'connection', removed on the socket's own 'close'.
    const sockets = new Set<net.Socket>();

    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      handleClient(socket);
    });

    function handleClient(socket: net.Socket) {
      let phase: 'greeting' | 'request' | 'done' = 'greeting';

      // Per-socket accumulation buffer. SOCKS5 spans two short messages (greeting, then the CONNECT
      // request), and TCP gives no message framing — a 'data' chunk may carry a partial greeting/request,
      // both pipelined together, or split a single request mid-address (real Chrome CONNECTs fragment).
      // We append every chunk here and only parse once a COMPLETE message is present; a partial read waits
      // for more bytes rather than being misread as malformed (the bug: readUInt16BE / addr slices threw
      // RangeError on a short chunk, crashing out of the 'data' handler).
      let buf: Buffer = Buffer.alloc(0);

      // Destroy a socket that connects but never completes CONNECT (stalled handshake). The timer is
      // cleared the moment the CONNECT request arrives (below), so if it ever fires the handshake never
      // finished and the socket is safe to drop.
      const handshakeTimer = setTimeout(() => {
        if (!socket.destroyed) socket.destroy();
      }, HANDSHAKE_TIMEOUT_MS);
      if (typeof handshakeTimer.unref === 'function') handshakeTimer.unref();
      socket.once('close', () => clearTimeout(handshakeTimer));

      socket.on('data', (chunk: Buffer) => {
        // The WHOLE handshake parse is wrapped: a genuinely malformed request must DESTROY the socket, never
        // throw out of the 'data' handler (an uncaught throw here is unhandled). Partial reads are handled
        // by the length guards below (they `return` to await more bytes) — only a real protocol violation or
        // an unexpected error reaches the catch.
        try {
          if (phase === 'done') return;
          buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

          // ── Greeting: version(1) + nmethods(1) + methods(nmethods) ──
          if (phase === 'greeting') {
            if (buf.length < 2) return; // need ver + nmethods before we can size the methods list
            if (buf[0] !== 0x05) {
              socket.destroy(); // not SOCKS5
              return;
            }
            const nmethods = buf[1];
            const greetingLen = 2 + nmethods;
            if (buf.length < greetingLen) return; // methods list not fully arrived yet
            // Consume exactly the greeting; any trailing bytes belong to a pipelined request.
            buf = buf.subarray(greetingLen);
            // Reply: version 5, no-auth method (0x00)
            socket.write(Buffer.from([0x05, 0x00]));
            phase = 'request';
            // Fall through: a pipelined request may already be buffered.
          }

          if (phase === 'request') {
            if (!tryHandleRequest()) return; // not enough bytes yet — wait for more
          }
        } catch (err) {
          // A genuine protocol error (or any unexpected throw) — destroy the socket; never let it escape.
          if (!socket.destroyed) socket.destroy();
          void err;
        }
      });

      socket.on('error', () => {
        // Client disconnected before completing handshake — ignore
      });

      /**
       * Parse the buffered CONNECT request once it is COMPLETE. Returns true when the request was handled
       * (or definitively rejected), false when more bytes are still needed (caller waits for the next chunk).
       * SOCKS5 request: ver(1) + cmd(1) + rsv(1) + atyp(1) + addr(var) + port(2). Every multi-byte read is
       * preceded by a length guard so a fragmented request is buffered, never parsed as malformed.
       */
      function tryHandleRequest(): boolean {
        // Need at least ver + cmd + rsv + atyp before we can size the address.
        if (buf.length < 4) return false;
        if (buf[0] !== 0x05 || buf[1] !== 0x01) {
          // Only CONNECT (0x01) is supported. Reply with command not supported (0x07), then destroy.
          phase = 'done';
          socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.destroy();
          return true;
        }

        const atyp = buf[3];
        // Compute the full request length per ATYP: 4 (header) + addrLen + 2 (port). For a domain we must
        // first have the 1-byte length prefix (byte 4) to know addrLen.
        let addrLen: number;
        if (atyp === 0x01) {
          addrLen = 4; // IPv4
        } else if (atyp === 0x04) {
          addrLen = 16; // IPv6
        } else if (atyp === 0x03) {
          if (buf.length < 5) return false; // need the domain-length byte first
          addrLen = 1 + buf[4]; // length prefix + domain
        } else {
          // Unsupported address type (0x08)
          phase = 'done';
          socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.destroy();
          return true;
        }

        const requestLen = 4 + addrLen + 2;
        if (buf.length < requestLen) return false; // address/port not fully arrived yet — wait for more

        // The request is now COMPLETE — committing to parse it. CONNECT received: the bridge owns the
        // socket's lifetime from here, so clear the handshake timer.
        phase = 'done';
        clearTimeout(handshakeTimer);

        let host: string;
        if (atyp === 0x01) {
          host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        } else if (atyp === 0x03) {
          host = buf.subarray(5, 5 + buf[4]).toString('ascii');
        } else {
          // IPv6: 16 bytes
          const parts: string[] = [];
          for (let i = 0; i < 16; i += 2) {
            parts.push(buf.readUInt16BE(4 + i).toString(16));
          }
          host = parts.join(':');
        }
        const port = buf.readUInt16BE(4 + addrLen);
        handleRequest(socket, host, port);
        return true;
      }
    }

    function handleRequest(socket: net.Socket, host: string, port: number) {
      const connId = nextConnId++;

      if (!connectCallback) {
        // No handler registered — reject
        socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.destroy();
        return;
      }

      connectCallback({
        connId,
        host,
        port,
        socket,
        sendSuccess: () => {
          // SOCKS5 success reply: ver=5, rep=0 (success), rsv=0, atyp=1 (IPv4), addr=0.0.0.0, port=0
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        },
        sendFailure: () => {
          // SOCKS5 failure reply: ver=5, rep=5 (connection refused), rsv=0, atyp=1, addr=0.0.0.0, port=0
          socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.destroy();
        },
      });
    }

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }

      resolve({
        port: addr.port,
        onConnect: (cb: OnConnectCallback) => {
          connectCallback = cb;
        },
        close: () =>
          new Promise<void>((res) => {
            // Destroy every tracked client socket FIRST — including any still mid-handshake (pre-CONNECT).
            // server.close() stops accepting new connections but waits for existing ones to end; a stalled
            // client would otherwise keep it pending forever. Destroying them lets close()'s callback fire.
            for (const socket of sockets) {
              try {
                socket.destroy();
              } catch {
                // already gone — ignore
              }
            }
            sockets.clear();
            server.close(() => res());
          }),
      });
    });
  });
}
