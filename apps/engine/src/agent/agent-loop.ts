/**
 * Agent Loop
 *
 * Main AI agent loop: HTML preview + optional screenshot -> Gemini -> action -> repeat.
 * Uses multi-turn conversation via CrawlSession — Gemini has full context
 * of every action throughout the session.
 *
 * Token optimization: instead of embedding full HTML every step, the model
 * receives the page URL + HTML length and uses readHtml/searchHtml to fetch
 * content on demand. A current full-page screenshot IS attached to every step
 * message (login and extraction) as a deliberate reliability choice;
 * getScreenshot within a step replays that same capture.
 *
 * Data extraction is unified with navigation — every step response includes
 * accounts/transactions/positions arrays (empty when not extracting).
 * The model also reports dataLocations to build crawl memory for future runs.
 */

import type { Page } from 'playwright';
import type {
  CrawlRequest,
  CrawlResponse,
  CrawlStepLog,
  NormalizedAccount,
  NormalizedTransaction,
  NormalizedPosition,
  AgentGoal,
  PageState,
  CrawlMemory,
  CrawlFailureReason,
} from '../types';
import { ApiContractError, isApiContractDriftMessage } from '../ai/providers/errors';
import type { WriteGate } from '../browser/write-gate';
import { CrawlSession } from '../ai/client';
import { USE_INTERACTIONS_API } from '../ai/providers/gemini';
import type { StepResponse, ExecutableStepResponse, StepErrorCategory } from '../ai/schema';
import { buildSystemPrompt, buildStepContext } from '../ai/prompts';
import { takeScreenshot, waitForStability, getCurrentUrl, getPageContent } from '../browser/page-utils';
import { withTimeout } from '../utils/with-timeout';
import { executeAction, type ActionResult } from './actions';
import { OtpState, OTP_RECEIVED_LOG } from './otp-state';
import { recoverFromActionError, type LoopState, type RecoveryContext } from './error-recovery';
import { prepareOtpRelay, pollForOtp } from '../otp/otp-poller';
import { updateSessionStatus, appendStepLog, flushSessionLogs, CrawlCancelledError } from './session-updater';
import { DownloadTracker, parseXlsxToText, isDecodableExcelWorkbook } from '../browser/download-handler';
import { uploadScreenshot } from './screenshot-uploader';
import { calculateCost } from '../ai/pricing';
import { assertSafeNavigationUrl } from '../utils/url-safety';
import type { SessionLogger } from '../utils/logger';
import { safeBrowserUrl, safeBrowserUrlsInText } from '../utils/safe-browser-url';

/** Overall backstop for a full page capture (screenshot + HTML). Env-overridable. */
const CAPTURE_TIMEOUT_MS = Number(process.env.CAPTURE_TIMEOUT_MS ?? '45000');
/** Bound for the initial login-page navigation (WAF tarpit guard). Env-overridable. */
const INITIAL_NAV_TIMEOUT_MS = Number(process.env.INITIAL_NAV_TIMEOUT_MS ?? '180000');

/**
 * Build a PageState from the current browser page.
 *
 * OTP masking mutates the live field and restores it in `takeScreenshot`'s
 * `finally`, so the screenshot operation must be awaited directly. Only the
 * detached HTML capture is safe to abandon behind the outer timeout.
 * `takeScreenshotFn` is injectable for the OTP-restoration regression tests.
 */
export async function capturePageState(
  page: Page,
  log?: SessionLogger,
  redactOtp?: string | null,
  takeScreenshotFn: typeof takeScreenshot = takeScreenshot,
): Promise<PageState> {
  const screenshotBase64 = await takeScreenshotFn(page, redactOtp, log);
  const fullHtml = await withTimeout(
    getPageContent(page, log, redactOtp),
    CAPTURE_TIMEOUT_MS,
    'capturePageState',
  );
  return {
    screenshotBase64,
    fullHtml,
    htmlLength: fullHtml.length,
  };
}

/**
 * Whether a capture error is recoverable in place by waiting for the page to
 * settle and retrying — a mid-navigation execution-context teardown or a
 * capture/evaluate timeout on a heavy DOM. Anything else propagates.
 */
export function isRecoverableCaptureError(message: string): boolean {
  return (
    message.includes('Execution context') ||
    message.includes('navigation') ||
    /timed out/i.test(message)
  );
}

/**
 * Best-effort degraded capture used only when a full capturePageState failed
 * twice. Tries a bounded screenshot; if even that fails, returns a URL-only
 * state. This keeps the loop alive for one step so the model can recover — it
 * is a one-off, never a permanent downgrade (the next step captures fully).
 */
async function captureDegradedState(
  page: Page,
  log: SessionLogger,
  redactOtp?: string | null,
): Promise<{ pageState: PageState; url: string }> {
  let url = '';
  try {
    url = getCurrentUrl(page);
  } catch (urlErr) {
    log.warn('[Agent] Could not read URL for degraded capture:', urlErr);
  }
  let screenshotBase64 = '';
  try {
    screenshotBase64 = await takeScreenshot(page, redactOtp, log);
  } catch (shotErr) {
    log.warn('[Agent] Degraded capture could not take a screenshot:', shotErr);
  }
  return {
    url,
    pageState: { screenshotBase64, fullHtml: '', htmlLength: 0 },
  };
}

/**
 * Check if an action triggered a spreadsheet download and parse it.
 * Returns the parsed text or null.
 */
export async function checkForSpreadsheetDownload(
  downloadTracker: DownloadTracker,
  log: SessionLogger,
): Promise<string | null> {
  const downloaded = await downloadTracker.getDownload();
  // Extension check first (unchanged behavior for a named export like
  // `data.xlsx`); only an EXTENSIONLESS download (a file literally named
  // "download", as some issuers serve) falls through
  // to the content signature check — a properly-named export never reaches it.
  if (downloaded && (isSpreadsheetFilename(downloaded.filename) || isDecodableExcelWorkbook(downloaded.filePath, log))) {
    const how = isSpreadsheetFilename(downloaded.filename) ? 'filename' : 'content-signature';
    log.log(`[Agent] Spreadsheet download detected (${how}): ${downloaded.filename}`);
    const text = parseXlsxToText(downloaded.filePath, log);
    if (text) {
      log.log(`[Agent] Spreadsheet parsed (${text.length} chars), will include in next step context`);
      return text;
    }
  }
  return null;
}

/** Compatibility shape retained for the executor watchdog; parity logic does not publish partial results. */
export interface PartialCrawlRef {
  accounts: () => NormalizedAccount[];
  transactions: () => NormalizedTransaction[];
  positions: () => NormalizedPosition[];
  stepsExecuted: () => number;
  stepLogs: () => CrawlStepLog[];
  crawlMemory: () => CrawlMemory | undefined;
}

/**
 * Run the AI agent loop for a single crawl.
 */
