/**
 * Write-gate tests.
 *
 * The gate replaces a phrase denylist that could not work at any list size, so these tests are
 * written against the PROPERTY that replaced it: every path that is not an explicit allow denies,
 * and the decision never depends on a word, a language, or a visible label.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  WriteGate,
  isNonIdempotent,
  isOperationHint,
  bodyParameters,
  queryParameters,
  mergeParameters,
  type RequestVerdict,
  type VettableRequest,
} from './write-gate';

const silent = { log: () => {}, warn: () => {}, error: () => {} } as unknown as Parameters<typeof WriteGate.prototype.constructor>[0]['logger'];

function req(over: Partial<VettableRequest> = {}): VettableRequest {
  return {
    method: 'POST',
    safeUrl: 'https://bank.example/accounts/list',
    parameterNames: ['accountId', 'fromDate'],
    operationHints: [],
    ...over,
  };
}

function gate(vet?: (r: VettableRequest) => Promise<RequestVerdict>, vetTimeoutMs?: number): WriteGate {
  return new WriteGate({ vet, vetTimeoutMs, logger: silent });
}

describe('isNonIdempotent', () => {
  it('treats the state-changing methods as non-idempotent, case-insensitively', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'Delete']) {
      expect(isNonIdempotent(m)).toBe(true);
    }
  });

  it('treats the read methods as idempotent', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(isNonIdempotent(m)).toBe(false);
    }
  });
});

describe('WriteGate phase behaviour', () => {
  it('always allows read methods, in either phase', async () => {
    const g = gate();
    for (const phase of ['login', 'extract'] as const) {
      g.setPhase(phase);
      const d = await g.evaluate(req({ method: 'GET' }));
      expect(d.allowed).toBe(true);
    }
  });

  it('allows a state-changing request during authentication — the login POST must work', async () => {
    const g = gate();
    expect(g.phase).toBe('login');
    const d = await g.evaluate(req({ safeUrl: 'https://bank.example/login', parameterNames: ['user', 'pass'] }));
    expect(d.allowed).toBe(true);
    expect(d.reason).toContain('authentication');
  });

  it('DENIES a state-changing request after login when no vet is configured', async () => {
    const g = gate();
    g.setPhase('extract');
    const d = await g.evaluate(req());
    expect(d.allowed).toBe(false);
  });

  it('reopens the write window on re-authentication and closes it again', async () => {
    const g = gate();
    g.setPhase('extract');
    expect((await g.evaluate(req())).allowed).toBe(false);
    g.setPhase('login');
    expect((await g.evaluate(req())).allowed).toBe(true);
    g.setPhase('extract');
    expect((await g.evaluate(req())).allowed).toBe(false);
  });

  it('blocks a transfer regardless of the language or script of the originating button', async () => {
    // The whole point of moving off labels: the gate never sees one. Same request, same outcome.
    const g = gate(async () => 'write');
    g.setPhase('extract');
    const d = await g.evaluate(req({
      safeUrl: 'https://bank.example/payments/transfer/execute',
      parameterNames: ['fromAccount', 'toAccount', 'amount'],
    }));
    expect(d.allowed).toBe(false);
  });
});

describe('WriteGate vet handling — every non-allow path denies', () => {
  it('allows when the vet classifies the request as a read', async () => {
    const g = gate(async () => 'read');
    g.setPhase('extract');
    expect((await g.evaluate(req())).allowed).toBe(true);
  });

  it('denies when the vet classifies the request as a write', async () => {
    const g = gate(async () => 'write');
    g.setPhase('extract');
    expect((await g.evaluate(req())).allowed).toBe(false);
  });

  it('denies when the vet throws', async () => {
    const g = gate(async () => { throw new Error('model unavailable'); });
    g.setPhase('extract');
    expect((await g.evaluate(req())).allowed).toBe(false);
  });

  it('denies when the vet times out rather than hanging the crawl', async () => {
    const g = gate(() => new Promise<RequestVerdict>(() => { /* never settles */ }), 20);
    g.setPhase('extract');
    const d = await g.evaluate(req());
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('verdict');
  });

  it('denies when the vet returns an unrecognised verdict', async () => {
    const g = gate(async () => 'maybe' as unknown as RequestVerdict);
    g.setPhase('extract');
    expect((await g.evaluate(req())).allowed).toBe(false);
  });

  it('does not let a rejected vet poison the cache — a later good verdict is still consulted', async () => {
    const vet = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('read' as RequestVerdict);
    const g = gate(vet);
    g.setPhase('extract');
    expect((await g.evaluate(req())).allowed).toBe(false);
    expect((await g.evaluate(req())).allowed).toBe(true);
    expect(vet).toHaveBeenCalledTimes(2);
  });
});

