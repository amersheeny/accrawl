/**
 * Typed Action Errors
 *
 * Structured error types for action execution failures.
 * Replaces string matching on error messages with instanceof checks.
 */

export type ActionErrorType =
  | 'ambiguous_selector'
  | 'selector_not_found'
  | 'click_failed'
  | 'missing_field';

/**
 * Structured error thrown by executeAction() so callers can
 * switch on error.type instead of string-matching error.message.
 */
export class ActionError extends Error {
  constructor(
    public readonly type: ActionErrorType,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}