export async function runAgentLoop(
  page: Page,
  request: CrawlRequest,
  log: SessionLogger,
  _partialRef?: PartialCrawlRef,
  writeGate?: WriteGate,
): Promise<CrawlResponse> {
  const {
    sessionId,
    loginUrl,
    playbook,
    customInstructions,
    loginHints,
    extractionHints,
    maxSteps,
    timeoutSeconds,
  } = request;

  const credentials = {
    username: request.username,
    password: request.password,
    dob: request.dob,
    phone: request.phone,
  };

  const systemPrompt = buildSystemPrompt({
    playbook,
    customInstructions,
    loginHints,
    extractionHints,
    existingAccounts: request.existingAccounts?.map(a => ({
      providerAccountId: a.providerAccountId,
      name: a.name,
      description: a.description,
      currency: a.currency,
      type: a.type,
      balance: a.balance,
    })),
    existingPositions: request.existingPositions?.map(p => ({
      providerPositionId: p.providerPositionId,
      providerAccountId: p.providerAccountId,
      symbol: p.symbol,
      name: p.name,
      currency: p.currency,
      quantity: p.quantity,
    })),
    recentTransactions: request.recentTransactions,
    cutoffDate: request.cutoffDate,
    historyFloorDate: request.historyFloorDate,
    accountsWithoutStoredHistory: request.accountsWithoutStoredHistory,
    crawlMemory: request.crawlMemory,
    useUnifiedLoop: USE_INTERACTIONS_API,
  });

  const session = new CrawlSession(systemPrompt, request.model, log, request.thinkingLevel);

  let stepCount = 0;
  let goal: AgentGoal = 'login';
  let consecutiveErrors = 0;
  let consecutiveSelectorNotFoundErrors = 0;
  let ambiguousSelectorRetries = 0;
  const otp = new OtpState();
  let pendingRecoveryWarning: string | null = null;
  let pendingActionFeedback: string | null = null;
  let pendingReconciliationFeedback: string | null = null;
  let lastReportDataProgress: { accounts: number; transactions: number; positions: number } | null = null;
  let consecutiveStaleReports = 0;
  let finishReason: CrawlFinishReason | null = null;

  // Collected data — accumulated across all steps (Maps for O(1) dedup on insert)
  const accountMap = new Map<string, NormalizedAccount>();
  const transactionMap = new Map<string, NormalizedTransaction>();
  // Crawl-wide: `id:` keys proven non-unique on this statement (recycled bank refs).
  const demotedIdKeys = new Set<string>();
  const positionMap = new Map<string, NormalizedPosition>();
  const allAccounts = () => Array.from(accountMap.values());
  // Explicit count claims (rule 26b) materialize to N rows at hand-off; the backend's
  // in-batch content ordinals then store N documents, exactly as before the contract.
  const allTransactions = () => expandTransactionCounts(Array.from(transactionMap.values()), log);
  const allPositions = () => Array.from(positionMap.values());

  // Memory notes — accumulated key-value pairs from the model about where data was found
  const allMemoryNotes: Array<{ key: string; value: string }> = [];

  // Step logs — accumulated for crawl history
  const stepLogs: CrawlStepLog[] = [];

  // Hard timeout
  const deadline = Date.now() + timeoutSeconds * 1000;

  // Track the active page — switches to popups/new tabs when they open
  let activePage: Page = page;
  const browserContext = page.context();

  // Download tracking — captures file downloads (e.g. XLSX export)
  const downloadTracker = new DownloadTracker(page, log);
  let pendingSpreadsheetText: string | null = null;

  browserContext.on('page', async (newPage) => {
    try {
      await newPage.waitForLoadState('domcontentloaded');
      log.log(`[Agent] New tab/popup opened: ${safeBrowserUrl(newPage.url())}`);
      activePage = newPage;
      downloadTracker.attachTo(newPage);
      newPage.on('close', () => {
        log.log(`[Agent] Popup closed, switching back to main page`);
        activePage = page;
      });
    } catch (e) {
      log.warn(`[Agent] Popup failed to load:`, e);
    }
  });

  try {
    // If 2FA is expected, signal OTP relay BEFORE browser interaction
    if (request.requires2fa) {
      log.log(`[Agent] 2FA required — preparing OTP relay before browser navigation`);
      await prepareOtpRelay(sessionId, undefined, undefined, undefined, log);
      otp.relayPrepared = true;
      log.log(`[Agent] OTP relay confirmed ready, proceeding with browser`);
    }

    // Navigate to login page. Explicit timeout so a WAF tarpit that never
    // responds is bounded and classified as navigation_timeout rather than
    // hanging until the watchdog fires.
    await updateSessionStatus(sessionId, 'logging_in', 'Navigating to login page...');
    log.log(`[Agent] Navigating to ${loginUrl}`);
    // SSRF guard on the entry URL too. loginUrl is normally server-trusted
    // (institution config), but loginUrlOverride is operator-settable — refuse
    // loopback/private/link-local/metadata targets regardless of source.
    await assertSafeNavigationUrl(loginUrl);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: INITIAL_NAV_TIMEOUT_MS });
    await waitForStability(page);

    while (stepCount < maxSteps && Date.now() < deadline) {
      stepCount++;

      // Per-step deadline check — stop early if less than 60s remaining
      if (Date.now() + 60_000 > deadline) {
        log.warn(`[Agent] Less than 60s remaining, stopping`);
        finishReason = 'timeout';
        break;
      }

      // Capture current page state (uses activePage — may be a popup)
      // Retry up to 2 times if the page is mid-navigation (execution context
      // destroyed) OR the capture timed out (heavy/unstable DOM). A capture
      // timeout is recoverable: wait for the page to settle and retry. If BOTH
      // attempts fail, do NOT abort the crawl — warn the model, capture a
      // best-effort minimal state, and continue so the loop can recover instead
      // of consuming the whole crawl budget on one stuck step.
      let pageState: PageState | null = null;
      let currentUrl: string | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          pageState = await capturePageState(activePage, log, otp.cachedOtp);
          currentUrl = getCurrentUrl(activePage);
          break;
        } catch (captureErr) {
          const msg = captureErr instanceof Error ? captureErr.message : String(captureErr);
          const isLastAttempt = attempt >= 1;
          if (!isLastAttempt && isRecoverableCaptureError(msg)) {
            log.warn(`[Agent] Capture failed (attempt ${attempt + 1}/2): ${msg}. Waiting for the page to settle, then retrying...`);
            await activePage.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch((waitErr) => {
              log.warn('[Agent] Timed out waiting for domcontentloaded during capture retry:', waitErr);
            });
            await waitForStability(activePage, 5_000);
            continue;
          }
          if (!isRecoverableCaptureError(msg)) {
            // Genuine fatal capture error — propagate to the outer handler.
            throw captureErr;
          }
          // Recoverable error that survived the retry. Do NOT throw-and-die:
          // warn the model and fall through to a degraded best-effort snapshot
          // so the loop stays alive instead of burning the whole crawl budget.
          log.error(`[Agent] Page capture still failing after retry (${msg}) — injecting degraded state and continuing`);
          break;
        }
      }

      if (!pageState || currentUrl === null) {
        // Capture did not produce a usable state. Warn the model and inject a
        // degraded snapshot (URL + best-effort screenshot, NOT a permanent
        // downgrade — the next step captures fully) so it can decide how to
        // proceed on the next step.
        pendingRecoveryWarning =
          'WARNING: The page could not be fully captured (capture timed out or the execution context was destroyed). ' +
          'The HTML below may be empty or minimal. Use getScreenshot, readHtml, or searchHtml to re-fetch content, ' +
          'or navigate to a simpler page before continuing.';
        const degraded = await captureDegradedState(activePage, log, otp.cachedOtp);
        pageState = degraded.pageState;
        currentUrl = degraded.url;
      }
      pageState = pageState!;
      currentUrl = currentUrl!;

      // Build context with data summary and any pending OTP
      const dataContext = buildDataContext(allAccounts(), allTransactions(), allPositions());
      session.setExtractionSummary(dataContext);
      const goalDesc = goalToDescription(goal, dataContext);
      let context = buildStepContext({ goal: goalDesc, currentUrl });
      if (otp.pendingForNextStep) {
        context += `\n\nOTP code received. Use a "fill" action with value "OTP_CODE" to enter it into the verification field, then click submit/continue. The system will substitute the real code — do NOT type the digits yourself.`;
        otp.pendingForNextStep = null;
      }
      if (pendingSpreadsheetText) {
        // Present the parsed file NEUTRALLY and let the model judge whether it
        // holds data rows — never assert "contains financial data" (the real
        // corruption case: a movements export parsed to 23 chars of headers,
        // the context claimed it "contained financial data" and ordered
        // extraction, so the model invented 39 rows from nothing). No
        // line-count heuristic decides this — only the model reading the
        // actual content below does. Reporting a value not present in this
        // file (or on the page) is fabrication.
        context +=
          `\n\nA spreadsheet file was downloaded (parsed to ${pendingSpreadsheetText.length} characters, shown below). ` +
          `Read it and extract ONLY the data rows actually present — each value must come from a real cell you can see. ` +
          `If it contains only headers, a title, or no data rows, report nothing from it and either retry the export or extract from the on-page table instead. ` +
          `When it does contain data rows, report up to 50 transactions and 50 positions per step_report_data call and continue until the file is fully covered, then complete.\n\n` +
          pendingSpreadsheetText;
        pendingSpreadsheetText = null;
      }
      if (pendingRecoveryWarning) {
        context += `\n\n${pendingRecoveryWarning}`;
        pendingRecoveryWarning = null;
      }
      if (pendingActionFeedback) {
        context += `\n\n${pendingActionFeedback}`;
        pendingActionFeedback = null;
      }
      if (pendingReconciliationFeedback) {
        context += `\n\n${pendingReconciliationFeedback}`;
        pendingReconciliationFeedback = null;
      }
      const screenshotKB = Math.round(pageState.screenshotBase64.length * 3 / 4 / 1024);
      log.log(`[Agent] Step ${stepCount} | Goal: ${goal} | URL: ${currentUrl} | Screenshot: ${screenshotKB}KB | HTML: ${pageState.htmlLength} chars`);

      // Always include the latest screenshot so the model can reason about
      // popups/overlays/visual states that are not reliably inferable from HTML.
      const includeScreenshot = true;

      // Send to Claude and get next action + extracted data + token usage
      const t0 = Date.now();
      const { response: step, usage: stepUsage } = await session.sendStep(pageState, context, includeScreenshot);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      log.log(`[Agent] Step ${stepCount} response (${elapsed}s): action=${step.action}`
        + ` (accounts=${step.accounts.length} transactions=${step.transactions.length} positions=${step.positions.length})`);
      log.log(`[Agent] Step ${stepCount} tokens: in=${stepUsage.inputTokens} out=${stepUsage.outputTokens} cache_create=${stepUsage.cacheCreationInputTokens} cache_read=${stepUsage.cacheReadInputTokens}`);

      // Update session status
      const actionDesc = safeBrowserUrlsInText(step.description || step.action);
      await updateSessionStatus(sessionId, goalToStatus(goal), `Step ${stepCount}: ${actionDesc}`, stepCount);

      // Accumulate extracted data from this step
      if (step.accounts.length > 0) {
        for (const a of step.accounts) accountMap.set(a.providerAccountId, a);
        log.log(`[Agent] Extracted ${step.accounts.length} accounts (${accountMap.size} unique)`);
      }
      if (step.transactions.length > 0) {
        accumulateStepTransactions(transactionMap, step.transactions, log, demotedIdKeys);
        log.log(`[Agent] Extracted ${step.transactions.length} transactions (${transactionMap.size} unique)`);
      }
      if (step.positions.length > 0) {
        for (const p of step.positions) positionMap.set(positionDedupKey(p), p);
        log.log(`[Agent] Extracted ${step.positions.length} positions (${positionMap.size} unique)`);
        // Reconciliation feedback (facts only): positions decompose their
        // account, so Σ|holdings| ≈ balance. If a table of balance-history /
        // policy-statement rows was captured as holdings (they sum to a
        // MULTIPLE of the account), tell the model the arithmetic fact so it
        // re-extracts only the current holdings. No strategy injected.
        const recon = buildPositionReconciliationFeedback(allPositions(), allAccounts());
        if (recon) pendingReconciliationFeedback = recon;
        // FK-roster feedback (facts only): a position whose providerAccountId
        // matches no reported account cannot be attributed or reconciled, and
        // storage will quarantine it. State the mismatch and the valid ids.
        const fk = buildPositionAccountFkFeedback(step.positions, allAccounts());
        if (fk) pendingReconciliationFeedback = pendingReconciliationFeedback
          ? `${pendingReconciliationFeedback}\n${fk}`
          : fk;
      }

      // Accumulate memory notes for crawl memory
      if (step.memoryNotes && step.memoryNotes.length > 0) {
        const safeMemoryNotes = step.memoryNotes.map((note) => ({
          ...note,
          value: safeBrowserUrlsInText(note.value),
        }));
        for (const note of safeMemoryNotes) {
          allMemoryNotes.push(note);
        }
        log.log(`[Agent] Memory notes: ${safeMemoryNotes.map(n => `${n.key}: ${n.value}`).join(' | ')}`);
      }

      const persistStepLog = async (
        logUrl: string,
        screenshotBase64: string,
        actionFeedback?: string,
        executedStep?: StepResponse,
      ): Promise<void> => {
        const screenshotResult = await uploadScreenshot(sessionId, stepCount, screenshotBase64, log);
        const stepLog: CrawlStepLog = {
          stepNumber: stepCount,
          ...buildStepLogActionFields(step, executedStep ?? step),
          ...(actionFeedback && { actionFeedback: sanitizeStepLogActionFeedback(actionFeedback) }),
          url: logUrl,
          durationMs: Date.now() - t0,
          ...(screenshotResult && { screenshotPath: screenshotResult.path, screenshotUrl: screenshotResult.url }),
          timestamp: new Date().toISOString(),
          tokenUsage: stepUsage,
        };
        stepLogs.push(stepLog);
        await appendStepLog(sessionId, stepLog);
      };

      const preActionUrl = currentUrl;
      const preActionScreenshotBase64 = pageState.screenshotBase64;
      const preActionHtmlLength = pageState.htmlLength;
      const captureLogState = async (
        fallbackUrl: string,
        fallbackScreenshotBase64: string,
        fallbackHtmlLength: number,
      ): Promise<{ url: string; screenshotBase64: string; htmlLength: number }> => {
        try {
          const postState = await capturePageState(activePage, log, otp.cachedOtp);
          return {
            url: getCurrentUrl(activePage),
            screenshotBase64: postState.screenshotBase64,
            htmlLength: postState.htmlLength,
          };
        } catch (captureErr) {
          log.warn('[Agent] Failed to capture post-action state, using fallback snapshot:', captureErr);
          return {
            url: fallbackUrl,
            screenshotBase64: fallbackScreenshotBase64,
            htmlLength: fallbackHtmlLength,
          };
        }
      };

      // Handle terminal/special actions
      if (step.action === 'complete') {
        await persistStepLog(preActionUrl, preActionScreenshotBase64);
        log.log(`[Agent] Agent signaled completion`);
        finishReason = 'complete';
        break;
      }

      if (step.action === 'error') {
        const terminalMessage = step.message || step.description || 'Agent requested termination';
        await persistStepLog(preActionUrl, preActionScreenshotBase64);
        throw new AgentTerminalError(`Agent error: ${terminalMessage}`, step.category);
      }

      if (step.action === 'loginComplete') {
        log.log(`[Agent] Login complete → transitioning to extract`);
        await activePage.waitForTimeout(5000);
        await waitForStability(activePage, 30_000);
        const logState = await captureLogState(preActionUrl, preActionScreenshotBase64, preActionHtmlLength);
        await persistStepLog(logState.url, logState.screenshotBase64);
        goal = 'extract';
        otp.cachedOtp = null;
        otp.consumed = false;
        otp.fillAttempted = false;
        // §2: authentication is over, so the browser's ability to change state ends here. Everything
        // after this point is exploration, which is exactly where a hostile config or injected page
        // content would try to move money.
        writeGate?.setPhase('extract');
        await updateSessionStatus(sessionId, 'navigating', 'Logged in, looking for financial data...');
        continue;
      }

      if (step.action === 'loginFlowRestarted') {
        const restartedAfterSuccessfulLogin = shouldHonorLoginFlowRestarted(goal);

        log.log(
          `[Agent] loginFlowRestarted signaled${restartedAfterSuccessfulLogin ? ' — resetting auth state after earlier successful login' : ' — ignored because login has not been completed yet'}`
        );

        if (restartedAfterSuccessfulLogin) {
          goal = 'login';
          // §2: a genuine re-authentication needs to post credentials again, so the write window
          // reopens — and closes again on the next loginComplete.
          writeGate?.setPhase('login');
          pendingActionFeedback = null;
          pendingRecoveryWarning = null;
          otp.pendingForNextStep = null;
          otp.cachedOtp = null;
          otp.consumed = false;
          otp.fillAttempted = false;
          otp.attempts = 0;

          if (request.requires2fa && !otp.relayPrepared) {
            await updateSessionStatus(sessionId, 'waiting_for_otp', 'Login restarted after earlier successful login — activating OTP relay...');
            await prepareOtpRelay(sessionId, undefined, undefined, undefined, log);
            otp.relayPrepared = true;
            log.log('[Agent] OTP relay ready for the restarted login flow');
          }

          if (request.requires2fa) {
            pendingRecoveryWarning =
              'WARNING: Login flow was restarted. The previous OTP is no longer valid. ' +
              'You MUST call waitForOtp before attempting to fill OTP_CODE. ' +
              'Do NOT fill OTP_CODE until you have received a new code via waitForOtp.';
          }
        }

        const logState = await captureLogState(preActionUrl, preActionScreenshotBase64, preActionHtmlLength);
        await persistStepLog(logState.url, logState.screenshotBase64);
        await updateSessionStatus(
          sessionId,
          restartedAfterSuccessfulLogin ? 'logging_in' : goalToStatus(goal),
          restartedAfterSuccessfulLogin
            ? 'Login restarted after earlier successful login — continuing authentication...'
            : 'loginFlowRestarted ignored because the crawl is still in its initial login flow.',
        );
        continue;
      }

      if (step.action === 'waitForOtp') {
        log.log(`[Agent] waitForOtp called with evidence: "${step.otpEvidence ?? 'none'}"`);

        // Reject if the model didn't provide OTP evidence (required field but some providers don't enforce)
        if (!step.otpEvidence?.trim()) {
          log.warn('[Agent] waitForOtp REJECTED: missing otpEvidence — model did not cite page evidence confirming OTP flow');
          pendingRecoveryWarning =
            'waitForOtp REJECTED: You must provide otpEvidence citing specific page evidence that confirms the OTP/verification step is active. ' +
            'Use readHtml, searchHtml, or getScreenshot to verify the page has transitioned to an OTP step, then retry waitForOtp with the evidence.';
          const logState = await captureLogState(preActionUrl, preActionScreenshotBase64, preActionHtmlLength);
          await persistStepLog(logState.url, logState.screenshotBase64, 'waitForOtp rejected: missing otpEvidence');
          continue;
        }

        if (shouldBlockWaitForOtp(otp.cachedOtp, otp.consumed)) {
          otp.pendingForNextStep = otp.cachedOtp;
          pendingRecoveryWarning =
            'WARNING: waitForOtp was requested while an OTP code is already cached and unconsumed. ' +
            'Do NOT request another OTP yet. Either confirm the field is filled and submit the existing code, or explicitly request a new OTP first.';
          pendingActionFeedback = buildBlockedWaitForOtpFeedback();
          const blockedLogState = await captureLogState(preActionUrl, preActionScreenshotBase64, preActionHtmlLength);
          await persistStepLog(blockedLogState.url, blockedLogState.screenshotBase64, pendingActionFeedback);
          continue;
        }

        otp.attempts++;
        if (otp.attempts > 2) {
          throw new Error('OTP failed after 2 attempts. Aborting to prevent account lockout.');
        }
        if (otp.cachedOtp && otp.consumed) {
          // Code was entered AND consumed — genuine 2FA failure
          throw new Error('OTP entry failed — code was consumed but rejected. Aborting to prevent account lockout.');
        }

        // Either first request, or previous fill failed (code fetched but never consumed)
        if (!otp.relayPrepared) {
          log.log(`[Agent] OTP requested but relay not prepared — preparing on-demand`);
          await updateSessionStatus(sessionId, 'waiting_for_otp', 'OTP required — activating relay...');
          await prepareOtpRelay(sessionId, undefined, undefined, undefined, log);
          otp.relayPrepared = true;
          log.log(`[Agent] OTP relay now ready (on-demand)`);
        }

        otp.cachedOtp = await pollForOtp(sessionId, undefined, undefined, log);
        // One relay listening cycle has completed. A later resend or a distinct
        // restarted login flow must explicitly prime the relay again beforehand.
        otp.relayPrepared = false;
        otp.consumed = false;
        otp.fillAttempted = false;
        log.log(OTP_RECEIVED_LOG);

        // Pass OTP to the model on the next step via context injection
        otp.pendingForNextStep = otp.cachedOtp;
        await activePage.waitForTimeout(1000);
        const logState = await captureLogState(preActionUrl, preActionScreenshotBase64, preActionHtmlLength);
        await persistStepLog(logState.url, logState.screenshotBase64);
        continue;
      }

      if (step.action === 'reportData') {
        const currentProgress = {
          accounts: accountMap.size,
          transactions: transactionMap.size,
          positions: positionMap.size,
        };

        pendingActionFeedback = buildReportDataProgressFeedback(currentProgress);
        if (
          lastReportDataProgress
          && lastReportDataProgress.accounts === currentProgress.accounts
          && lastReportDataProgress.transactions === currentProgress.transactions
          && lastReportDataProgress.positions === currentProgress.positions
        ) {
          consecutiveStaleReports++;
          if (consecutiveStaleReports >= 3) {
            log.warn(`[Agent] ${consecutiveStaleReports} consecutive stale reportData calls — force-completing crawl`);
            const logState = await captureLogState(preActionUrl, preActionScreenshotBase64, preActionHtmlLength);
            await persistStepLog(logState.url, logState.screenshotBase64);
            finishReason = 'complete';
            break;
          }
          pendingRecoveryWarning = consecutiveStaleReports >= 2
            ? 'FINAL WARNING: Your reportData added no new data for the second time. ' +
              'The next stale report will auto-terminate the crawl. Use "complete" NOW if extraction is done, ' +
              'or navigate to a genuinely different page.'
            : 'WARNING: Your latest report step added no NEW unique accounts/transactions/positions. ' +
              'Do NOT repeat an identical report step on the same page. ' +
              'Either navigate to a different page for additional data, or use "complete" if extraction is done.';
        } else {
          consecutiveStaleReports = 0;
        }
        lastReportDataProgress = currentProgress;

        // reportData is metadata-only (no browser side effect).
        const logState = await captureLogState(preActionUrl, preActionScreenshotBase64, preActionHtmlLength);
        await persistStepLog(logState.url, logState.screenshotBase64);
        continue;
      }

      if (isOtpResendAction(step)) {
        log.log('[Agent] OTP resend requested — priming relay before executing resend action');
        otp.cachedOtp = null;
        otp.consumed = false;
        otp.fillAttempted = false;
        otp.pendingForNextStep = null;
        if (request.requires2fa && !otp.relayPrepared) {
          await updateSessionStatus(sessionId, 'waiting_for_otp', 'Preparing OTP relay before requesting a fresh code...');
          await prepareOtpRelay(sessionId, undefined, undefined, undefined, log);
          otp.relayPrepared = true;
          log.log('[Agent] OTP relay ready before resend action');
        }
      }

      // Execute browser action with error recovery
      let actionResult: ActionResult = { status: 'success', matchCount: 0 };
      try {
        actionResult = await executeAction(activePage, asExecutableStep(step), credentials, otp.cachedOtp ?? undefined, log);
        consecutiveErrors = 0;
        consecutiveSelectorNotFoundErrors = 0;
        ambiguousSelectorRetries = 0;

        const usedOtpPlaceholder = step.action === 'fill' && getStepValue(step) === 'OTP_CODE';
        if (usedOtpPlaceholder) {
          otp.fillAttempted = true;
        }
        if (shouldResetOtpAfterAction(step)) {
          otp.cachedOtp = null;
          otp.consumed = false;
          otp.fillAttempted = false;
        } else if (shouldConsumeOtpAfterAction({
          action: step.action,
          description: step.description,
          usedOtpPlaceholder,
          otpFillAttempted: otp.fillAttempted,
        })) {
          otp.consumed = true;
          otp.fillAttempted = false;
        }

      } catch (execError) {
        const loopState: LoopState = {
          goal, otp, consecutiveErrors, consecutiveSelectorNotFoundErrors, ambiguousSelectorRetries,
          pendingRecoveryWarning, pendingActionFeedback, pendingSpreadsheetText,
          lastReportDataProgress, consecutiveStaleReports,
        };
        const recoveryCtx: RecoveryContext = {
          sessionId, request, credentials, session, log, downloadTracker,
          accountMap, transactionMap, positionMap, allMemoryNotes,
          capturePageState: (page: Page) => capturePageState(page, log, otp.cachedOtp),
          captureLogState, persistStepLog,
        };

        const recovery = await recoverFromActionError(execError, activePage, loopState, recoveryCtx);

        // Sync mutable state back from recovery
        goal = loopState.goal;
        consecutiveErrors = loopState.consecutiveErrors;
        consecutiveSelectorNotFoundErrors = loopState.consecutiveSelectorNotFoundErrors;
        ambiguousSelectorRetries = loopState.ambiguousSelectorRetries;
        pendingRecoveryWarning = loopState.pendingRecoveryWarning;
        pendingActionFeedback = loopState.pendingActionFeedback;
        pendingSpreadsheetText = loopState.pendingSpreadsheetText;
        lastReportDataProgress = loopState.lastReportDataProgress;
        consecutiveStaleReports = loopState.consecutiveStaleReports;

        switch (recovery.type) {
          case 'continue': continue;
          case 'break': finishReason = recovery.finishReason; break;
          case 'throw': throw recovery.error;
        }
        if (finishReason) break;
      }

      // Wait for page stability after each action
      await waitForStability(activePage, 10_000);

      // Check if the action triggered a file download (e.g. XLSX export)
      // Done AFTER waitForStability so async downloads have time to fire
      const spreadsheetText = await checkForSpreadsheetDownload(downloadTracker, log);
      if (spreadsheetText) pendingSpreadsheetText = spreadsheetText;

      const postActionLogState = await captureLogState(preActionUrl, preActionScreenshotBase64, preActionHtmlLength);
      const actionFeedback = buildActionFeedback(step, preActionUrl, preActionHtmlLength, postActionLogState.url, postActionLogState.htmlLength, actionResult, !!spreadsheetText);
      // §2: tell the model when the gate refused a request it caused. Without this the page merely
      // looks broken and the model retries the same route.
      const blockedWrites = writeGate?.drainBlocked() ?? [];
      const combinedFeedback = blockedWrites.length > 0
        ? `${actionFeedback}\n${buildBlockedWriteFeedback(blockedWrites)}`
        : actionFeedback;
      pendingActionFeedback = combinedFeedback;
      log.log(`[Agent] ${combinedFeedback}`);
      await persistStepLog(postActionLogState.url, postActionLogState.screenshotBase64, combinedFeedback);

      // Warn the model when a force/jsClick had no visible effect on the page
      if (actionResult.status === 'fallback') {
        const selector = getStepSelector(step);
        const urlChanged = preActionUrl !== postActionLogState.url;
        const htmlDelta = postActionLogState.htmlLength - preActionHtmlLength;
        if (!urlChanged && Math.abs(htmlDelta) < 100) {
          pendingRecoveryWarning =
            `WARNING: Your click on "${selector}" required ${actionResult.clickMethod} (normal click failed: ${actionResult.normalClickError}). ` +
            `The page did not change after the click. Before proceeding, use getScreenshot or readHtml to verify ` +
            `the click had the intended effect. If it did not, use a different approach.`;
        }
      }
      continue;
    }

    // Check limits
    if (stepCount >= maxSteps) {
      log.warn(`[Agent] Hit max steps limit (${maxSteps})`);
      finishReason ??= 'max_steps';
    }
    if (Date.now() >= deadline) {
      log.warn(`[Agent] Hit timeout (${timeoutSeconds}s)`);
      finishReason = 'timeout';
    }

    // Data is already deduplicated via Maps — just materialize arrays
    const dedupedAccounts = allAccounts();
    const dedupedTransactions = allTransactions();
    const dedupedPositions = allPositions();
    const outcome = determineCrawlOutcome({
      finishReason: finishReason ?? 'timeout',
      accountsCount: dedupedAccounts.length,
      transactionsCount: dedupedTransactions.length,
      positionsCount: dedupedPositions.length,
      maxSteps,
      timeoutSeconds,
    });

    const crawlMemory = buildCrawlMemory(allMemoryNotes);

    // Calculate total cost from accumulated token usage
    const cost = calculateCost(session.getModelId(), session.getUsage());
    log.log(`[Agent] Crawl ${outcome.success ? 'succeeded' : 'failed'}: ` +
      `${dedupedAccounts.length} accounts, ${dedupedTransactions.length} transactions, ${dedupedPositions.length} positions`);
    log.log(`[Agent] Total tokens: in=${cost.inputTokens} out=${cost.outputTokens} cache_create=${cost.cacheCreationInputTokens} cache_read=${cost.cacheReadInputTokens} | Cost: $${cost.totalCostUsd.toFixed(4)}`);
    if (crawlMemory) {
      log.log(`[Agent] Crawl memory: ${allMemoryNotes.length} notes stored`);
    }

    await flushSessionLogs(sessionId, log.getLines());

    return {
      success: outcome.success,
      accounts: dedupedAccounts.length > 0 ? dedupedAccounts : undefined,
      transactions: dedupedTransactions.length > 0 ? dedupedTransactions : undefined,
      positions: dedupedPositions.length > 0 ? dedupedPositions : undefined,
      ...(outcome.error && { error: outcome.error }),
      // A non-thrown failure (timeout/max_steps/empty completion) isn't a known
      // transport class — classify the outcome error so the session still gets a
      // reason (internal_error here) rather than an absent field.
      ...(outcome.success ? {} : { failureReason: classifyCrawlFailure(new Error(outcome.error ?? 'crawl failed')) }),
      stepsExecuted: stepCount,
      stepLogs,
      cost,
      crawlMemory,
    };
  } catch (error) {
    // Calculate cost even on failure — partial crawls still consume tokens
    const cost = calculateCost(session.getModelId(), session.getUsage());
    log.log(`[Agent] Cost (on error): $${cost.totalCostUsd.toFixed(4)} | in=${cost.inputTokens} out=${cost.outputTokens}`);

    if (error instanceof CrawlCancelledError) {
      log.log(`[Agent] Crawl cancelled at step ${stepCount}`);
      await flushSessionLogs(sessionId, log.getLines());
      return {
        success: false,
        accounts: accountMap.size > 0 ? allAccounts() : undefined,
        transactions: transactionMap.size > 0 ? allTransactions() : undefined,
        positions: positionMap.size > 0 ? allPositions() : undefined,
        error: 'Cancelled by admin',
        stepsExecuted: stepCount,
        stepLogs,
        cost,
        crawlMemory: buildCrawlMemory(allMemoryNotes),
      };
    }

    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = safeBrowserUrlsInText(rawMessage);
    const failureReason = classifyCrawlFailure(error);
    log.error(`[Agent] Crawl failed at step ${stepCount} (reason=${failureReason}):`, message);
    await flushSessionLogs(sessionId, log.getLines());

    return {
      success: false,
      accounts: accountMap.size > 0 ? allAccounts() : undefined,
      transactions: transactionMap.size > 0 ? allTransactions() : undefined,
      positions: positionMap.size > 0 ? allPositions() : undefined,
      error: message,
      failureReason,
      stepsExecuted: stepCount,
      stepLogs,
      cost,
      crawlMemory: buildCrawlMemory(allMemoryNotes),
    };
  }
}

