/**
 * Error Recovery
 *
 * Handles action execution failures: sends the error to the AI model,
 * processes the model's retry response, and executes the retry action.
 *
 * Extracted from the main agent loop to reduce its size and separate concerns.
 */

import type { Page } from 'playwright';
import type { StepResponse } from '../ai/schema';
import type { CrawlSession } from '../ai/client';
import type { ActionResult } from './actions';
import type { CrawlRequest, PageState, AgentGoal, NormalizedAccount, NormalizedTransaction, NormalizedPosition } from '../types';
import type { SessionLogger } from '../utils/logger';
import type { DownloadTracker } from '../browser/download-handler';
import type { OtpState } from './otp-state';
import { OTP_RECEIVED_FROM_RECOVERY_LOG } from './otp-state';
import { ActionError } from './errors';
import { executeAction } from './actions';
import { waitForStability, getVisibleInteractiveElements, getCurrentUrl } from '../browser/page-utils';
import { buildStepContext } from '../ai/prompts';
import { prepareOtpRelay, pollForOtp } from '../otp/otp-poller';
import { updateSessionStatus } from './session-updater';
import {
  shouldBlockWaitForOtp, shouldConsumeOtpAfterAction, shouldResetOtpAfterAction,
  isOtpResendAction, shouldHonorLoginFlowRestarted,
  buildDataContext, goalToDescription, goalToStatus,
  positionDedupKey, accumulateStepTransactions,
  getStepSelector, getStepValue, asExecutableStep,
  buildActionFeedback, buildBlockedWaitForOtpFeedback,
  buildReportDataProgressFeedback,
} from './agent-loop';
import { checkForSpreadsheetDownload } from './agent-loop';

/** What the main loop should do after error recovery */
export type RecoveryAction =
  | { type: 'continue' }
  | { type: 'break'; finishReason: 'complete' }
  | { type: 'throw'; error: Error };

/** Mutable state shared between the main loop and error recovery */
export interface LoopState {
  goal: AgentGoal;
  otp: OtpState;
  consecutiveErrors: number;
  consecutiveSelectorNotFoundErrors: number;
  ambiguousSelectorRetries: number;
  pendingRecoveryWarning: string | null;
  pendingActionFeedback: string | null;
  pendingSpreadsheetText: string | null;
  lastReportDataProgress: { accounts: number; transactions: number; positions: number } | null;
  consecutiveStaleReports: number;
}

/** Context needed for error recovery — only instance-specific items, not importable functions */
export interface RecoveryContext {
  sessionId: string;
  request: CrawlRequest;
  credentials: Pick<CrawlRequest, 'username' | 'password' | 'dob' | 'phone'>;
  session: CrawlSession;
  log: SessionLogger;
  downloadTracker: DownloadTracker;
  accountMap: Map<string, NormalizedAccount>;
  transactionMap: Map<string, NormalizedTransaction>;
  positionMap: Map<string, NormalizedPosition>;
  allMemoryNotes: Array<{ key: string; value: string }>;
  capturePageState: (page: Page) => Promise<PageState>;
  captureLogState: (url: string, screenshotBase64: string, htmlLength: number) => Promise<{ url: string; screenshotBase64: string; htmlLength: number }>;
  /**
   * `executedStep` is the step that was ACTUALLY executed when it differs from
   * the model's original step (recovery substitutes a retry action). Every
   * recovery persist passes the retry step so the log never disguises a
   * substituted action as the original.
   */
  persistStepLog: (url: string, screenshotBase64: string, actionFeedback?: string, executedStep?: StepResponse) => Promise<void>;
}

/**
 * Handle an action execution failure: send error to the model, process its retry,
 * execute the retry action, and return what the main loop should do next.
 */
