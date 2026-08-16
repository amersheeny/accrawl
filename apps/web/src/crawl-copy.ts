import { HOSTED_COPY } from '@accrawl/contracts';

const CRAWL_ERROR_COPY = new Map<string, string>([
  [HOSTED_COPY.refreshSessionEnded, HOSTED_COPY.crawlSessionEnded],
  [HOSTED_COPY.refreshStartFailure, HOSTED_COPY.crawlStartFailure],
  [HOSTED_COPY.refreshUnexpectedFailure, HOSTED_COPY.crawlUnexpectedFailure],
]);

export function crawlDisplayError(error: string | null | undefined): string | null {
  if (!error) return null;
  return CRAWL_ERROR_COPY.get(error) ?? error;
}