/**
 * Deduplicate memory notes by key (last write wins) and serialize to string.
 */
function buildCrawlMemory(notes: Array<{ key: string; value: string }>): CrawlMemory | undefined {
  if (notes.length === 0) return undefined;
  const memoryMap = new Map<string, string>();
  for (const note of notes) {
    memoryMap.set(note.key, safeBrowserUrlsInText(note.value));
  }
  return Array.from(memoryMap.entries()).map(([k, v]) => `${k}: ${v}`).join('\n');
}

/**
 * Build context about what data we've already collected.
 */
export function buildDataContext(
  accounts: NormalizedAccount[],
  transactions: NormalizedTransaction[],
  positions: NormalizedPosition[],
): string {
  const parts: string[] = [];
  if (accounts.length > 0) {
    parts.push(
      `Already extracted ${accounts.length} account(s) — when reporting a transaction for one of these, its `
      + `providerAccountId MUST be the EXACT id shown here (never the name): `
      + accounts.map(a =>
        `${a.name} (${a.currency}, balance=${a.balance}) → providerAccountId "${a.providerAccountId}"`,
      ).join('; '),
    );
  }
  if (transactions.length > 0) {
    const trustworthyReferences = transactions
      .filter(transaction => isTrustworthyProviderTransactionId(transaction.providerTransactionId))
      .map(transaction =>
        `${transaction.providerAccountId ?? '(unknown account)'}/${transaction.providerTransactionId}`,
      );
    parts.push(
      `Already extracted ${transactions.length} transaction occurrence(s)`
      + (trustworthyReferences.length > 0
        ? `; observed row-unique references: ${trustworthyReferences.join(', ')}`
        : ''),
    );
  }
  if (positions.length > 0) {
    const includeNumericDetail = positions.length <= 60;
    parts.push(
      `Already extracted ${positions.length} position(s): `
      + positions.map(p =>
        `${p.symbol ?? p.name} → providerPositionId "${p.providerPositionId}", `
        + `providerAccountId "${p.providerAccountId ?? '(unknown)'}"`
        + (includeNumericDetail ? `, qty=${p.quantity}, value=${p.valueNative} ${p.currency}` : ''),
      ).join('; '),
    );
    parts.push('Do not re-report these exact observed rows unless correcting a specific field');
  }
  return parts.join('. ');
}