export async function recoverFromActionError(
  execError: unknown,
  activePage: Page,
  state: LoopState,
  ctx: RecoveryContext,
): Promise<RecoveryAction> {
  const errorMsg = execError instanceof Error ? execError.message : String(execError);
  ctx.log.warn(`[Agent] Action failed: ${errorMsg}`);

  // Collect visible elements to help the model pick a better selector
  let visibleElements: string | undefined;
  try {
    visibleElements = await getVisibleInteractiveElements(activePage);
    ctx.log.log(`[Agent] Visible elements hint provided (${visibleElements.split('\n').length} elements)`);
  } catch (visibleElementsErr) {
    ctx.log.warn('[Agent] Failed to collect visible elements for retry hint:', visibleElementsErr);
  }

  // Take a fresh page state and send error feedback to the model
  const errorPageState = await ctx.capturePageState(activePage);
  const errorUrl = getCurrentUrl(activePage);
  const errorContext = buildStepContext({
    goal: goalToDescription(state.goal, buildDataContext(Array.from(ctx.accountMap.values()), Array.from(ctx.transactionMap.values()), Array.from(ctx.positionMap.values()))),
    currentUrl: errorUrl,
  });

  const actionErrorType = execError instanceof ActionError ? execError.type : undefined;
  const { response: retryStep } = await ctx.session.sendError(errorMsg, errorPageState, errorContext, true, visibleElements, actionErrorType);
  const retryDesc = retryStep.description || retryStep.action;
  ctx.log.log(`[Agent] Retry step: ${retryStep.action} — ${retryDesc}`);

  // Accumulate any data from the retry response
  if (retryStep.accounts.length > 0) {
    for (const a of retryStep.accounts) ctx.accountMap.set(a.providerAccountId, a);
  }
  if (retryStep.transactions.length > 0) {
    // Same in-batch ordinal handling as the main loop: two identical no-id rows in ONE recovery
    // reportData are two SEPARATE real transactions and must both survive — a raw map.set keyed
    // on the bare dedup key collapsed them into one (a missed spend).
    accumulateStepTransactions(ctx.transactionMap, retryStep.transactions);
  }
  if (retryStep.positions.length > 0) {
    for (const p of retryStep.positions) ctx.positionMap.set(positionDedupKey(p), p);
  }
  if (retryStep.memoryNotes && retryStep.memoryNotes.length > 0) {
    for (const note of retryStep.memoryNotes) {
      ctx.allMemoryNotes.push(note);
    }
  }

  // Handle terminal/special actions from retry
  const terminalResult = await handleTerminalRetryAction(retryStep, activePage, errorUrl, errorPageState, state, ctx);
  if (terminalResult) return terminalResult;

  // Execute the retry action
  return executeRetryAction(retryStep, activePage, errorUrl, errorPageState, state, ctx);
}

