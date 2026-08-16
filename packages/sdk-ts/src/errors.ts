/** Thrown for any non-2xx Accrawl API response. `status` is the HTTP status; `body` is the parsed JSON error
 *  body if the server returned one (typically `{ error: string }`). */
export class AccrawlApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'AccrawlApiError';
    this.status = status;
    this.body = body;
  }
}
