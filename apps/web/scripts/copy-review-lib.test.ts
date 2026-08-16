import { describe, expect, it } from 'vitest';
import {
  copyHash,
  directFlutterCopyLiterals,
  extractDartCopyConstants,
  extractKotlinCopyConstants,
  extractUserVisibleCopy,
  packCopy,
  unreviewedCopy,
} from './copy-review-lib';

describe('Android companion copy extraction', () => {
  it('extracts adjacent and escaped Dart static string constants', () => {
    expect(extractDartCopyConstants(`
      static const title = 'Phone';
      static const detail =
          "Use the phone's lock. "
          'Try again.';
    `)).toEqual({
      title: 'Phone',
      detail: "Use the phone's lock. Try again.",
    });
  });

  it('extracts native Kotlin notification copy constants', () => {
    expect(extractKotlinCopyConstants(`
      const val TITLE = "Watching for a code"
      const val BODY =
          "The bank's message will be relayed."
    `)).toEqual({
      TITLE: 'Watching for a code',
      BODY: "The bank's message will be relayed.",
    });
  });

  it('finds direct rendered Flutter strings but ignores punctuation-only masks', () => {
    expect(directFlutterCopyLiterals(`
      const Text('Unreviewed');
      const Text('••••');
      Text('\${account.connectionLabel}');
      Text('\${transaction.accountLabel} · \${date}');
      Text('Account \${account.name}');
      const InputDecoration(labelText: "Address");
      Text(CompanionCopy.title);
    `)).toEqual(['Unreviewed', 'Account', 'Address']);
  });
});

describe('user-visible copy review gate', () => {
  it('rejects new JSX and API error literals until their exact text hash is reviewed', () => {
    const jsxCopy = extractUserVisibleCopy(
      `export const View = ({ busy, name }) => <>
        <button>{busy ? 'Stopping transfer' : 'Launch hosted crawl'}</button>
        <p>{\`Could not delete \${name}\`}</p>
      </>;`,
      'view.tsx',
    );
    const apiCopy = extractUserVisibleCopy(
      `reply.code(409).send({ error: 'A hosted crawl is still stopping.' });
       const error = 'No paired phone is authorized for this connection.';
       const technicalReason = 'not-user-copy';
       confirm('Delete this connection?');`,
      'route.ts',
    );
    const values = [...jsxCopy, ...apiCopy];

    expect(unreviewedCopy(values, new Map(), new Map())).toEqual([
      {
        count: 1,
        sha256: copyHash('A hosted crawl is still stopping.'),
        text: 'A hosted crawl is still stopping.',
      },
      {
        count: 1,
        sha256: copyHash('Could not delete ${…}'),
        text: 'Could not delete ${…}',
      },
      {
        count: 1,
        sha256: copyHash('Delete this connection?'),
        text: 'Delete this connection?',
      },
      {
        count: 1,
        sha256: copyHash('Launch hosted crawl'),
        text: 'Launch hosted crawl',
      },
      {
        count: 1,
        sha256: copyHash('No paired phone is authorized for this connection.'),
        text: 'No paired phone is authorized for this connection.',
      },
      {
        count: 1,
        sha256: copyHash('Stopping transfer'),
        text: 'Stopping transfer',
      },
    ]);
    expect(unreviewedCopy(
      values,
      new Map(),
      new Map(values.map((value) => [copyHash(value), 1])),
    )).toEqual([]);
  });

  it('rejects reusing baseline text in a new route occurrence', () => {
    const text = 'A crawl is already running for this connection.';
    const values = extractUserVisibleCopy(
      `const first = () => reply.code(409).send({ error: '${text}' });
       const second = () => reply.code(409).send({ error: '${text}' });`,
      'connections.ts',
    );

    expect(unreviewedCopy(
      values,
      new Map([[copyHash(text), 1]]),
      new Map(),
    )).toEqual([{
      count: 1,
      sha256: copyHash(text),
      text,
    }]);
  });

  it('packs duplicate occurrences deterministically without collapsing them', () => {
    expect(packCopy(['Beta', 'Alpha', 'Alpha'])).toBe(
      packCopy(['Alpha', 'Beta', 'Alpha']),
    );
    expect(Buffer.from(packCopy(['Alpha', 'Alpha']), 'base64')).toHaveLength(64);
    expect(packCopy(['Alpha'])).not.toBe(packCopy(['Alpha', 'Alpha']));
  });

  it('reviews visible JSX attributes without treating technical attributes as copy', () => {
    expect(extractUserVisibleCopy(
      '<button className="danger small" aria-label="Revoke access" type="button" />',
      'view.tsx',
    )).toEqual(['Revoke access']);
    expect(extractUserVisibleCopy(
      '<button className="danger small" aria-label="Revoke access" />',
      'view.tsx',
      { legacyAllJsxAttributes: true },
    )).toEqual(['danger small', 'Revoke access']);
  });

  it('reviews persisted session copy and named error bindings', () => {
    expect(extractUserVisibleCopy(
      `const earlyError = 'This refresh cannot start.';
       const technicalReason = 'not-user-copy';
       tx.update(sessionRef, {
         currentStep: 'Waiting for Accrawl Companion.',
         lastError: 'This refresh failed.',
       });
       tx.update(connectionRef, {
         safeErrorMessage: 'Reconnect this connection.',
       });`,
      'hosted-storage.ts',
    )).toEqual([
      'This refresh cannot start.',
      'Waiting for Accrawl Companion.',
      'This refresh failed.',
      'Reconnect this connection.',
    ]);
  });
});