async function handleTerminalRetryAction(
  retryStep: StepResponse,
  activePage: Page,
  errorUrl: string,
  errorPageState: PageState,
  state: LoopState,
  ctx: RecoveryContext,
): Promise<RecoveryAction | null> {
  if (retryStep.action === 'complete') {
    const logState = await ctx.captureLogState(errorUrl, errorPageState.screenshotBase64, errorPageState.htmlLength);
    await ctx.persistStepLog(logState.url, logState.screenshotBase64, undefined, retryStep);
    ctx.log.log(`[Agent] Agent signaled completion after error recovery`);
    return { type: 'break', finishReason: 'complete' };
  }

  if (retryStep.action === 'error') {
    const msg = retryStep.message || retryStep.description || 'Agent requested termination after retry';
    const logState = await ctx.captureLogState(errorUrl, errorPageState.screenshotBase64, errorPageState.htmlLength);
    await ctx.persistStepLog(logState.url, logState.screenshotBase64, undefined, retryStep);
    return { type: 'throw', error: new Error(`Agent error after retry: ${msg}`) };
  }

  if (retryStep.action === 'loginComplete') {
    ctx.log.log(`[Agent] Login complete (from error recovery) → transitioning to extract`);
    await activePage.waitForTimeout(5000);
    await waitForStability(activePage, 30_000);
    const logState = await ctx.captureLogState(errorUrl, errorPageState.screenshotBase64, errorPageState.htmlLength);
    await ctx.persistStepLog(logState.url, logState.screenshotBase64, undefined, retryStep);
    state.goal = 'extract';
    state.otp.resetAfterAction();
    await updateSessionStatus(ctx.sessionId, 'navigating', 'Logged in, looking for financial data...');
    return { type: 'continue' };
  }

  if (retryStep.action === 'loginFlowRestarted') {
    const restartedAfterSuccessfulLogin = shouldHonorLoginFlowRestarted(state.goal);
    ctx.log.log(
      `[Agent] loginFlowRestarted signaled during recovery${restartedAfterSuccessfulLogin ? ' — resetting auth state after earlier successful login' : ' — ignored because login has not been completed yet'}`
    );

    if (restartedAfterSuccessfulLogin) {
      state.goal = 'login';
      state.pendingActionFeedback = null;
      state.pendingRecoveryWarning = null;
      state.otp.resetForNewLogin();

      if (ctx.request.requires2fa && !state.otp.relayPrepared) {
        await updateSessionStatus(ctx.sessionId, 'waiting_for_otp', 'Login restarted after earlier successful login — activating OTP relay...');
        await prepareOtpRelay(ctx.sessionId, undefined, undefined, undefined, ctx.log);
        state.otp.relayPrepared = true;
      }

      if (ctx.request.requires2fa) {
        state.pendingRecoveryWarning =
          'WARNING: Login flow was restarted. The previous OTP is no longer valid. ' +
          'You MUST call waitForOtp before attempting to fill OTP_CODE. ' +
          'Do NOT fill OTP_CODE until you have received a new code via waitForOtp.';
      }
    }

    const logState = await ctx.captureLogState(errorUrl, errorPageState.screenshotBase64, errorPageState.htmlLength);
    await ctx.persistStepLog(logState.url, logState.screenshotBase64, undefined, retryStep);
    await updateSessionStatus(
      ctx.sessionId,
      restartedAfterSuccessfulLogin ? 'logging_in' : goalToStatus(state.goal),
      restartedAfterSuccessfulLogin
        ? 'Login restarted after earlier successful login — continuing authentication...'
        : 'loginFlowRestarted ignored because the crawl is still in its initial login flow.',
    );
    return { type: 'continue' };
  }

  if (retryStep.action === 'waitForOtp') {
    return handleRetryWaitForOtp(retryStep, activePage, errorUrl, errorPageState, state, ctx);
  }

  if (retryStep.action === 'reportData') {
    return handleRetryReportData(retryStep, errorUrl, errorPageState, state, ctx);
  }

  if (isOtpResendAction(retryStep)) {
    ctx.log.log('[Agent] OTP resend requested during recovery — priming relay before executing resend action');
    state.otp.resetForResend();
    if (ctx.request.requires2fa && !state.otp.relayPrepared) {
      await updateSessionStatus(ctx.sessionId, 'waiting_for_otp', 'Preparing OTP relay before requesting a fresh code...');
      await prepareOtpRelay(ctx.sessionId, undefined, undefined, undefined, ctx.log);
      state.otp.relayPrepared = true;
    }
  }

  return null; // Not a terminal action — proceed to execute retry
}

async function handleRetryWaitForOtp(
  retryStep: StepResponse,
  activePage: Page,
  errorUrl: string,
  errorPageState: PageState,
  state: LoopState,
  ctx: RecoveryContext,
): Promise<RecoveryAction> {
  ctx.log.log(`[Agent] waitForOtp (recovery) called with evidence: "${retryStep.otpEvidence ?? 'none'}"`);

  if (!retryStep.otpEvidence?.trim()) {
    ctx.log.warn('[Agent] waitForOtp (recovery) REJECTED: missing otpEvidence');
    state.pendingRecoveryWarning =
      'waitForOtp REJECTED: You must provide otpEvidence citing specific page evidence that confirms the OTP/verification step is active. ' +
      'Use readHtml, searchHtml, or getScreenshot to verify the page has transitioned to an OTP step, then retry waitForOtp with the evidence.';
    const logState = await ctx.captureLogState(errorUrl, errorPageState.screenshotBase64, errorPageState.htmlLength);
    await ctx.persistStepLog(logState.url, logState.screenshotBase64, 'waitForOtp rejected: missing otpEvidence', retryStep);
    return { type: 'continue' };
  }

  if (shouldBlockWaitForOtp(state.otp.cachedOtp, state.otp.consumed)) {
    state.otp.pendingForNextStep = state.otp.cachedOtp;
    state.pendingRecoveryWarning =
      'WARNING: waitForOtp was requested while an OTP code is already cached and unconsumed. ' +
      'Do NOT request another OTP yet. Either confirm the field is filled and submit the existing code, or explicitly request a new OTP first.';
    state.pendingActionFeedback = buildBlockedWaitForOtpFeedback();
    const logState = await ctx.captureLogState(errorUrl, errorPageState.screenshotBase64, errorPageState.htmlLength);
    await ctx.persistStepLog(logState.url, logState.screenshotBase64, state.pendingActionFeedback, retryStep);
    return { type: 'continue' };
  }

  state.otp.attempts++;
  if (state.otp.attempts > 2) {
    return { type: 'throw', error: new Error('OTP failed after 2 attempts. Aborting to prevent account lockout.') };
  }
  if (state.otp.cachedOtp && state.otp.consumed) {
    return { type: 'throw', error: new Error('OTP entry failed — code was consumed but rejected. Aborting to prevent account lockout.') };
  }
  if (!state.otp.relayPrepared) {
    await prepareOtpRelay(ctx.sessionId, undefined, undefined, undefined, ctx.log);
    state.otp.relayPrepared = true;
  }
  state.otp.cachedOtp = await pollForOtp(ctx.sessionId, undefined, undefined, ctx.log);
  state.otp.resetAfterOtpReceived();
  ctx.log.log(OTP_RECEIVED_FROM_RECOVERY_LOG);
  state.otp.pendingForNextStep = state.otp.cachedOtp;
  await activePage.waitForTimeout(1000);
  const logState = await ctx.captureLogState(errorUrl, errorPageState.screenshotBase64, errorPageState.htmlLength);
  await ctx.persistStepLog(logState.url, logState.screenshotBase64, undefined, retryStep);
  return { type: 'continue' };
}