describe('WriteGate verdict cache', () => {
  it('vets a repeated postback once — the cost is per endpoint, not per interaction', async () => {
    const vet = vi.fn().mockResolvedValue('read' as RequestVerdict);
    const g = gate(vet);
    g.setPhase('extract');
    for (let i = 0; i < 12; i++) {
      expect((await g.evaluate(req())).allowed).toBe(true);
    }
    expect(vet).toHaveBeenCalledTimes(1);
  });

  it('keeps a write verdict denied on every repeat', async () => {
    const vet = vi.fn().mockResolvedValue('write' as RequestVerdict);
    const g = gate(vet);
    g.setPhase('extract');
    expect((await g.evaluate(req())).allowed).toBe(false);
    expect((await g.evaluate(req())).allowed).toBe(false);
    expect(vet).toHaveBeenCalledTimes(1);
  });

  it('does NOT let a transfer inherit a listing\'s read verdict on the same endpoint (cache bypass)', async () => {
    // A portal that carries its operation in a value posts to ONE path. Keying the cache on the
    // endpoint alone would approve the transfer using the verdict earned by the listing.
    const vet = vi.fn(async (r: VettableRequest) =>
      (r.operationHints.includes('btnTransfer') ? 'write' : 'read') as RequestVerdict);
    const g = gate(vet);
    g.setPhase('extract');

    const path = 'https://bank.example/Accounts.aspx';
    const names = ['__VIEWSTATE', '__EVENTTARGET'];
    const listing = await g.evaluate(req({ safeUrl: path, parameterNames: names, operationHints: ['btnNextPage'] }));
    const transfer = await g.evaluate(req({ safeUrl: path, parameterNames: names, operationHints: ['btnTransfer'] }));

    expect(listing.allowed).toBe(true);
    expect(transfer.allowed).toBe(false);
    expect(vet).toHaveBeenCalledTimes(2);
  });

  it('does not confuse two endpoints that differ only in path', async () => {
    const vet = vi.fn(async (r: VettableRequest) =>
      (r.safeUrl.includes('transfer') ? 'write' : 'read') as RequestVerdict);
    const g = gate(vet);
    g.setPhase('extract');
    expect((await g.evaluate(req({ safeUrl: 'https://bank.example/tx/list' }))).allowed).toBe(true);
    expect((await g.evaluate(req({ safeUrl: 'https://bank.example/tx/transfer' }))).allowed).toBe(false);
  });
});

describe('operation hints never carry user data', () => {
  it('admits identifier-shaped values', () => {
    for (const v of ['transfer', 'btnConfirm', 'ctl00$btnTransfer', 'list.page', 'a:b-c']) {
      expect(isOperationHint(v)).toBe(true);
    }
  });

  it('rejects every all-numeric value, so account numbers, PINs and OTPs cannot leak', () => {
    for (const v of ['123456', '0012345678', '4242424242424242', '99022330', '1', '2729.29']) {
      expect(isOperationHint(v)).toBe(false);
    }
  });

  it('rejects long blobs — view state, tokens, JWTs', () => {
    expect(isOperationHint('A'.repeat(65))).toBe(false);
    expect(isOperationHint('/wEPDwUKMTU5Mjc' + 'x'.repeat(200))).toBe(false);
    expect(isOperationHint('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc')).toBe(false);
  });

  it('rejects values with spaces or punctuation that are not identifiers', () => {
    for (const v of ['John Smith', 'GB29 NWBK 6016', 'a@b.com', '', '  ']) {
      expect(isOperationHint(v)).toBe(false);
    }
  });
});

describe('parameter extraction', () => {
  it('reads names and hints from a form-urlencoded body, never the free-form values', () => {
    const p = bodyParameters(
      'application/x-www-form-urlencoded',
      '__EVENTTARGET=ctl00%24btnTransfer&amount=2729.29&beneficiary=John+Smith',
    );
    expect(p.names).toEqual(['__EVENTTARGET', 'amount', 'beneficiary']);
    expect(p.hints).toEqual(['ctl00$btnTransfer']);
    expect(p.hints.join(' ')).not.toContain('2729');
    expect(p.hints.join(' ')).not.toContain('John');
  });

  it('reads nested names and hints from a JSON body', () => {
    const p = bodyParameters('application/json', JSON.stringify({
      operation: 'listTransactions',
      filter: { accountId: '0012345678', from: '2026-01-01' },
    }));
    expect(p.names).toEqual(expect.arrayContaining(['operation', 'filter', 'accountId', 'from']));
    expect(p.hints).toContain('listTransactions');
    expect(p.hints).not.toContain('0012345678');
  });

  it('reads names from a multipart body without taking any value', () => {
    const body = '--x\r\nContent-Disposition: form-data; name="statementId"\r\n\r\n9912\r\n--x--';
    const p = bodyParameters('multipart/form-data; boundary=x', body);
    expect(p.names).toEqual(['statementId']);
    expect(p.hints).toEqual([]);
  });

  it('yields nothing for an absent or unparseable body rather than throwing', () => {
    expect(bodyParameters('application/json', null)).toEqual({ names: [], hints: [] });
    expect(bodyParameters('application/json', '{not json')).toEqual({ names: [], hints: [] });
    expect(bodyParameters(undefined, '')).toEqual({ names: [], hints: [] });
  });

  it('caps a hostile body so it cannot inflate the vet call', () => {
    const body = Array.from({ length: 500 }, (_, i) => `field${i}=v`).join('&');
    expect(bodyParameters('application/x-www-form-urlencoded', body).names).toHaveLength(40);
    const long = `${'n'.repeat(300)}=v`;
    expect(bodyParameters('application/x-www-form-urlencoded', long).names[0]).toHaveLength(60);
  });

  it('reads query parameter names and hints', () => {
    const p = queryParameters('https://bank.example/do?action=transfer&acct=0012345678');
    expect(p.names).toEqual(['action', 'acct']);
    expect(p.hints).toEqual(['transfer']);
  });

  it('yields nothing for a malformed URL', () => {
    expect(queryParameters('::::')).toEqual({ names: [], hints: [] });
  });

  it('merges and deduplicates', () => {
    const merged = mergeParameters(
      { names: ['a', 'b'], hints: ['x'] },
      { names: ['b', 'c'], hints: ['x', 'y'] },
    );
    expect(merged.names).toEqual(['a', 'b', 'c']);
    expect(merged.hints).toEqual(['x', 'y']);
  });
});