/**
 * Facts-only FK feedback: every position must carry the providerAccountId of an
 * account reported this session (accounts are always reported before positions —
 * the backend integrity gate rejects the reverse ordering). A position whose FK
 * matches no reported account cannot be attributed, reconciled, or safely swept,
 * and storage quarantines it. States the mismatched ids and the valid roster —
 * facts and arithmetic only, no strategy, no forced action.
 */
export function buildPositionAccountFkFeedback(
  stepPositions: NormalizedPosition[],
  accounts: NormalizedAccount[],
): string | null {
  if (stepPositions.length === 0 || accounts.length === 0) return null;
  const validIds = new Set(accounts.map((a) => a.providerAccountId));
  const unknown = [...new Set(
    stepPositions
      .map((p) => p.providerAccountId)
      .filter((id): id is string => !!id && !validIds.has(id)),
  )];
  if (unknown.length === 0) return null;
  return (
    `Position rows reference providerAccountId value(s) [${unknown.join(', ')}] that match none of the ` +
    `accounts reported this session. The accounts reported so far have providerAccountId values: ` +
    `[${[...validIds].join(', ')}]. Each position row's providerAccountId must be copied verbatim from ` +
    `the account it belongs to; rows with an unknown account id cannot be stored.`
  );
}

/** Decomposition headroom (mirrors the backend gate). Σ|holdings| for an
 *  account cannot exceed its balance by more than this on the crawler path. */