async function handleRetryReportData(
  retryStep: StepResponse,
  errorUrl: string,
  errorPageState: PageState,
  state: LoopState,
  ctx: RecoveryContext,
): Promise<RecoveryAction> {
  const currentProgress = {
    accounts: ctx.accountMap.size,
    transactions: ctx.transactionMap.size,
    positions: ctx.positionMap.size,
  };

  state.pendingActionFeedback = buildReportDataProgressFeedback(currentProgress);
  if (
    state.lastReportDataProgress
    && state.lastReportDataProgress.accounts === currentProgress.accounts
    && state.lastReportDataProgress.transactions === currentProgress.transactions
    && state.lastReportDataProgress.positions === currentProgress.positions
  ) {
    state.pendingRecoveryWarning =
      'WARNING: Your latest report step added no NEW unique accounts/transactions/positions. ' +
      'Do NOT repeat an identical report step on the same page. ' +
      'Either navigate to a different page for additional data, or use "complete" if extraction is done.';
  }
  state.lastReportDataProgress = currentProgress;

  const logState = await ctx.captureLogState(errorUrl, errorPageState.screenshotBase64, errorPageState.htmlLength);
  await ctx.persistStepLog(logState.url, logState.screenshotBase64, undefined, retryStep);
  return { type: 'continue' };
}

