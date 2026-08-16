abstract final class CompanionCopy {
  static const appName = 'Accrawl Companion';
  static const pairPhone = 'Pair this phone';
  static const pairingExplanation =
      "Scan the pairing QR code in your Accrawl console, or enter the console address and pairing code by hand. Check that the address is your own console before continuing. Pairing gives this phone access only to connections you select in the console. For those connections, it can access financial data, relay bank SMS codes, and optionally route crawls through its network.";
  static const scanPairingQr = 'Scan pairing QR code';
  static const enterByHand = 'Or enter the details by hand';
  static const consoleAddress = 'Console address (starts with https://)';
  static const pairingCode = 'Pairing code (starts with acpair_)';
  static const continueAction = 'Continue';
  static const confirmVerification =
      'Compare this verification code with the code shown in the Accrawl console. Approve this phone there only if every digit matches.';
  static const waitingForApproval =
      'Waiting for approval in the Accrawl console. Approve this phone only if every digit matches.';
  static const cancelPairing = 'Cancel pairing';
  static const pairingExpired =
      'That pairing request expired. Create a new one in the Accrawl console.';
  static const pairingUsed =
      'That pairing request has already been used. Create a new one in the Accrawl console.';
  static const unexpectedConsole =
      "That address didn't respond like an Accrawl console. Check the address and try again.";
  static const consoleUnreachable =
      "Couldn't connect to your Accrawl console. Check the address and your network, then try again.";
  static const screenLockRequired =
      "Set a screen lock on this phone, then try again. Accrawl Companion uses it to protect this phone's financial access.";
  static const cameraRequired =
      'Camera access is needed to scan the pairing QR code. Allow it in Settings, or go back and enter the details by hand.';
  static const qrNotFound =
      'No QR code found. Hold the camera steady and keep the whole code inside the frame.';
  static const invalidQr = 'This QR code is not an Accrawl pairing request.';
  static const cancel = 'Cancel';

  static const unlockFinancialData = 'Unlock financial data';
  static const unlockExplanation =
      "Use this phone's screen lock to view accounts, balances, and transactions.";
  static const unlock = 'Unlock';
  static const memoryProtection =
      'Financial data stays available while you’re using the app and is cleared after five minutes of inactivity. It is never saved on this phone.';
  static const unlockFailed = "Couldn't unlock financial data. Try again.";
  static const financialDataLocked = 'Financial access unavailable';
  static const invalidFinancialAccess =
      "This phone's financial access is no longer valid. If this phone is still listed in the Accrawl console, revoke it there. Then pair this phone again.";
  static const httpsRequired =
      "Accrawl Companion requires HTTPS for financial data. Use an https:// console address, or fix the console's TLS configuration.";
  static const loadFailed =
      "Couldn't load financial data. Refresh to try again.";

  static const accounts = 'Accounts';
  static const transactions = 'Transactions';
  static const relay = 'Relay';
  static const hideAmounts = 'Hide amounts';
  static const showAmounts = 'Show amounts';
  static const amountHidden = 'Amount hidden';
  static const noAccounts = 'No accounts yet';
  static const noAccountsHelp =
      'In the Accrawl console, run a crawl for a connection selected for this phone, then refresh. Any accounts found will appear here.';
  static const noTransactions = 'No transactions yet';
  static const noTransactionsHelp =
      'In the Accrawl console, run a crawl for a connection selected for this phone, then refresh. Any transactions found will appear here.';
  static const noAccountTransactions = 'No transactions for this account yet';
  static const refresh = 'Refresh';
  static const inactive =
      'Not found in at least two consecutive complete crawls';
  static const currentBalance = 'Current balance';
  static const amountOwed = 'Amount owed';
  static const availableBalance = 'Available balance';
  static const availableCredit = 'Available credit';
  static const creditLimit = 'Credit limit';
  static const unknownAccount = 'Unknown account';
  static const unassignedTransaction = 'Unassigned transaction';
  static const pending = 'Pending';
  static const posted = 'Posted';
  static const loadMore = 'Load more';
  static const completed = 'Completed';
  static const failed = 'Failed';
  static const cancelled = 'Cancelled';
  static const waitingForTwoFactorCode = 'Waiting for an SMS code';
  static const crawling = 'Crawling';
  static const justNow = 'just now';
  static const recentCrawls = 'Recent crawls';
  static const noRecentCrawls =
      'Run a crawl in the Accrawl console for a selected connection to see its status here.';
  static const crawlSteps = 'Steps';
  static const crawlScreenshots = 'Screenshots';
  static const crawlResults = 'Results';
  static const started = 'Started';
  static const duration = 'Duration';
  static const status = 'Status';
  static const noCrawlSteps = 'No steps were recorded for this crawl.';
  static const noCrawlScreenshots =
      'No screenshots were captured for this crawl.';
  static const noCrawlResults =
      'This crawl did not return any accounts, transactions, or positions.';
  static const crawlDetailsFailed = 'Couldn’t load crawl details';
  static const crawlDetailsFailedHelp =
      'Check your internet connection and try again.';
  static const tryAgain = 'Try again';
  static const loadingScreenshot = 'Loading screenshot…';
  static const screenshotFailed = 'Couldn’t load this screenshot.';
  static const positions = 'Positions';
  static const crawlDetailsHint =
      'Opens steps, screenshots, and results for this crawl';

  static const phoneAccess = 'Phone access';
  static const revokePhone = "Revoke this phone's access";
  static const revokeConsequence =
      "Revoking immediately ends this phone’s financial access, SMS relay, and device-proxy access for the selected connections. Any crawl using its network route will stop. This does not affect separate sharing with recipient organisations or erase financial data they have already copied.";
  static const revokeAccess = 'Revoke access';
  static const revokeFailed =
      "Couldn't revoke this phone. Try again, or revoke it in the Accrawl console before you uninstall the app.";

  static const smsGranted =
      "SMS access allowed. Accrawl Companion can identify and relay bank SMS codes when a crawl for a selected connection needs one.";
  static const smsNeeded =
      "Allow SMS access so Accrawl Companion can identify and relay your bank's SMS codes when a crawl for a selected connection needs one.";
  static const allow = 'Allow';
  static const systemStatus = 'System status';
  static const setupNeeded = 'Setup needed';
  static const statusOn = 'Ready';
  static const smsAccess = 'SMS access';
  static const smsAccessOn =
      'Accrawl Companion can detect and relay bank SMS codes.';
  static const smsAccessOff =
      'Allow SMS access to detect and relay bank SMS codes.';
  static const notifications = 'Notifications';
  static const notificationsOn =
      'Crawl and code notifications are allowed on this phone.';
  static const notificationsOff =
      'Allow notifications for crawl and code updates.';
  static const batteryUse = 'Battery optimization';
  static const batteryUseOn =
      'Battery optimization is off for Accrawl Companion.';
  static const batteryUseOff =
      'Turn off battery optimization so SMS relay can keep working in the background.';
  static const consoleConnection = 'Console connection';
  static const consoleConnectionOn =
      'This phone is paired with your Accrawl console.';
  static const permissionSetupHint = 'Tap to set up';
  static const smsRequests = 'SMS code requests';
  static const watchingForSms = 'Watching for an SMS code';
  static const watchingForSmsHelp =
      'The crawl is signing in. Accrawl Companion is watching for the bank’s code.';
  static const waitingForSmsHelp =
      'The bank has requested a code. Accrawl Companion is waiting for the bank’s SMS.';
  static const smsRequestDetailsTemplate = '{phase}\n{crawl}';
  static const waitingForSms = 'Waiting for an SMS code';
  static const noSmsRequests = 'No SMS code requests right now.';
  static const deviceProxy = 'Device proxy';
  static const noProxy = "No crawls are using this phone's network right now.";
  static const activity = 'Activity';
  static const noActivity =
      'Relayed SMS codes and device-proxy activity will appear here.';

  static const updatedTemplate = 'Updated {relative} ({absolute})';
  static const asOfTemplate = 'As of {absolute}';
  static const connectionCrawlTemplate =
      'Connection {connectionId} · Crawl {sessionId}';
  static const crawlTemplate = 'Crawl {sessionId}';
  static const proxyUsageTemplate =
      'Requests: {requestCount}. Data transferred: {bytesTransferred}.';
  static const minutesAgoTemplate = '{minutes}m ago';
  static const hoursAgoTemplate = '{hours}h ago';
  static const daysAgoTemplate = '{days}d ago';

  static String updated(String relative, String absolute) => updatedTemplate
      .replaceAll('{relative}', relative)
      .replaceAll('{absolute}', absolute);
  static String asOf(String absolute) =>
      asOfTemplate.replaceAll('{absolute}', absolute);
  static String connectionCrawl(String connectionId, String sessionId) =>
      connectionCrawlTemplate
          .replaceAll('{connectionId}', connectionId)
          .replaceAll('{sessionId}', sessionId);
  static String crawl(String sessionId) =>
      crawlTemplate.replaceAll('{sessionId}', sessionId);
  static String smsRequestDetails(String phase, String crawl) =>
      smsRequestDetailsTemplate
          .replaceAll('{phase}', phase)
          .replaceAll('{crawl}', crawl);
  static String proxyUsage(int requestCount, String bytesTransferred) =>
      proxyUsageTemplate
          .replaceAll('{requestCount}', requestCount.toString())
          .replaceAll('{bytesTransferred}', bytesTransferred);
  static String minutesAgo(int minutes) =>
      minutesAgoTemplate.replaceAll('{minutes}', minutes.toString());
  static String hoursAgo(int hours) =>
      hoursAgoTemplate.replaceAll('{hours}', hours.toString());
  static String daysAgo(int days) =>
      daysAgoTemplate.replaceAll('{days}', days.toString());
}