const RECONCILIATION_MAX_RATIO = 1.25;

/**
 * Facts-only reconciliation feedback: positions decompose their account, so
 * Σ|holdings| ≈ balance. When a balance-history / policy-statement table was
 * captured as holdings (they sum to a MULTIPLE of the account balance), report
 * the arithmetic so the model re-extracts only the current holdings. Same-
 * currency only (the crawler has no FX here); attribution via providerAccountId
 * with a sole-account fallback. Returns feedback text for the first violating
 * account, or null. Facts + arithmetic only — no strategy, no forced action.
 */
export function buildPositionReconciliationFeedback(
  positions: NormalizedPosition[],
  accounts: NormalizedAccount[],
): string | null {
  if (positions.length === 0 || accounts.length === 0) return null;
  const acctById = new Map(accounts.map((a) => [a.providerAccountId, a]));
  const soleAccount = accounts.length === 1 ? accounts[0] : null;
  const agg = new Map<string, { sum: number; count: number }>();
  for (const p of positions) {
    const acct = (p.providerAccountId && acctById.get(p.providerAccountId)) || soleAccount;
    if (!acct) continue;
    if (p.currency !== acct.currency) continue; // no FX in-crawl → same-currency only
    if (!Number.isFinite(p.valueNative)) continue;
    const e = agg.get(acct.providerAccountId) ?? { sum: 0, count: 0 };
    // SIGNED sum, mirroring the backend gate exactly: positions decompose the account
    // as a signed total (Σ value = balance), so a legitimate negative cash/short line
    // nets DOWN the sum. Summing |values| would false-flag e.g. 60+40−30=70 as 1.86×
    // and nag the model into pruning real holdings. Over-extraction (a history table
    // of positive balances) still trips: its signed sum is a multiple of the balance.
    e.sum += p.valueNative;
    e.count += 1;
    agg.set(acct.providerAccountId, e);
  }
  for (const [pid, { sum: signedSum, count }] of agg) {
    if (count < 2) continue;
    const acct = acctById.get(pid)!;
    const bal = Math.abs(acct.balance);
    if (!(bal > 0.01)) continue;
    const sum = Math.abs(signedSum);
    const ratio = sum / bal;
    if (ratio > RECONCILIATION_MAX_RATIO) {
      const round2 = (n: number) => Math.round(n * 100) / 100;
      return (
        `RECONCILIATION_CHECK: the ${count} positions you reported for account "${acct.name}" sum to ` +
        `${round2(sum)} ${acct.currency}, but that account's balance is ${round2(acct.balance)} ${acct.currency} ` +
        `(${ratio.toFixed(1)}× the balance). Positions are the holdings that MAKE UP an account, so they must ` +
        `sum to about its balance — not a multiple of it. A balance-over-time / monthly-history table or a ` +
        `policy statement (opening + closing balances, coverage payouts, fees) produces this. Re-report only the ` +
        `current holdings for that account so they reconcile to its balance; for a single-value accumulation ` +
        `fund the current value IS the account balance.`
      );
    }
  }
  return null;
}

