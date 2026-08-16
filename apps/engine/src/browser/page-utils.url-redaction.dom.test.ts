// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';

let getPageContent: typeof import('./page-utils').getPageContent;

beforeAll(async () => {
  ({ getPageContent } = await import('./page-utils'));
});

function jsdomPage(): Page {
  const evaluate = async (js: string) => {
    // Execute the exact browser-context clone/sanitizer shipped in production.
    // eslint-disable-next-line no-eval
    const indirectEval = eval;
    return indirectEval(js);
  };
  const mainFrame = { evaluate };
  return {
    evaluate,
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
    url: () => document.location.href,
  } as unknown as Page;
}

describe('captured HTML browser URL boundary', () => {
  it('removes credentials, query, and fragments from URL attributes and text without mutating the live page', async () => {
    const hrefSecret = 'href-query-secret';
    const formSecret = 'form-fragment-secret';
    const dataSecret = 'data-redirect-secret';
    const styleSecret = 'style-query-secret';
    const textSecret = 'text-fragment-secret';
    const relativeTextSecret = 'relative-text-query-secret';
    const refreshSecret = 'refresh-query-secret';
    const sourceSetSecret = 'source-set-data-secret';
    const arbitraryAttributeSecret = 'arbitrary-attribute-secret';

    document.head.innerHTML = '<base href="https://bank.example/current">';
    document.body.innerHTML = `
      <a id="oauth" href="/callback?code=${hrefSecret}#state=hidden">Continue</a>
      <form id="login" action="https://user:password@bank.example/submit#token=${formSecret}"></form>
      <div id="redirect" data-redirect-url="/return?token=${dataSecret}"></div>
      <div id="note" data-note="/note?token=${arbitraryAttributeSecret}"></div>
      <div id="styled" style="background-image:url('https://cdn.example/image.png?sig=${styleSecret}')"></div>
      <p>Socket moved to wss://stream.bank.example/live#token=${textSecret}</p>
      <p>Continue at /relative?code=${relativeTextSecret}#state=hidden</p>
      <meta http-equiv="refresh" content="0; /refreshed?code=${refreshSecret}#state=hidden">
      <img srcset="https://cdn.example/image.png?sig=hidden 1x, data:text/plain,${sourceSetSecret}">
    `;

    const liveHref = document.getElementById('oauth')?.getAttribute('href');
    const liveAction = document.getElementById('login')?.getAttribute('action');
    const html = await getPageContent(jsdomPage());

    for (const secret of [
      hrefSecret,
      formSecret,
      dataSecret,
      styleSecret,
      textSecret,
      relativeTextSecret,
      refreshSecret,
      sourceSetSecret,
      arbitraryAttributeSecret,
      'password',
    ]) {
      expect(html.includes(secret)).toBe(false);
    }

    expect(html.includes('href="https://bank.example/callback"')).toBe(true);
    expect(html.includes('action="https://bank.example/submit"')).toBe(true);
    expect(html.includes('data-redirect-url="https://bank.example/return"')).toBe(true);
    expect(html.includes('https://cdn.example/image.png')).toBe(true);
    expect(html.includes('wss://stream.bank.example/live')).toBe(true);
    expect(html.includes('/relative')).toBe(true);
    expect(html.includes('url=https://bank.example/refreshed')).toBe(true);
    expect(html.includes('srcset="[url-set]"')).toBe(true);
    expect(html.includes('data-note="/note"')).toBe(true);
    expect(html.includes('?')).toBe(false);
    expect(html.includes('#')).toBe(false);
    expect(html.includes('@')).toBe(false);

    // URL stripping is clone-only. The real page keeps the exact targets it
    // needs for navigation and form submission.
    expect(document.getElementById('oauth')?.getAttribute('href')).toBe(liveHref);
    expect(document.getElementById('login')?.getAttribute('action')).toBe(liveAction);
    expect(liveHref?.includes(hrefSecret)).toBe(true);
    expect(liveAction?.includes(formSecret)).toBe(true);
  });
});