async function executeRetryAction(
  retryStep: StepResponse,
  activePage: Page,
  errorUrl: string,
  errorPageState: PageState,
  state: LoopState,
  ctx: RecoveryContext,
): Promise<RecoveryAction> {
  let retryActionResult: ActionResult = { status: 'success', matchCount: 0 };
  try {
    retryActionResult = await executeAction(activePage, asExecutableStep(retryStep), ctx.credentials, state.otp.cachedOtp ?? undefined, ctx.log);
    state.consecutiveErrors = 0;
    state.consecutiveSelectorNotFoundErrors = 0;
    state.ambiguousSelectorRetries = 0;

    const retryUsedOtpPlaceholder = retryStep.action === 'fill' && getStepValue(retryStep) === 'OTP_CODE';
    if (retryUsedOtpPlaceholder) {
      state.otp.fillAttempted = true;
    }
    if (shouldResetOtpAfterAction(retryStep)) {
      state.otp.resetAfterAction();
    } else if (shouldConsumeOtpAfterAction({
      action: retryStep.action,
      description: retryStep.description,
      usedOtpPlaceholder: retryUsedOtpPlaceholder,
      otpFillAttempted: state.otp.fillAttempted,
    })) {
      state.otp.markConsumed();
    }

    const spreadsheetText = await checkForSpreadsheetDownload(ctx.downloadTracker, ctx.log);
    if (spreadsheetText) state.pendingSpreadsheetText = spreadsheetText;
  } catch (retryError) {
    const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
    ctx.log.warn(`[Agent] Retry action also failed: ${retryMsg}`);

    if (retryError instanceof ActionError) {
      if (retryError.type === 'ambiguous_selector') {
        // The selector matched more than one element, so the click was not
        // performed. Report that fact and how to make the selector unique, then
        // let the MODEL decide what to do next — refine the selector, navigate
        // somewhere else, read the HTML, or anything else. We do NOT pick a
        // strategy for it, and we do NOT force-complete or hard-fail on a retry
        // count: the model may be deliberately working toward a higher-fidelity
        // view, and the global step budget (maxSteps) is the only bound that
        // belongs here. retryMsg already lists each matching element with its
        // distinguishing container/visibility so the model can disambiguate.
        state.ambiguousSelectorRetries++;
        state.pendingRecoveryWarning =
          `WARNING: ${retryMsg}\n` +
          `That selector matched more than one element, so no click was performed. To act on a single element, make the selector unique — anchor it to a distinguishing ancestor (an id, aria-label, or heading), or use one of the specific selectors listed above.`;
        const ambiguousLogState = await ctx.captureLogState(errorUrl, errorPageState.screenshotBase64, errorPageState.htmlLength);
        await ctx.persistStepLog(ambiguousLogState.url, ambiguousLogState.screenshotBase64, `Ambiguous selector (retry ${state.ambiguousSelectorRetries}): ${retryMsg}`, retryStep);
        return { type: 'continue' };
      }

      if (retryError.type === 'selector_not_found') {
        state.consecutiveSelectorNotFoundErrors++;
        const remaining = 3 - state.consecutiveSelectorNotFoundErrors;
        state.pendingRecoveryWarning =
          `WARNING: Selector not found (${state.consecutiveSelectorNotFoundErrors}/3 failures` +
          (remaining > 0 ? `, ${remaining} attempt(s) left` : `, LAST attempt`) + `). ` +
          `The selector "${getStepSelector(retryStep)}" did not match any element. ` +
          `REQUIRED: Call searchHtml to find actual elements on the current page, ` +
          `then construct a selector based on what searchHtml returns. Do NOT guess.`;
        if (state.consecutiveSelectorNotFoundErrors >= 3) {
          return { type: 'throw', error: new Error(`3 consecutive selector-not-found failures. Last: ${retryMsg}`) };
        }
        const selectorLogState = await ctx.captureLogState(errorUrl, errorPageState.screenshotBase64, errorPageState.htmlLength);
        await ctx.persistStepLog(selectorLogState.url, selectorLogState.screenshotBase64, `Selector not found (${state.consecutiveSelectorNotFoundErrors}/3): ${retryMsg}`, retryStep);
        return { type: 'continue' };
      }
    }

    state.consecutiveErrors++;
    const retryFailureLogState = await ctx.captureLogState(errorUrl, errorPageState.screenshotBase64, errorPageState.htmlLength);
    await ctx.persistStepLog(retryFailureLogState.url, retryFailureLogState.screenshotBase64, undefined, retryStep);
    if (state.consecutiveErrors >= 2) {
      return { type: 'throw', error: new Error(`2 consecutive action failures. Last: ${retryMsg}`) };
    }
    return { type: 'continue' };
  }

  await waitForStability(activePage, 10_000);
  const retryLogState = await ctx.captureLogState(errorUrl, errorPageState.screenshotBase64, errorPageState.htmlLength);
  const retryActionFeedback = buildActionFeedback(retryStep, errorUrl, errorPageState.htmlLength, retryLogState.url, retryLogState.htmlLength, retryActionResult);
  state.pendingActionFeedback = retryActionFeedback;
  ctx.log.log(`[Agent] ${retryActionFeedback}`);
  await ctx.persistStepLog(retryLogState.url, retryLogState.screenshotBase64, retryActionFeedback, retryStep);

  // Warn the model when a retry force/jsClick had no visible effect
  if (retryActionResult.status === 'fallback') {
    const retrySelector = getStepSelector(retryStep);
    const retryUrlChanged = errorUrl !== retryLogState.url;
    const retryHtmlDelta = retryLogState.htmlLength - errorPageState.htmlLength;
    if (!retryUrlChanged && Math.abs(retryHtmlDelta) < 100) {
      state.pendingRecoveryWarning =
        `WARNING: Your click on "${retrySelector}" required ${retryActionResult.clickMethod} (normal click failed: ${retryActionResult.normalClickError}). ` +
        `The page did not change after the click. Before proceeding, use getScreenshot or readHtml to verify ` +
        `the click had the intended effect. If it did not, use a different approach.`;
    }
  }

  return { type: 'continue' };
}