export function goalToDescription(goal: AgentGoal, dataContext: string): string {
  switch (goal) {
    case 'login':
      return 'Log in to the banking website. Fill in credentials and submit the login form. Once you can see the main dashboard or home page (login succeeded), use "loginComplete".';
    case 'extract':
      return dataContext
        ? `Navigate the site and extract financial data. ${dataContext}. You are already logged in, so do NOT use "loginComplete" again. If you need to re-authenticate — whether because the session was lost, the OTP was rejected, or any other reason — you MUST use "loginFlowRestarted" before submitting a form that triggers a new OTP. This resets the OTP state so the system waits for the fresh code. Without it, the system will reuse the stale code from your previous login attempt. Report extracted data with "reportData", then use "complete" only when you've extracted everything available.`
        : 'Navigate the site and extract all available financial data (accounts, transactions, positions). You are already logged in, so do NOT use "loginComplete" again. If you need to re-authenticate — whether because the session was lost, the OTP was rejected, or any other reason — you MUST use "loginFlowRestarted" before submitting a form that triggers a new OTP. This resets the OTP state so the system waits for the fresh code. Without it, the system will reuse the stale code from your previous login attempt. Report extracted data with "reportData", then use "complete" when done.';
    default:
      return goal;
  }
}

export function goalToStatus(goal: AgentGoal): 'logging_in' | 'navigating' | 'extracting' {
  switch (goal) {
    case 'login': return 'logging_in';
    case 'extract': return 'extracting';
    default: return 'navigating';
  }
}

/**
 * Deduplicate an array by a key function, keeping the last occurrence.
 */
export function deduplicateByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return Array.from(map.values());
}

type CrawlFinishReason = 'complete' | 'timeout' | 'max_steps';

export function positionDedupKey(position: NormalizedPosition): string {
  const providerPositionId = position.providerPositionId?.trim();
  if (providerPositionId) {
    return `id:${JSON.stringify([position.providerAccountId ?? '', providerPositionId])}`;
  }
  return [
    'fallback',
    position.providerAccountId,
    position.symbol,
    position.name,
    position.quantity,
    position.currency,
  ].join('|');
}

export function determineCrawlOutcome(opts: {
  finishReason: CrawlFinishReason;
  accountsCount: number;
  transactionsCount: number;
  positionsCount: number;
  maxSteps: number;
  timeoutSeconds: number;
}): { success: boolean; error?: string } {
  const extractedSomeData = opts.accountsCount > 0 || opts.transactionsCount > 0 || opts.positionsCount > 0;

  if (opts.finishReason === 'complete') {
    if (extractedSomeData) {
      return { success: true };
    }
    return {
      success: false,
      error: 'Agent completed without extracting any financial data.',
    };
  }

  if (opts.finishReason === 'max_steps') {
    return {
      success: false,
      error: `Crawl stopped after reaching max steps (${opts.maxSteps}) before explicit completion.`,
    };
  }

  return {
    success: false,
    error: `Crawl timed out after ${opts.timeoutSeconds}s before explicit completion.`,
  };
}

/**
 * Thrown when the model terminates the crawl via the error action. Carries the
 * model's structured classification of WHY (it saw the page — it is the best
 * source for "this is a bot-block page" vs "the site is closed right now").
 */
export class AgentTerminalError extends Error {
  constructor(message: string, public readonly category?: StepErrorCategory) {
    super(message);
    this.name = 'AgentTerminalError';
  }
}

/** Map the model's structured step_error category onto the platform failure taxonomy. */
const FAILURE_REASON_BY_ERROR_CATEGORY: Record<Exclude<StepErrorCategory, 'other'>, CrawlFailureReason> = {
  access_blocked: 'waf_block',
  outside_operating_hours: 'outside_hours',
  credentials_rejected: 'bank_login_failed',
  site_unavailable: 'site_unavailable',
};

/**
 * Classify a terminal crawl error into a CrawlFailureReason. Two sources, in
 * priority order: (1) the model's structured step_error category — the model
 * saw the page, so when it explicitly classified the failure we trust it;
 * (2) transport/outcome signatures for failures the model never saw (API
 * drift, timeouts, relay outages). Deliberately narrow on the signature side:
 * only label a reason we can identify confidently; everything else is
 * internal_error. This drives observability/alerting (e.g. api_contract_drift
 * surfaces a schema-drift outage immediately) — it never changes crawl behavior.
 */
export function classifyCrawlFailure(error: unknown): CrawlFailureReason {
  if (error instanceof ApiContractError) {
    return 'api_contract_drift';
  }

  if (error instanceof AgentTerminalError && error.category && error.category !== 'other') {
    return FAILURE_REASON_BY_ERROR_CATEGORY[error.category];
  }

  const message = error instanceof Error ? error.message : String(error);

  if (isApiContractDriftMessage(message)) {
    return 'api_contract_drift';
  }
  // The OTP relay app (the user's phone) never came online, or came online but
  // never became ready — distinct from a verification code that arrived late
  // (otp_timeout).
  //
  // This pattern must match what the platforms actually throw, and it did not.
  // Every alternative here required the literal word "app", but only
  // A hosted platform calls it the "OTP relay app"; platform/remote.ts (hosted — the
  // one production runs) and platform/postgres.ts (self-host) both say "OTP
  // relay did not come online within Nms". Neither matched, so a phone that was
  // simply asleep was recorded as internal_error. A real scheduled crawl failed
  // that way on 2026-08-11T09:56Z and was filed as an internal defect.
  //
  // The "did not become ready" case had never been matched by anything at all.
  //
  // otp-relay-classification.test.ts pins the literal strings all three
  // platforms throw, so this cannot silently drift apart from them again.
  if (
    /OTP relay(?: app)? did not (?:come online|become ready)/i.test(message)
    || /relay app.*(offline|unreachable)/i.test(message)
    || /OTP relay.*not (online|available)/i.test(message)
  ) {
    return 'otp_relay_unreachable';
  }
  // OTP wait exceeded, or OTP attempts exhausted waiting for a code.
  if (/OTP timeout|OTP failed after/i.test(message)) {
    return 'otp_timeout';
  }
  // The model terminates with an "outside operating hours" error action.
  if (/outside operating hours/i.test(message)) {
    return 'outside_hours';
  }
  // Navigation that never responded (e.g. WAF tarpit) — page.goto/waitForNavigation
  // timeout. Checked before page_capture_timeout so a navigation timeout isn't
  // mislabeled as a capture timeout.
  if (/(goto|navigat|waitForNavigation|waitForURL|net::ERR).*?(timeout|timed out)|(timeout|timed out).*?(goto|navigat|waitForNavigation|waitForURL)/i.test(message)) {
    return 'navigation_timeout';
  }
  // Navigation failed at the connection level without a timeout token — e.g.
  // the tunnel's bounded SOCKS connect failing fast (net::ERR_SOCKS_CONNECTION_FAILED)
  // or the target refusing/resetting the connection. The site (or the path to
  // it) is unreachable; without this the failure hides as internal_error.
  if (/(goto|navigat).*?net::ERR_(SOCKS_CONNECTION_FAILED|CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT)|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|EMPTY_RESPONSE)/i.test(message)) {
    return 'site_unavailable';
  }
  // A page capture (screenshot / page content / evaluate) timed out on a heavy
  // or unstable DOM. Matches the withTimeout labels and Playwright screenshot timeouts.
  if (/capturePageState|takeScreenshot|getPageContent|screenshot.*?timeout|timeout.*?screenshot|timed out/i.test(message)) {
    return 'page_capture_timeout';
  }
  return 'internal_error';
}

