/**
 * Tests for the SOCKS5 CONNECT-only server.
 */

import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { createSocks5Server, type Socks5Server } from './socks5-server';

let server: Socks5Server | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

/** Helper: connect a raw TCP socket to the SOCKS5 server */
function connectToServer(port: number): Promise<net.Socket> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
  });
}

/** Helper: read the next chunk from a socket */
function readNext(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    socket.once('data', (data) => resolve(Buffer.from(data)));
  });
}

describe('createSocks5Server', () => {
  it('starts on a random localhost port', async () => {
    server = await createSocks5Server();
    expect(server.port).toBeGreaterThan(0);
  });

  it('accepts greeting and replies with no-auth', async () => {
    server = await createSocks5Server();
    server.onConnect(() => {});

    const socket = await connectToServer(server.port);
    // Send SOCKS5 greeting: version 5, 1 method, no-auth (0x00)
    socket.write(Buffer.from([0x05, 0x01, 0x00]));

    const reply = await readNext(socket);
    expect(reply[0]).toBe(0x05); // SOCKS5
    expect(reply[1]).toBe(0x00); // No-auth selected
    socket.destroy();
  });

  it('rejects non-SOCKS5 greeting', async () => {
    server = await createSocks5Server();
    server.onConnect(() => {});

    const socket = await connectToServer(server.port);
    const destroyed = new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
    });

    // Send SOCKS4 greeting
    socket.write(Buffer.from([0x04, 0x01, 0x00]));
    await destroyed;
    // Socket should be destroyed
    expect(socket.destroyed).toBe(true);
  });

  it('parses IPv4 CONNECT request', async () => {
    server = await createSocks5Server();

    const connected = new Promise<{ host: string; port: number; connId: number }>((resolve) => {
      server!.onConnect((conn) => {
        resolve({ host: conn.host, port: conn.port, connId: conn.connId });
        conn.socket.destroy();
      });
    });

    const socket = await connectToServer(server.port);

    // Greeting
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    await readNext(socket);

    // CONNECT to 93.184.216.34:443 (IPv4)
    socket.write(Buffer.from([
      0x05, 0x01, 0x00, 0x01, // ver, cmd=CONNECT, rsv, atyp=IPv4
      93, 184, 216, 34,       // IP address
      0x01, 0xBB,             // port 443
    ]));

    const result = await connected;
    expect(result.host).toBe('93.184.216.34');
    expect(result.port).toBe(443);
    expect(result.connId).toBe(1);
  });

  it('parses domain name CONNECT request', async () => {
    server = await createSocks5Server();

    const connected = new Promise<{ host: string; port: number }>((resolve) => {
      server!.onConnect((conn) => {
        resolve({ host: conn.host, port: conn.port });
        conn.socket.destroy();
      });
    });

    const socket = await connectToServer(server.port);

    // Greeting
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    await readNext(socket);

    // CONNECT to example.com:80 (domain name)
    const domain = Buffer.from('example.com', 'ascii');
    const request = Buffer.from([
      0x05, 0x01, 0x00, 0x03, // ver, cmd=CONNECT, rsv, atyp=domain
      domain.length,          // domain length
      ...domain,              // domain
      0x00, 0x50,             // port 80
    ]);
    socket.write(request);

    const result = await connected;
    expect(result.host).toBe('example.com');
    expect(result.port).toBe(80);
  });

  it('sends success reply via sendSuccess()', async () => {
    server = await createSocks5Server();

    server.onConnect((conn) => {
      conn.sendSuccess();
    });

    const socket = await connectToServer(server.port);

    // Greeting
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    await readNext(socket);

    // CONNECT to 1.2.3.4:8080
    socket.write(Buffer.from([
      0x05, 0x01, 0x00, 0x01,
      1, 2, 3, 4,
      0x1F, 0x90, // port 8080
    ]));

    const reply = await readNext(socket);
    expect(reply[0]).toBe(0x05); // version
    expect(reply[1]).toBe(0x00); // success
    socket.destroy();
  });

  it('sends failure reply via sendFailure()', async () => {
    server = await createSocks5Server();

    server.onConnect((conn) => {
      conn.sendFailure();
    });

    const socket = await connectToServer(server.port);

    // Greeting
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    await readNext(socket);

    // CONNECT to 1.2.3.4:80
    socket.write(Buffer.from([
      0x05, 0x01, 0x00, 0x01,
      1, 2, 3, 4,
      0x00, 0x50,
    ]));

    const reply = await readNext(socket);
    expect(reply[0]).toBe(0x05); // version
    expect(reply[1]).toBe(0x05); // connection refused
    // Socket should be destroyed after failure
  });

  it('rejects non-CONNECT commands', async () => {
    server = await createSocks5Server();
    server.onConnect(() => {});

    const socket = await connectToServer(server.port);

    // Greeting
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    await readNext(socket);

    // BIND command (0x02) instead of CONNECT (0x01)
    socket.write(Buffer.from([
      0x05, 0x02, 0x00, 0x01,
      1, 2, 3, 4,
      0x00, 0x50,
    ]));

    const reply = await readNext(socket);
    expect(reply[0]).toBe(0x05);
    expect(reply[1]).toBe(0x07); // command not supported
  });

  it('assigns incrementing connIds', async () => {
    server = await createSocks5Server();

    const connIds: number[] = [];
    server.onConnect((conn) => {
      connIds.push(conn.connId);
      conn.sendSuccess();
    });

    // Make two connections
    for (let i = 0; i < 2; i++) {
      const socket = await connectToServer(server.port);
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
      await readNext(socket);
      socket.write(Buffer.from([
        0x05, 0x01, 0x00, 0x01,
        1, 2, 3, 4,
        0x00, 0x50,
      ]));
      await readNext(socket);
      socket.destroy();
    }

    // Wait for both to be processed
    await new Promise((r) => setTimeout(r, 50));
    expect(connIds).toEqual([1, 2]);
  });

  it('rejects CONNECT when no onConnect handler is registered', async () => {
    server = await createSocks5Server();
    // Deliberately NOT calling server.onConnect()

    const socket = await connectToServer(server.port);

    // Greeting
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    await readNext(socket);

    // CONNECT
    socket.write(Buffer.from([
      0x05, 0x01, 0x00, 0x01,
      1, 2, 3, 4,
      0x00, 0x50,
    ]));

    const reply = await readNext(socket);
    expect(reply[0]).toBe(0x05);
    expect(reply[1]).toBe(0x01); // general SOCKS server failure
  });

  it('close() does not hang on a client stalled mid-handshake (pre-CONNECT)', async () => {
    // A client that connects but never sends the CONNECT request must NOT keep server.close() pending
    // forever: every accepted socket is tracked and destroyed by close(), not just post-CONNECT ones.
    const s = await createSocks5Server();
    server = s;

    // Connect, complete only the greeting, then stall (never send the CONNECT request).
    const socket = await connectToServer(s.port);
    socket.write(Buffer.from([0x05, 0x01, 0x00])); // greeting only
    await readNext(socket); // server's no-auth reply — we are now mid-handshake, pre-CONNECT

    // The server destroying its end will close the client's socket too — observe that as proof the
    // pre-CONNECT socket was actually torn down (not just left dangling).
    const clientClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));

    // close() must resolve promptly (the stalled client is destroyed), well under the handshake timeout.
    const closed = s.close();
    const won = await Promise.race([
      closed.then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    expect(won).toBe('closed');
    server = null; // already closed

    // The pre-CONNECT client socket gets closed by the server's destroy (it would otherwise linger).
    const clientWon = await Promise.race([
      clientClosed.then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    expect(clientWon).toBe('closed');
  });

  it('parses a CONNECT request delivered in TWO fragments (split mid-address) without crashing', async () => {
    // TCP gives no message framing: a real Chrome CONNECT can arrive split across multiple 'data' chunks
    // (e.g. the address byte-range straddles two segments). Pre-fix, the parser ran on whatever single chunk
    // arrived and readUInt16BE/the address slice threw RangeError on the partial — crashing out of the 'data'
    // handler. Post-fix, a partial request is buffered until COMPLETE, then parsed. Prove a request split
    // mid-domain-address reassembles to the exact host/port and connects.
    server = await createSocks5Server();
    const connected = new Promise<{ host: string; port: number }>((resolve) => {
      server!.onConnect((conn) => {
        resolve({ host: conn.host, port: conn.port });
        conn.sendSuccess();
      });
    });

    const socket = await connectToServer(server.port);
    socket.write(Buffer.from([0x05, 0x01, 0x00])); // greeting
    await readNext(socket); // no-auth reply

    // CONNECT to example.com:443 (domain), fragmented mid-address across two writes with a delay between,
    // so the server genuinely sees two separate 'data' events with an incomplete request in the first.
    const domain = Buffer.from('example.com', 'ascii');
    const fullReq = Buffer.from([
      0x05, 0x01, 0x00, 0x03, // ver, CONNECT, rsv, atyp=domain
      domain.length,
      ...domain,
      0x01, 0xBB, // port 443
    ]);
    // Split partway THROUGH the domain bytes so neither fragment is a complete request on its own.
    const splitAt = 4 + 1 + 4; // header(4) + len(1) + first 4 domain bytes — mid-address
    socket.write(fullReq.subarray(0, splitAt));
    await new Promise((r) => setTimeout(r, 30)); // ensure two distinct 'data' events
    socket.write(fullReq.subarray(splitAt));

    const result = await connected; // must NOT have thrown on the partial fragment
    expect(result.host).toBe('example.com');
    expect(result.port).toBe(443);

    // Server replied success — the fragmented request was parsed correctly end to end.
    const reply = await readNext(socket);
    expect(reply[0]).toBe(0x05);
    expect(reply[1]).toBe(0x00);
    socket.destroy();
  });

  it('parses a CONNECT request delivered ONE BYTE AT A TIME (maximally fragmented)', async () => {
    // The extreme of fragmentation: every byte in its own 'data' event. Each multi-byte read must be guarded
    // so no partial read ever throws; the request is parsed only once fully buffered.
    server = await createSocks5Server();
    const connected = new Promise<{ host: string; port: number }>((resolve) => {
      server!.onConnect((conn) => {
        resolve({ host: conn.host, port: conn.port });
        conn.sendSuccess();
      });
    });

    const socket = await connectToServer(server.port);
    // Greeting byte-by-byte too.
    for (const b of [0x05, 0x01, 0x00]) {
      socket.write(Buffer.from([b]));
      await new Promise((r) => setTimeout(r, 2));
    }
    await readNext(socket); // no-auth reply

    // CONNECT to 93.184.216.34:443 (IPv4), one byte per write.
    const req = [0x05, 0x01, 0x00, 0x01, 93, 184, 216, 34, 0x01, 0xBB];
    for (const b of req) {
      socket.write(Buffer.from([b]));
      await new Promise((r) => setTimeout(r, 2));
    }

    const result = await connected;
    expect(result.host).toBe('93.184.216.34');
    expect(result.port).toBe(443);
    socket.destroy();
  });

  it('destroys the socket (without throwing) on an over-short request followed by EOF', async () => {
    // A genuinely malformed/truncated request that then EOFs must NEVER throw out of the 'data' handler, and
    // the socket must end up destroyed/closed (here: the client half-closes, so the connection tears down).
    // Pre-fix, parsing the over-short chunk threw RangeError; post-fix the partial is buffered (awaiting the
    // rest), and the client's EOF simply closes the socket — no throw, no force-reply on garbage.
    server = await createSocks5Server();
    // If the 'data' handler ever threw out of itself, it would surface as an uncaughtException (the handler is
    // sync) — capture it as a definitive "the parser threw" signal. (vitest also fails the run on an uncaught
    // throw, so a regression can't pass silently; this assertion just localizes the failure.)
    let threwInHandler = false;
    const onUncaught = (): void => { threwInHandler = true; };
    process.on('uncaughtException', onUncaught);

    let onConnectFired = false;
    server.onConnect(() => { onConnectFired = true; }); // must NOT fire for a truncated request

    const socket = await connectToServer(server.port);
    socket.write(Buffer.from([0x05, 0x01, 0x00])); // valid greeting
    await readNext(socket); // no-auth reply

    const clientClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    // An over-short request: header says domain atyp but the address/port are missing — incomplete.
    socket.write(Buffer.from([0x05, 0x01, 0x00, 0x03, 0x0a])); // claims a 10-byte domain, sends none of it
    await new Promise((r) => setTimeout(r, 30)); // server buffers it, awaiting the rest (no throw)
    socket.destroy(); // client EOF / abort before completing the request

    await clientClosed;
    // Give any erroneously-thrown async exception a tick to surface.
    await new Promise((r) => setTimeout(r, 30));
    process.removeListener('uncaughtException', onUncaught);

    expect(threwInHandler).toBe(false); // the partial read never threw out of the 'data' handler
    expect(onConnectFired).toBe(false); // a truncated request is never parsed into a connection
    expect(socket.destroyed).toBe(true);
  });
});