function isTrustworthyProviderTransactionId(id: string | undefined): id is string {
  if (!id) return false;
  const normalized = id.trim().toUpperCase();
  return normalized !== ''
    && normalized !== 'NONE'
    && !normalized.startsWith('CONTENT:')
    && !normalized.startsWith('OCCURRENCE:');
}

export function transactionDedupKey(tx: NormalizedTransaction): string {
  const id = tx.providerTransactionId?.trim();
  if (id && id.toUpperCase() !== 'NONE') {
    // Scoped by ACCOUNT: bank references are unique per account, not per connection —
    // two cards can legitimately show the same reference number, and the backend
    // stores them under accountId+id. An unscoped `id:REF-1` collapsed them here.
    return `id:${tx.providerAccountId ?? ''}:${id}`;
  }
  return [
    'fallback',
    tx.providerAccountId,
    tx.bookingDate,
    tx.amount,
    tx.currency,
    tx.description,
    tx.merchant ?? '',
    tx.providerCategory ?? '',
    tx.isPending ? 'pending' : 'posted',
    // A Rule-4 status UPDATE (existingCanonicalId set) and a genuinely NEW row can share
    // every content field — they are different records and must never collapse to one key.
    tx.existingCanonicalId ?? '',
  ].join('|');
}

/**
 * Accumulate one step's reported transactions into the crawl-wide dedup map.
 *
 * Cross-step, the map's job is to collapse RE-REPORTS of the same row (the model
 * re-reading a page it already extracted) — the latest report wins, silently.
 *
 * WITHIN one step's batch, the model is NOT allowed to list the same no-id transaction
 * twice (prompt rule 26b): N genuinely identical page rows must be ONE entry with
 * `count: N`. So an in-batch repeat is an accidental re-listing — a stutter — and it
 * COLLAPSES (keeping the largest explicit `count` claim), with a loud warning. The old
 * design ordinal-suffixed in-batch repeats into separate rows, which turned a stutter
 * into a stored phantom ("Regular Premium" £1,693.45 twice — incident 2026-07-16).
 * A real second identical charge is preserved exactly one way: the model's deliberate
 * `count` claim, materialized by [expandTransactionCounts] at hand-off.
 *
 * Rows WITH a real bank id never carry `count`: a bank reference uniquely identifies
 * one transaction, so the same id twice in one batch is the same physical row rendered
 * twice (responsive desktop+mobile markup) — collapsing it is correct.
 */
export function accumulateStepTransactions(
  map: Map<string, NormalizedTransaction>,
  stepTransactions: NormalizedTransaction[],
  log?: { log: (msg: string) => void },
  /** Crawl-wide set of `id:` keys PROVEN non-unique on this statement.
   *  Some institutions reuse their own transaction reference across different
   *  rows, so treating that reference as an identity makes last-wins silently
   *  discard a real movement — observed against a live account, where two
   *  distinct rows on consecutive days shared one reference and one of them
   *  vanished. Once a ref is demoted it stays demoted for the whole crawl (a
   *  later step re-reporting one of its rows alone must not re-mint the id
   *  identity). The caller owns one set per crawl. */
  demotedIdKeys?: Set<string>,
): void {
  // Stutter identity = rule 26b's fields EXACTLY (account, date, amount, currency, description,
  // + the Rule-4/new separation). Deliberately EXCLUDES merchant/providerCategory/isPending: the
  // backend's content identity ignores them too, so two entries differing only in optional
  // metadata land on the SAME contentKey and would still mint two documents — a stutter must not
  // escape collapse by varying a field the storage identity never sees (codex F1).
  const stutterKey = (tx: NormalizedTransaction): string => [
    'stutter', tx.providerAccountId, tx.bookingDate, tx.amount, tx.currency,
    tx.description, tx.existingCanonicalId ?? '',
  ].join('|');
  const seenThisBatch = new Map<string, string>(); // stutterKey → map key of the first occurrence
  // Queue (not a plain loop) so a demotion can requeue BOTH rows of a proven
  // non-unique reference through the no-id path below.
  const queue = [...stepTransactions];
  while (queue.length > 0) {
    const raw = queue.shift()!;
    let tx = raw;
    let base = transactionDedupKey(tx);
    if (base.startsWith('id:')) {
      if (demotedIdKeys?.has(base)) {
        // Reference already proven non-unique this crawl — id identity is
        // meaningless for it. Strip the pid so the row takes the content
        // path here AND at the backend (which would otherwise re-collide
        // both rows onto one hash(account:ref) doc).
        tx = { ...tx, providerTransactionId: 'NONE' };
        base = transactionDedupKey(tx);
      } else {
        const prev = map.get(base);
        const sameRow = !prev || (prev.bookingDate === tx.bookingDate
          && prev.amount === tx.amount && prev.currency === tx.currency);
        if (sameRow) {
          map.set(base, tx); // same physical row re-rendered/re-read: latest wins
          continue;
        }
        // TUPLE MISMATCH under one id: the statement itself proves the
        // reference is not a transaction id (prompt rule 25 — a value shared
        // by multiple rows is not an id). Demote EVERY row bearing it —
        // including the one already accumulated — to content identity, keep
        // both, and remember the demotion crawl-wide. Facts logged loudly.
        demotedIdKeys?.add(base);
        map.delete(base);
        log?.log(
          `[Agent] WARN non-unique bank reference: "${raw.providerTransactionId}" appears on rows with different ` +
          `content (${prev.bookingDate} ${prev.amount} vs ${raw.bookingDate} ${raw.amount}) — per rule 25 it is not ` +
          `a transaction id. Keeping BOTH rows under content identity.`,
        );
        queue.unshift({ ...prev, providerTransactionId: 'NONE' },
                      { ...raw, providerTransactionId: 'NONE' });
        continue;
      }
    }
    const sk = stutterKey(tx);
    const firstKey = seenThisBatch.get(sk);
    if (firstKey !== undefined) {
      const prev = map.get(firstKey);
      map.set(firstKey, { ...tx, count: Math.max(prev?.count ?? 1, tx.count ?? 1) });
      if (firstKey !== base) map.delete(base); // metadata-variant copy must not survive separately
      log?.log(
        `[Agent] WARN rule-26b violation: identical transaction listed twice in one batch — collapsed to one ` +
        `(${tx.bookingDate} ${tx.amount} ${tx.currency} "${(tx.description ?? '').slice(0, 30)}"). ` +
        `Genuine identical multiples must be claimed via count.`,
      );
      continue;
    }
    seenThisBatch.set(sk, base);
    map.set(base, tx); // cross-step re-read of the same row: latest wins, as before
  }
}

/**
 * Materialize explicit `count` multiplicity claims (prompt rule 26b) into N identical rows
 * for the backend hand-off — the backend's in-batch content ordinals then store N distinct
 * documents, exactly as when N rows arrived individually. The claim is deliberate model
 * testimony ("the page shows N identical rows"); a pathological claim is capped LOUDLY,
 * never silently.
 */
export function expandTransactionCounts(
  txs: NormalizedTransaction[],
  log?: { log: (msg: string) => void },
): NormalizedTransaction[] {
  const MAX_IDENTICAL_MULTIPLICITY = 10; // >10 identical same-day id-less rows is pathology, not a statement
  return txs.flatMap((tx) => {
    const { count, ...rest } = tx;
    let n = Math.max(1, Math.floor(count ?? 1));
    if (n > MAX_IDENTICAL_MULTIPLICITY) {
      log?.log(
        `[Agent] ERROR count=${n} exceeds the identical-multiplicity bound (${MAX_IDENTICAL_MULTIPLICITY}) — capping LOUDLY ` +
        `(${tx.bookingDate} ${tx.amount} ${tx.currency} "${(tx.description ?? '').slice(0, 30)}"). Verify against the statement.`,
      );
      n = MAX_IDENTICAL_MULTIPLICITY;
    }
    return Array.from({ length: n }, () => ({ ...rest }));
  });
}

export function getStepSelector(step: StepResponse): string | undefined {
  if ('selector' in step) return step.selector;
  return undefined;
}

/**
 * Post-reportData progress feedback injected into the next model turn.
 *
 * Restates the system prompt's own completion conditions (rule 37a-style
 * sanity checks) at the decision point instead of unconditionally pushing
 * "complete" — an empty report that followed a failed action must not be
 * nudged into completion. Prompt-text only: the model still decides.
 */
export function buildReportDataProgressFeedback(progress: {
  accounts: number;
  transactions: number;
  positions: number;
}): string {
  return (
    `DATA_PROGRESS_JSON: ${JSON.stringify(progress)} ` +
    `If no NEW unique financial data remains AND your extraction passes the completion sanity checks ` +
    `(every investment account with a non-zero balance has positions; transaction views checked for each account; ` +
    `no product visible on the dashboard or navigation left unrecorded and unmentioned; ` +
    `no planned extraction such as a file export failed without a successful retry), use "complete". ` +
    `If a planned extraction failed, diagnose and re-attempt it before completing.`
  );
}

/**
 * Derive the action-describing fields of a step log from the step that was
 * ACTUALLY executed.
 *
 * When error recovery substitutes a different action for the model's original
 * step (e.g. a failed export click answered with a "wait" retry), the log must
 * record the executed substitute as its action — and preserve the original
 * failed action under `originalStep` so the audit trail shows both what was
 * attempted and what ran. Extraction counts likewise come from the executed
 * step, so data reported in a recovery retry is visible in the log.
 */
export function buildStepLogActionFields(
  step: StepResponse,
  executedStep: StepResponse = step,
): Pick<
  CrawlStepLog,
  | 'action' | 'description' | 'selector' | 'value' | 'ms' | 'direction' | 'amount'
  | 'navigateUrl' | 'memoryNotes' | 'accountsExtracted' | 'transactionsExtracted'
  | 'positionsExtracted' | 'originalStep'
> {
  const selector = getStepSelector(executedStep);
  const originalSelector = getStepSelector(step);
  return {
    action: executedStep.action,
    ...(executedStep.description && {
      description: safeBrowserUrlsInText(executedStep.description),
    }),
    ...(selector && { selector: safeBrowserUrlsInText(selector) }),
    ...(executedStep.value !== undefined && {
      value: safeBrowserUrlsInText(executedStep.value),
    }),
    ...(executedStep.ms !== undefined && { ms: executedStep.ms }),
    ...(executedStep.direction !== undefined && { direction: executedStep.direction }),
    ...(executedStep.amount !== undefined && { amount: executedStep.amount }),
    ...(executedStep.action === 'navigate' && executedStep.url !== undefined && {
      navigateUrl: safeBrowserUrl(executedStep.url),
    }),
    ...(executedStep.memoryNotes && executedStep.memoryNotes.length > 0 && {
      memoryNotes: executedStep.memoryNotes.map((note) => ({
        ...note,
        value: safeBrowserUrlsInText(note.value),
      })),
    }),
    accountsExtracted: executedStep.accounts.length,
    transactionsExtracted: executedStep.transactions.length,
    positionsExtracted: executedStep.positions.length,
    ...(executedStep !== step && {
      originalStep: {
        action: step.action,
        ...(step.description && {
          description: safeBrowserUrlsInText(step.description),
        }),
        ...(originalSelector && {
          selector: safeBrowserUrlsInText(originalSelector),
        }),
      },
    }),
  };
}

/** Browser/library feedback may embed the current URL in an error string. */
export function sanitizeStepLogActionFeedback(actionFeedback: string): string {
  return safeBrowserUrlsInText(actionFeedback);
}

export function getStepValue(step: StepResponse): string | undefined {
  if ('value' in step) return step.value;
  return undefined;
}

export function asExecutableStep(step: StepResponse): ExecutableStepResponse {
  switch (step.action) {
    case 'click':
    case 'fill':
    case 'select':
    case 'wait':
    case 'scroll':
    case 'navigate':
      return step as ExecutableStepResponse;
    default:
      throw new Error(`Non-executable action \"${step.action}\" was passed to executeAction`);
  }
}

export function buildActionFeedback(
  step: StepResponse,
  beforeUrl: string,
  beforeHtmlLength: number,
  afterUrl: string,
  afterHtmlLength: number,
  actionResult?: ActionResult,
  downloadCaptured?: boolean,
): string {
  const selector = getStepSelector(step);
  const urlChanged = beforeUrl !== afterUrl;
  const htmlDelta = afterHtmlLength - beforeHtmlLength;

  const warnings: string[] = [];
  const isFallback = actionResult?.status === 'fallback';

  // Force click / jsClick disclaimer
  if (isFallback) {
    const { clickMethod, normalClickError } = actionResult;
    if (clickMethod === 'force') {
      warnings.push(`Normal click failed (${normalClickError}); used force click which bypasses interception checks. Verify the click had the intended effect before proceeding.`);
    } else if (clickMethod === 'jsClick') {
      warnings.push(`Normal and force click both failed (${normalClickError}); used HTMLElement.click() as last resort. Verify the click had the intended effect before proceeding.`);
    }
  }

  // Determine status — uncertain when forced click had no visible effect
  const nothingChanged = !urlChanged && Math.abs(htmlDelta) < 100;
  let status: string = 'executed';
  if (isFallback && nothingChanged) {
    status = 'executed_uncertain';
    warnings.push('Click was forced but nothing on the page changed. The click may not have had the intended effect. Verify with getScreenshot or readHtml before repeating.');
  }

  const feedback: Record<string, unknown> = {
    status,
    action: step.action,
    selector,
    urlBefore: beforeUrl,
    urlAfter: afterUrl,
    urlChanged,
    htmlLengthBefore: beforeHtmlLength,
    htmlLengthAfter: afterHtmlLength,
    htmlDelta,
  };

  if (isFallback) {
    feedback.clickMethod = actionResult.clickMethod;
  }
  // Factual click provenance (2026-07-19, prod CAL misdiagnosis): a NORMAL
  // Playwright click only executes after actionability checks pass, so the
  // target was VISIBLE and ENABLED at click time. Stating this verified fact
  // prevents the model from reading a post-click disabled/spinner state as
  // "the button was disabled / credentials rejected" — the 07-19 CAL crawl
  // was terminated on exactly that misread seconds after a successful login
  // click. Facts only; the model decides what to do with them.
  if (step.action === 'click' && actionResult?.status === 'success') {
    feedback.clickProvenance =
      'normal click — target passed actionability checks (visible and ENABLED at click time)';
  }
  if (downloadCaptured !== undefined) {
    feedback.downloadCaptured = downloadCaptured;
  }
  if (warnings.length > 0) {
    feedback.warnings = warnings;
  }

  return `ACTION_FEEDBACK_JSON: ${JSON.stringify(feedback)}`;
}

function isSpreadsheetFilename(filename: string): boolean {
  const normalized = filename.toLowerCase();
  return normalized.endsWith('.xlsx') || normalized.endsWith('.xls');
}

export function shouldBlockWaitForOtp(cachedOtp: string | null, otpConsumed: boolean): boolean {
  return Boolean(cachedOtp && !otpConsumed);
}

const OTP_CONFIRMED_FILLED_TOKEN = 'OTP_CONFIRMED_FILLED';
const OTP_RESEND_REQUESTED_TOKEN = 'OTP_RESEND_REQUESTED';

export function shouldConsumeOtpAfterAction(opts: {
  action: StepResponse['action'];
  description?: string;
  usedOtpPlaceholder: boolean;
  otpFillAttempted: boolean;
}): boolean {
  if (opts.usedOtpPlaceholder) {
    return false;
  }
  if (!opts.otpFillAttempted) {
    return false;
  }
  if (opts.action === 'fill') {
    return false;
  }
  return Boolean(opts.description?.includes(OTP_CONFIRMED_FILLED_TOKEN));
}

export function shouldResetOtpAfterAction(opts: {
  action: StepResponse['action'];
  description?: string;
}): boolean {
  if (isOtpResendAction(opts)) {
    return true;
  }
  if (opts.action === 'fill') {
    return false;
  }
  return false;
}

export function shouldHonorLoginFlowRestarted(goal: AgentGoal): boolean {
  return goal === 'extract';
}

export function isOtpResendAction(opts: {
  action: StepResponse['action'];
  description?: string;
}): boolean {
  if (opts.action === 'fill') {
    return false;
  }
  return Boolean(opts.description?.includes(OTP_RESEND_REQUESTED_TOKEN));
}

/**
 * Feedback for state-changing requests the §2 write gate refused. The gate aborts the request at the
 * network layer, so without this the page merely appears broken and the model retries the same route
 * or hunts for another one. Naming the refusal turns a silent failure into a rule the model can
 * follow for the rest of the crawl.
 */
export function buildBlockedWriteFeedback(blocked: string[]): string {
  const plural = blocked.length > 1;
  return [
    `ACTION_FEEDBACK_JSON: ${JSON.stringify({
      status: 'blocked',
      action: 'stateChangingRequest',
      blocked,
    })}`,
    `This crawl is READ-ONLY. ${plural ? `${blocked.length} state-changing requests were` : 'A state-changing request was'} blocked before leaving the browser: ${blocked.join('; ')}.`,
    'Do not retry it and do not look for another route to the same operation. Never confirm a transfer, payment, order, trade, beneficiary change, or account change. Go back and continue extracting data.',
  ].join(' ');
}

export function buildBlockedWaitForOtpFeedback(): string {
  return [
    `ACTION_FEEDBACK_JSON: ${JSON.stringify({
      status: 'blocked',
      action: 'waitForOtp',
      reason: 'OTP already cached but not consumed; skipping duplicate OTP polling.',
    })}`,
    'waitForOtp was ignored because a cached OTP is pending submission. Either verify the current field is filled and submit using a description that includes OTP_CONFIRMED_FILLED, or explicitly request a new code with OTP_RESEND_REQUESTED before calling waitForOtp again.',
  ].join(' ');
}
