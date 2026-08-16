import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'client.dart';
import 'companion_copy.dart';
import 'crawl_detail_page.dart';
import 'financial_credential_store.dart';
import 'financial_elapsed_clock.dart';
import 'financial_inactivity_lease.dart';
import 'financial_models.dart';
import 'financial_unlock_lifecycle.dart';

const _native = MethodChannel('accrawl/sms');
const _credentialStore = FinancialCredentialStore();

void main() => runApp(const CompanionApp());

class CompanionApp extends StatelessWidget {
  const CompanionApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: CompanionCopy.appName,
    theme: ThemeData(
      colorSchemeSeed: const Color(0xFF315EA8),
      useMaterial3: true,
      brightness: Brightness.light,
    ),
    darkTheme: ThemeData(
      colorSchemeSeed: const Color(0xFF7BA7F7),
      useMaterial3: true,
      brightness: Brightness.dark,
    ),
    home: const HomePage(),
  );
}

class RelayLog {
  final DateTime at;
  final String message;
  const RelayLog(this.at, this.message);
}

class StatusTone {
  final IconData icon;
  final Color color;
  final String label;
  const StatusTone(this.icon, this.color, this.label);
}

StatusTone statusTone(String status) {
  switch (status) {
    case 'completed':
      return const StatusTone(
        Icons.check_circle,
        Colors.green,
        CompanionCopy.completed,
      );
    case 'failed':
      return const StatusTone(
        Icons.error,
        Colors.redAccent,
        CompanionCopy.failed,
      );
    case 'cancelled':
      return const StatusTone(
        Icons.cancel,
        Colors.grey,
        CompanionCopy.cancelled,
      );
    case 'waiting_for_otp':
      return const StatusTone(
        Icons.hourglass_top,
        Colors.amber,
        CompanionCopy.waitingForTwoFactorCode,
      );
    default:
      return const StatusTone(
        Icons.sync,
        Colors.lightBlueAccent,
        CompanionCopy.crawling,
      );
  }
}

String relativeTime(DateTime value) {
  final difference = DateTime.now().difference(value);
  if (difference.isNegative || difference.inSeconds < 60) {
    return CompanionCopy.justNow;
  }
  if (difference.inMinutes < 60) {
    return CompanionCopy.minutesAgo(difference.inMinutes);
  }
  if (difference.inHours < 24) {
    return CompanionCopy.hoursAgo(difference.inHours);
  }
  return CompanionCopy.daysAgo(difference.inDays);
}

String absoluteTime(DateTime value) =>
    DateFormat('d MMM y, HH:mm').format(value.toLocal());

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> with WidgetsBindingObserver {
  final _urlController = TextEditingController();
  final _codeController = TextEditingController();
  Timer? _relayTimer;
  Timer? _pairingTimer;
  Timer? _financialInactivityTimer;

  String? _baseUrl;
  String? _deviceToken;
  bool _allowsInsecureHttp = false;
  bool _smsGranted = false;
  bool _notificationsGranted = false;
  bool _batteryExempt = false;
  bool _everPolled = false;
  List<AwaitingSession> _awaiting = [];
  List<AwaitingTunnel> _awaitingTunnels = [];
  List<RecentCrawl> _recentCrawls = [];
  List<RelayLog> _relayLogs = [];
  List<RelayLog> _tunnelLogs = [];

  bool _claiming = false;
  bool _pairingPollInFlight = false;
  String? _pairingClaim;
  String? _verificationCode;
  String? _pairingError;

  int _tab = 0;
  int _financialGeneration = 0;
  final _financialLifecycle = FinancialUnlockLifecycle();
  final _financialInactivityLease = FinancialInactivityLease();
  final _financialLocalClock = Stopwatch()..start();
  final _financialElapsedClock = FinancialElapsedClock();
  AppLifecycleState _appLifecycleState = AppLifecycleState.resumed;
  bool _financialResumeSyncNeeded = false;
  bool _financialResumeCheckInProgress = false;
  String? _financialToken;
  bool _unlocking = false;
  bool _loadingFinancial = false;
  bool _loadingMoreTransactions = false;
  bool _amountsHidden = false;
  bool _financialAccessInvalid = false;
  String? _financialError;
  DateTime? _financialUpdatedAt;
  List<FinancialAccount> _accounts = [];
  List<FinancialTransaction> _transactions = [];
  String? _transactionCursor;

  bool get _paired =>
      (_baseUrl?.isNotEmpty ?? false) && (_deviceToken?.isNotEmpty ?? false);
  bool get _financialUnlocked => _financialToken != null;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    GestureBinding.instance.pointerRouter.addGlobalRoute(_onPointerEvent);
    HardwareKeyboard.instance.addHandler(_onHardwareKeyEvent);
    SemanticsBinding.instance.addSemanticsActionListener(_onSemanticsAction);
    _native.setMethodCallHandler(_onNativeCall);
    unawaited(_load());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _appLifecycleState = state;
    _financialLifecycle.didChange(state, unlockInProgress: _unlocking);
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      if (_financialUnlocked) _financialResumeSyncNeeded = true;
    }
    if (state == AppLifecycleState.resumed) {
      if (_financialResumeSyncNeeded && _financialUnlocked) {
        _financialResumeCheckInProgress = true;
        if (mounted) setState(() {});
        unawaited(_resumeFinancialSession(_financialGeneration));
      } else {
        _recordFinancialActivity();
      }
      unawaited(_refreshPermissions());
      unawaited(_refreshNativeLogs());
      if (_paired) unawaited(_recoverNativeSessions());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    GestureBinding.instance.pointerRouter.removeGlobalRoute(_onPointerEvent);
    HardwareKeyboard.instance.removeHandler(_onHardwareKeyEvent);
    SemanticsBinding.instance.removeSemanticsActionListener(_onSemanticsAction);
    _financialLocalClock.stop();
    _relayTimer?.cancel();
    _pairingTimer?.cancel();
    _financialInactivityTimer?.cancel();
    _urlController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  void _onPointerEvent(PointerEvent event) {
    if (event is PointerDownEvent) _recordFinancialActivity();
  }

  bool _onHardwareKeyEvent(KeyEvent event) {
    final wasFinancialUnlocked = _financialUnlocked;
    final accepted = _recordFinancialActivity();
    return wasFinancialUnlocked && !accepted;
  }

  void _onSemanticsAction(SemanticsActionEvent event) {
    _recordFinancialActivity();
  }

  bool _recordFinancialActivity() {
    if (!_financialUnlocked) return false;
    if (_financialResumeCheckInProgress || _financialResumeSyncNeeded) {
      return false;
    }
    final now = _financialElapsedClock.now(_financialLocalClock.elapsed);
    if (now == null) {
      _expireFinancialSession();
      return false;
    }
    if (!_financialInactivityLease.recordActivity(now)) {
      _expireFinancialSession();
      return false;
    }
    _scheduleFinancialInactivityLock();
    return true;
  }

  void _scheduleFinancialInactivityLock() {
    _financialInactivityTimer?.cancel();
    final now = _financialElapsedClock.now(_financialLocalClock.elapsed);
    if (now == null) {
      _expireFinancialSession();
      return;
    }
    final remaining = _financialInactivityLease.remaining(now);
    if (remaining == null) return;
    if (remaining <= Duration.zero) {
      _expireFinancialSession();
      return;
    }
    _financialInactivityTimer = Timer(remaining, _expireFinancialIfIdle);
  }

  void _expireFinancialIfIdle() {
    final now = _financialElapsedClock.now(_financialLocalClock.elapsed);
    if (now == null) {
      _expireFinancialSession();
      return;
    }
    final remaining = _financialInactivityLease.remaining(now);
    if (remaining == null) return;
    if (remaining > Duration.zero) {
      _scheduleFinancialInactivityLock();
      return;
    }
    _expireFinancialSession();
  }

  void _expireFinancialSession() {
    _financialInactivityTimer?.cancel();
    _financialInactivityTimer = null;
    if (!_financialUnlocked) {
      _financialInactivityLease.clear();
      return;
    }
    if (mounted) Navigator.of(context).popUntil((route) => route.isFirst);
    _lockFinancial();
  }

  Future<Duration?> _synchronizeFinancialClock() async {
    try {
      final milliseconds = await _native.invokeMethod<int>('elapsedRealtime');
      if (milliseconds == null || milliseconds < 0) return null;
      final nativeElapsed = Duration(milliseconds: milliseconds);
      final localElapsed = _financialLocalClock.elapsed;
      _financialElapsedClock.synchronize(
        nativeElapsed: nativeElapsed,
        localElapsed: localElapsed,
      );
      return nativeElapsed;
    } catch (error) {
      debugPrint('Unable to read Android elapsed realtime: $error');
      return null;
    }
  }

  Future<void> _resumeFinancialSession(int generation) async {
    final now = await _synchronizeFinancialClock();
    if (!mounted ||
        generation != _financialGeneration ||
        _appLifecycleState != AppLifecycleState.resumed) {
      return;
    }
    _financialResumeCheckInProgress = false;
    _financialResumeSyncNeeded = false;
    if (now == null || !_financialInactivityLease.recordActivity(now)) {
      _expireFinancialSession();
      return;
    }
    _scheduleFinancialInactivityLock();
    if (mounted) setState(() {});
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final allowsInsecure =
        await _native.invokeMethod<bool>('allowsInsecureHttp') ?? false;
    if (!mounted) return;
    setState(() {
      _baseUrl = prefs.getString('baseUrl');
      _deviceToken = prefs.getString('deviceToken');
      _allowsInsecureHttp = allowsInsecure;
      _urlController.text = _baseUrl ?? '';
    });
    await _refreshPermissions();
    await _refreshNativeLogs();
    if (_paired) await _startSessionRecovery();
  }

  Future<dynamic> _onNativeCall(MethodCall call) async {
    if (call.method == 'permissionChanged') await _refreshPermissions();
    return null;
  }

  Future<void> _refreshPermissions() async {
    final results = await Future.wait<bool>([
      _native
          .invokeMethod<bool>('hasSmsPermission')
          .then((value) => value ?? false),
      _native
          .invokeMethod<bool>('hasNotificationPermission')
          .then((value) => value ?? false),
      _native
          .invokeMethod<bool>('isIgnoringBatteryOptimizations')
          .then((value) => value ?? false),
    ]);
    if (mounted) {
      setState(() {
        _smsGranted = results[0];
        _notificationsGranted = results[1];
        _batteryExempt = results[2];
      });
    }
  }

  Future<void> _requestPermission(String method) async {
    await _native.invokeMethod(method);
    await _refreshPermissions();
  }

  List<RelayLog> _parseNativeLog(String? raw) {
    if (raw == null || raw.isEmpty) return [];
    try {
      return (jsonDecode(raw) as List<dynamic>).map((entry) {
        final map = entry as Map<String, dynamic>;
        return RelayLog(
          DateTime.fromMillisecondsSinceEpoch((map['at'] as num).toInt()),
          map['message'] as String,
        );
      }).toList();
    } catch (error) {
      debugPrint('Unable to parse native activity log: $error');
      return [];
    }
  }

  Future<void> _refreshNativeLogs() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.reload();
    final relay = _parseNativeLog(prefs.getString('nativeRelayLog'));
    final tunnels = _parseNativeLog(prefs.getString('nativeTunnelLog'));
    if (!mounted) return;
    setState(() {
      _relayLogs = relay;
      _tunnelLogs = tunnels;
    });
  }

  Future<void> _recoverNativeSessions() async {
    try {
      await _native.invokeMethod('registerPushToken');
    } on PlatformException catch (error) {
      debugPrint('Unable to register push token: ${error.message}');
    }
    await _recoverPendingNativeSessions();
  }

  Future<void> _recoverPendingNativeSessions() async {
    try {
      await _native.invokeMethod('recoverPendingSessions');
    } on PlatformException catch (error) {
      debugPrint('Unable to recover pending sessions: ${error.message}');
    }
  }

  Future<void> _startSessionRecovery() async {
    await _recoverNativeSessions();
    _relayTimer?.cancel();
    _relayTimer = Timer.periodic(const Duration(seconds: 6), (_) {
      unawaited(_pollRelay());
      unawaited(_refreshNativeLogs());
    });
    await _pollRelay();
  }

  Future<void> _pollRelay() async {
    if (!_paired) return;
    final generation = _financialGeneration;
    final client = AccrawlClient(_baseUrl!, _deviceToken!);
    try {
      final results = await Future.wait([
        client.awaitingOtp(),
        client.awaitingTunnel(),
        client.recentCrawls(),
      ]);
      if (!mounted || generation != _financialGeneration || !_paired) return;
      final awaiting = results[0] as List<AwaitingSession>;
      final awaitingTunnels = results[1] as List<AwaitingTunnel>;
      setState(() {
        _awaiting = awaiting;
        _awaitingTunnels = awaitingTunnels;
        _recentCrawls = results[2] as List<RecentCrawl>;
        _everPolled = true;
      });
      if (awaiting.isNotEmpty || awaitingTunnels.isNotEmpty) {
        unawaited(_recoverPendingNativeSessions());
      }
    } on DeviceUnauthorized {
      await _clearLocalPairing();
    } catch (error) {
      debugPrint('Relay status poll failed: $error');
      if (mounted) setState(() => _everPolled = true);
    }
  }

  String _normalizeUrl(String value) =>
      value.trim().replaceAll(RegExp(r'/+$'), '');

  bool _validUrl(String value) {
    final uri = Uri.tryParse(_normalizeUrl(value));
    if (uri == null || uri.host.isEmpty) return false;
    return uri.scheme == 'https' ||
        (_allowsInsecureHttp && uri.scheme == 'http');
  }

  bool _validPairingCode(String value) =>
      value.trim().startsWith('acpair_') && value.trim().length >= 47;

  String _newClaim() {
    final random = Random.secure();
    final bytes = List<int>.generate(32, (_) => random.nextInt(256));
    return 'acclaim_${base64UrlEncode(bytes).replaceAll('=', '')}';
  }

  Future<void> _scanPairingQr() async {
    final raw = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const PairingScannerPage()),
    );
    if (raw == null || !mounted) return;
    final payload = parsePairingPayload(raw);
    if (payload == null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text(CompanionCopy.invalidQr)));
      return;
    }
    setState(() {
      _urlController.text = payload.url;
      _codeController.text = payload.pairingCode;
      _pairingError = null;
    });
  }

  Future<void> _claimPairing() async {
    final url = _normalizeUrl(_urlController.text);
    final pairingCode = _codeController.text.trim();
    if (!_validUrl(url) || !_validPairingCode(pairingCode)) return;
    final claim = _newClaim();
    setState(() {
      _claiming = true;
      _pairingError = null;
      _pairingClaim = claim;
    });
    try {
      final result = await PairingClient(url).claim(pairingCode, claim);
      if (!mounted || _pairingClaim != claim) return;
      if (result.status == PairingStatus.waitingForApproval &&
          result.verificationCode != null) {
        setState(() {
          _claiming = false;
          _verificationCode = result.verificationCode;
        });
        _pairingTimer?.cancel();
        _pairingTimer = Timer.periodic(
          const Duration(seconds: 2),
          (_) => unawaited(_pollPairing(url, pairingCode, claim)),
        );
        return;
      }
      _setPairingTerminalError(result.status);
    } on HttpsRequired {
      if (mounted) {
        setState(() {
          _claiming = false;
          _pairingError = CompanionCopy.httpsRequired;
        });
      }
    } on SocketException catch (error) {
      debugPrint('Pairing connection failed: $error');
      if (mounted) {
        setState(() {
          _claiming = false;
          _pairingError = CompanionCopy.consoleUnreachable;
        });
      }
    } on TimeoutException catch (error) {
      debugPrint('Pairing timed out: $error');
      if (mounted) {
        setState(() {
          _claiming = false;
          _pairingError = CompanionCopy.consoleUnreachable;
        });
      }
    } catch (error) {
      debugPrint('Pairing claim failed: $error');
      if (mounted) {
        setState(() {
          _claiming = false;
          _pairingError = CompanionCopy.unexpectedConsole;
        });
      }
    }
  }

  Future<void> _pollPairing(
    String url,
    String pairingCode,
    String claim,
  ) async {
    if (_pairingClaim != claim || _pairingPollInFlight) return;
    _pairingPollInFlight = true;
    try {
      final result = await PairingClient(url).complete(pairingCode, claim);
      if (!mounted || _pairingClaim != claim) return;
      if (result.status == PairingStatus.waitingForApproval) return;
      _pairingTimer?.cancel();
      if (result.status != PairingStatus.paired ||
          result.deviceToken == null ||
          result.financialToken == null) {
        _setPairingTerminalError(result.status);
        return;
      }
      final financialToken = result.financialToken!;
      try {
        await _credentialStore.save(financialToken);
      } catch (error) {
        debugPrint('Screen-lock-bound credential write failed: $error');
        try {
          await AccrawlClient(url, result.deviceToken!).revokeSelf();
        } catch (revokeError) {
          debugPrint('Unable to revoke failed pairing: $revokeError');
        }
        if (mounted) {
          setState(() {
            _pairingClaim = null;
            _verificationCode = null;
            _pairingError = CompanionCopy.screenLockRequired;
          });
        }
        return;
      }
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('baseUrl', url);
      await prefs.setString('deviceToken', result.deviceToken!);
      if (!mounted) return;
      final financialNow = await _synchronizeFinancialClock();
      if (!mounted || _pairingClaim != claim) return;
      setState(() {
        _baseUrl = url;
        _deviceToken = result.deviceToken;
        _financialGeneration++;
        _financialToken = financialNow == null ? null : financialToken;
        _financialAccessInvalid = false;
        _financialError = null;
        _pairingClaim = null;
        _verificationCode = null;
        _pairingError = null;
      });
      if (financialNow != null) {
        _financialInactivityLease.start(financialNow);
        _scheduleFinancialInactivityLock();
      }
      if (!_smsGranted) await _native.invokeMethod('requestSmsPermission');
      await _refreshPermissions();
      if (!_notificationsGranted) {
        await _native.invokeMethod('requestNotificationPermission');
      }
      await _refreshPermissions();
      if (!_batteryExempt) {
        await _native.invokeMethod('requestIgnoreBatteryOptimizations');
      }
      await _refreshPermissions();
      await _startSessionRecovery();
      if (financialNow != null) await _loadFinancial();
    } on SocketException catch (error) {
      debugPrint('Pairing completion connection failed: $error');
    } on TimeoutException catch (error) {
      debugPrint('Pairing completion timed out: $error');
    } catch (error) {
      debugPrint('Pairing completion failed: $error');
      if (mounted) {
        setState(() => _pairingError = CompanionCopy.unexpectedConsole);
      }
    } finally {
      _pairingPollInFlight = false;
    }
  }

  void _setPairingTerminalError(PairingStatus status) {
    _pairingTimer?.cancel();
    if (!mounted) return;
    setState(() {
      _claiming = false;
      _pairingClaim = null;
      _verificationCode = null;
      _pairingError = status == PairingStatus.used
          ? CompanionCopy.pairingUsed
          : CompanionCopy.pairingExpired;
    });
  }

  void _cancelPairing() {
    _pairingTimer?.cancel();
    _pairingPollInFlight = false;
    setState(() {
      _claiming = false;
      _pairingClaim = null;
      _verificationCode = null;
      _pairingError = null;
    });
  }

  void _lockFinancial() {
    _financialGeneration++;
    _financialInactivityTimer?.cancel();
    _financialInactivityTimer = null;
    _financialInactivityLease.clear();
    _financialResumeCheckInProgress = false;
    _financialResumeSyncNeeded = false;
    unawaited(_credentialStore.lock());
    _financialToken = null;
    _accounts = [];
    _transactions = [];
    _transactionCursor = null;
    _financialUpdatedAt = null;
    _loadingFinancial = false;
    _loadingMoreTransactions = false;
    _unlocking = false;
    if (mounted) setState(() {});
  }

  Future<void> _unlockFinancial() async {
    if (!_paired || _unlocking) return;
    final attempt = ++_financialGeneration;
    setState(() {
      _unlocking = true;
      _financialError = null;
      _financialAccessInvalid = false;
    });
    String? token;
    var resumed = false;
    _financialLifecycle.beginCredentialPrompt();
    try {
      try {
        token = await _credentialStore.unlock();
      } catch (error) {
        debugPrint('Financial credential unlock failed: $error');
      }
      if (!mounted || attempt != _financialGeneration) return;
      resumed = await _financialLifecycle.waitForResumeAfterCredentialPrompt();
    } finally {
      _financialLifecycle.endCredentialPrompt();
    }
    if (!mounted || attempt != _financialGeneration) return;
    if (token == null || !resumed) {
      setState(() {
        _unlocking = false;
        _financialError = CompanionCopy.unlockFailed;
      });
      return;
    }
    final financialNow = await _synchronizeFinancialClock();
    if (!mounted || attempt != _financialGeneration) return;
    if (financialNow == null) {
      setState(() {
        _unlocking = false;
        _financialError = CompanionCopy.unlockFailed;
      });
      return;
    }
    setState(() {
      _unlocking = false;
      _financialToken = token;
    });
    _financialInactivityLease.start(financialNow);
    _scheduleFinancialInactivityLock();
    await _loadFinancial();
  }

  Future<List<FinancialAccount>> _loadAllAccounts(
    FinancialClient client,
    int generation,
  ) async {
    final results = <FinancialAccount>[];
    final cursors = <String>{};
    String? cursor;
    do {
      final page = await client.accounts(cursor);
      if (generation != _financialGeneration || !_financialUnlocked) {
        throw const _FinancialLocked();
      }
      results.addAll(page.items);
      cursor = page.nextCursor;
      if (cursor != null && !cursors.add(cursor)) {
        throw const FormatException('repeated account cursor');
      }
    } while (cursor != null);
    return results;
  }

  Future<void> _loadFinancial() async {
    final token = _financialToken;
    final url = _baseUrl;
    if (token == null || url == null) return;
    final generation = _financialGeneration;
    setState(() {
      _loadingFinancial = true;
      _financialError = null;
    });
    final client = FinancialClient(url, token);
    try {
      final results = await Future.wait([
        _loadAllAccounts(client, generation),
        client.transactions(),
      ]);
      if (!mounted ||
          generation != _financialGeneration ||
          !_financialUnlocked) {
        return;
      }
      final transactionPage = results[1] as FinancialPage<FinancialTransaction>;
      setState(() {
        _accounts = results[0] as List<FinancialAccount>;
        _transactions = transactionPage.items;
        _transactionCursor = transactionPage.nextCursor;
        _financialUpdatedAt = DateTime.now();
        _loadingFinancial = false;
      });
    } on _FinancialLocked {
      return;
    } on FinancialUnauthorized {
      if (!mounted || generation != _financialGeneration) return;
      _lockFinancial();
      setState(() => _financialAccessInvalid = true);
    } on HttpsRequired {
      if (!mounted || generation != _financialGeneration) return;
      setState(() {
        _loadingFinancial = false;
        _financialError = CompanionCopy.httpsRequired;
      });
    } catch (error) {
      debugPrint('Financial data load failed: $error');
      if (!mounted || generation != _financialGeneration) return;
      setState(() {
        _loadingFinancial = false;
        _financialError = CompanionCopy.loadFailed;
      });
    }
  }

  Future<void> _loadMoreTransactions() async {
    final cursor = _transactionCursor;
    final token = _financialToken;
    final url = _baseUrl;
    if (cursor == null ||
        token == null ||
        url == null ||
        _loadingMoreTransactions) {
      return;
    }
    final generation = _financialGeneration;
    setState(() => _loadingMoreTransactions = true);
    try {
      final page = await FinancialClient(
        url,
        token,
      ).transactions(cursor: cursor);
      if (!mounted ||
          generation != _financialGeneration ||
          !_financialUnlocked) {
        return;
      }
      setState(() {
        _transactions = [..._transactions, ...page.items];
        _transactionCursor = page.nextCursor;
        _loadingMoreTransactions = false;
      });
    } on FinancialUnauthorized {
      if (!mounted || generation != _financialGeneration) return;
      _lockFinancial();
      setState(() => _financialAccessInvalid = true);
    } catch (error) {
      debugPrint('Transaction page load failed: $error');
      if (mounted && generation == _financialGeneration) {
        setState(() {
          _loadingMoreTransactions = false;
          _financialError = CompanionCopy.loadFailed;
        });
      }
    }
  }

  Future<FinancialPage<FinancialTransaction>> _loadAccountTransactions(
    String accountId,
    String? cursor,
  ) async {
    final generation = _financialGeneration;
    final token = _financialToken;
    final url = _baseUrl;
    if (token == null || url == null) throw const _FinancialLocked();
    final page = await FinancialClient(
      url,
      token,
    ).transactions(cursor: cursor, accountId: accountId);
    if (generation != _financialGeneration || !_financialUnlocked) {
      throw const _FinancialLocked();
    }
    return page;
  }

  Future<void> _openAccount(FinancialAccount account) async {
    if (!_recordFinancialActivity()) return;
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => AccountDetailPage(
          account: account,
          amountsHidden: _amountsHidden,
          loadTransactions: (cursor) =>
              _loadAccountTransactions(account.id, cursor),
        ),
      ),
    );
  }

  Future<void> _openRecentCrawl(RecentCrawl crawl) async {
    if (!_financialUnlocked) await _unlockFinancial();
    if (!mounted) return;
    final token = _financialToken;
    final url = _baseUrl;
    if (token == null || url == null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text(CompanionCopy.unlockFailed)));
      return;
    }
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => CrawlDetailPage(
          crawl: crawl,
          client: FinancialClient(url, token),
          onFinancialAccessRevoked: () {
            _lockFinancial();
            if (mounted) {
              setState(() => _financialAccessInvalid = true);
            }
          },
        ),
      ),
    );
  }

  Future<void> _revokePhone() async {
    final token = _deviceToken;
    final url = _baseUrl;
    if (token == null || url == null) return;
    try {
      await AccrawlClient(url, token).revokeSelf();
    } on DeviceUnauthorized {
      await _clearLocalPairing();
      return;
    } catch (error) {
      debugPrint('Device self-revocation failed: $error');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text(CompanionCopy.revokeFailed)),
        );
      }
      return;
    }
    await _clearLocalPairing();
  }

  Future<void> _clearLocalPairing() async {
    _financialGeneration++;
    _financialInactivityTimer?.cancel();
    _financialInactivityTimer = null;
    _financialInactivityLease.clear();
    _financialResumeCheckInProgress = false;
    _financialResumeSyncNeeded = false;
    _relayTimer?.cancel();
    _pairingTimer?.cancel();
    _pairingPollInFlight = false;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('baseUrl');
    await prefs.remove('deviceToken');
    await prefs.remove('nativeRelayLog');
    await prefs.remove('nativeTunnelLog');
    try {
      await _credentialStore.clear();
    } catch (error) {
      debugPrint('Financial credential deletion failed: $error');
    }
    try {
      await _native.invokeMethod('stopService');
    } on PlatformException catch (error) {
      debugPrint('Unable to stop SMS service: ${error.message}');
    }
    try {
      await _native.invokeMethod('stopTunnelService');
    } on PlatformException catch (error) {
      debugPrint('Unable to stop tunnel service: ${error.message}');
    }
    if (!mounted) return;
    setState(() {
      _baseUrl = null;
      _deviceToken = null;
      _financialToken = null;
      _awaiting = [];
      _awaitingTunnels = [];
      _recentCrawls = [];
      _relayLogs = [];
      _tunnelLogs = [];
      _accounts = [];
      _transactions = [];
      _transactionCursor = null;
      _everPolled = false;
      _tab = 0;
    });
  }

  Future<void> _showPhoneAccess() async {
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text(CompanionCopy.revokePhone),
        content: const Text(CompanionCopy.revokeConsequence),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text(CompanionCopy.cancel),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(dialogContext).pop();
              unawaited(_revokePhone());
            },
            child: const Text(CompanionCopy.revokeAccess),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!_paired) return _buildPairing();
    final financialTab = _tab < 2;
    return Scaffold(
      appBar: AppBar(
        title: Text(
          _tab == 0
              ? CompanionCopy.accounts
              : _tab == 1
              ? CompanionCopy.transactions
              : CompanionCopy.relay,
        ),
        actions: [
          if (financialTab && _financialUnlocked)
            IconButton(
              tooltip: _amountsHidden
                  ? CompanionCopy.showAmounts
                  : CompanionCopy.hideAmounts,
              onPressed: () => setState(() => _amountsHidden = !_amountsHidden),
              icon: Icon(
                _amountsHidden ? Icons.visibility : Icons.visibility_off,
              ),
            ),
          IconButton(
            tooltip: CompanionCopy.phoneAccess,
            onPressed: _showPhoneAccess,
            icon: const Icon(Icons.phonelink_erase),
          ),
        ],
      ),
      body: financialTab ? _buildFinancialBody() : _buildRelayBody(),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (value) => setState(() => _tab = value),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.account_balance_outlined),
            selectedIcon: Icon(Icons.account_balance),
            label: CompanionCopy.accounts,
          ),
          NavigationDestination(
            icon: Icon(Icons.receipt_long_outlined),
            selectedIcon: Icon(Icons.receipt_long),
            label: CompanionCopy.transactions,
          ),
          NavigationDestination(
            icon: Icon(Icons.sms_outlined),
            selectedIcon: Icon(Icons.sms),
            label: CompanionCopy.relay,
          ),
        ],
      ),
    );
  }

  Widget _buildPairing() => Scaffold(
    appBar: AppBar(title: const Text(CompanionCopy.appName)),
    body: SafeArea(
      child: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Text(
            CompanionCopy.pairPhone,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          Text(
            CompanionCopy.pairingExplanation,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 24),
          if (_verificationCode == null) ...[
            OutlinedButton.icon(
              onPressed: _claiming ? null : _scanPairingQr,
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text(CompanionCopy.scanPairingQr),
            ),
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 20),
              child: Row(
                children: [
                  Expanded(child: Divider()),
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: 12),
                    child: Text(CompanionCopy.enterByHand),
                  ),
                  Expanded(child: Divider()),
                ],
              ),
            ),
            MergeSemantics(
              child: Semantics(
                label: CompanionCopy.consoleAddress,
                child: TextField(
                  controller: _urlController,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  onChanged: (_) => setState(() => _pairingError = null),
                  decoration: const InputDecoration(
                    labelText: CompanionCopy.consoleAddress,
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 12),
            MergeSemantics(
              child: Semantics(
                label: CompanionCopy.pairingCode,
                child: TextField(
                  controller: _codeController,
                  autocorrect: false,
                  onChanged: (_) => setState(() => _pairingError = null),
                  decoration: const InputDecoration(
                    labelText: CompanionCopy.pairingCode,
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed:
                  _claiming ||
                      !_validUrl(_urlController.text) ||
                      !_validPairingCode(_codeController.text)
                  ? null
                  : _claimPairing,
              child: _claiming
                  ? const SizedBox.square(
                      dimension: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text(CompanionCopy.continueAction),
            ),
          ] else ...[
            const Text(
              CompanionCopy.confirmVerification,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            Semantics(
              label: _verificationCode!.split('').join(' '),
              child: Text(
                _verificationCode!,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.displaySmall?.copyWith(
                  fontFeatures: const [FontFeature.tabularFigures()],
                  letterSpacing: 8,
                ),
              ),
            ),
            const SizedBox(height: 12),
            const Text(
              CompanionCopy.waitingForApproval,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            TextButton(
              onPressed: _cancelPairing,
              child: const Text(CompanionCopy.cancelPairing),
            ),
          ],
          if (_pairingError != null) ...[
            const SizedBox(height: 16),
            Text(
              _pairingError!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ],
        ],
      ),
    ),
  );

  Widget _buildFinancialBody() {
    if (_financialResumeCheckInProgress || _financialResumeSyncNeeded) {
      return const SizedBox.expand();
    }
    if (!_financialUnlocked) {
      return Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.lock_outline, size: 52),
              const SizedBox(height: 16),
              Text(
                _financialAccessInvalid
                    ? CompanionCopy.financialDataLocked
                    : CompanionCopy.unlockFinancialData,
                style: Theme.of(context).textTheme.headlineSmall,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              Text(
                _financialAccessInvalid
                    ? CompanionCopy.invalidFinancialAccess
                    : CompanionCopy.unlockExplanation,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              const Text(
                CompanionCopy.memoryProtection,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 20),
              if (!_financialAccessInvalid)
                FilledButton.icon(
                  onPressed: _unlocking ? null : _unlockFinancial,
                  icon: const Icon(Icons.lock_open),
                  label: _unlocking
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text(CompanionCopy.unlock),
                ),
              if (_financialError != null) ...[
                const SizedBox(height: 12),
                Text(
                  _financialError!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                  textAlign: TextAlign.center,
                ),
              ],
            ],
          ),
        ),
      );
    }
    if (_loadingFinancial && _accounts.isEmpty && _transactions.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_tab == 0) return _buildAccounts();
    return _buildTransactions();
  }

  Widget _updatedHeader() {
    final updated = _financialUpdatedAt;
    if (updated == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      child: Text(
        CompanionCopy.updated(relativeTime(updated), absoluteTime(updated)),
        style: Theme.of(context).textTheme.bodySmall,
      ),
    );
  }

  Widget _buildAccounts() => RefreshIndicator(
    onRefresh: _loadFinancial,
    child: CustomScrollView(
      physics: const AlwaysScrollableScrollPhysics(),
      slivers: [
        SliverToBoxAdapter(child: _updatedHeader()),
        if (_financialError != null)
          SliverToBoxAdapter(child: _errorCard(_financialError!)),
        if (_accounts.isEmpty)
          const SliverFillRemaining(
            hasScrollBody: false,
            child: _EmptyState(
              icon: Icons.account_balance_outlined,
              title: CompanionCopy.noAccounts,
              detail: CompanionCopy.noAccountsHelp,
            ),
          )
        else
          SliverList.builder(
            itemCount: _accounts.length,
            itemBuilder: (context, index) {
              final account = _accounts[index];
              return ListTile(
                leading: const CircleAvatar(
                  child: Icon(Icons.account_balance_wallet_outlined),
                ),
                title: Text(account.displayName),
                subtitle: Text(
                  '${account.connectionLabel}'
                  '${account.status == 'inactive' ? ' · ${CompanionCopy.inactive}' : ''}',
                ),
                trailing: AmountText(
                  amount: account.isCredit
                      ? account.balance.current.abs()
                      : account.balance.current,
                  currency: account.currency,
                  hidden: _amountsHidden,
                ),
                onTap: () => _openAccount(account),
              );
            },
          ),
      ],
    ),
  );

  Widget _buildTransactions() => RefreshIndicator(
    onRefresh: _loadFinancial,
    child: CustomScrollView(
      physics: const AlwaysScrollableScrollPhysics(),
      slivers: [
        SliverToBoxAdapter(child: _updatedHeader()),
        if (_financialError != null)
          SliverToBoxAdapter(child: _errorCard(_financialError!)),
        if (_transactions.isEmpty)
          const SliverFillRemaining(
            hasScrollBody: false,
            child: _EmptyState(
              icon: Icons.receipt_long_outlined,
              title: CompanionCopy.noTransactions,
              detail: CompanionCopy.noTransactionsHelp,
            ),
          )
        else ...[
          SliverList.builder(
            itemCount: _transactions.length,
            itemBuilder: (context, index) => TransactionTile(
              transaction: _transactions[index],
              hidden: _amountsHidden,
            ),
          ),
          if (_transactionCursor != null)
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: OutlinedButton(
                  onPressed: _loadingMoreTransactions
                      ? null
                      : _loadMoreTransactions,
                  child: _loadingMoreTransactions
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text(CompanionCopy.loadMore),
                ),
              ),
            ),
        ],
      ],
    ),
  );

  Widget _errorCard(String message) => Card(
    margin: const EdgeInsets.all(16),
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          Icon(Icons.error_outline, color: Theme.of(context).colorScheme.error),
          const SizedBox(width: 12),
          Expanded(child: Text(message)),
          IconButton(
            tooltip: CompanionCopy.refresh,
            onPressed: _loadFinancial,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
    ),
  );

  Widget _systemStatusRow({
    required IconData icon,
    required String title,
    required String description,
    required bool enabled,
    Future<void> Function()? onTap,
  }) => ListTile(
    leading: Icon(
      enabled ? Icons.check_circle : icon,
      color: enabled ? Colors.green : Theme.of(context).colorScheme.error,
    ),
    title: Text(title),
    subtitle: Text(description),
    trailing: Text(
      enabled ? CompanionCopy.statusOn : CompanionCopy.setupNeeded,
      style: TextStyle(
        color: enabled ? Colors.green : Theme.of(context).colorScheme.error,
        fontWeight: FontWeight.w600,
      ),
    ),
    onTap: enabled || onTap == null ? null : () => unawaited(onTap()),
  );

  Widget _systemStatusCard() {
    final configured =
        _smsGranted && _notificationsGranted && _batteryExempt && _paired;
    return Card(
      child: Column(
        children: [
          ListTile(
            leading: Icon(
              configured ? Icons.verified : Icons.warning_amber,
              color: configured
                  ? Colors.green
                  : Theme.of(context).colorScheme.error,
            ),
            title: const Text(CompanionCopy.systemStatus),
            trailing: Text(
              configured ? CompanionCopy.statusOn : CompanionCopy.setupNeeded,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
          const Divider(height: 1),
          _systemStatusRow(
            icon: Icons.sms_outlined,
            title: CompanionCopy.smsAccess,
            description: _smsGranted
                ? CompanionCopy.smsAccessOn
                : CompanionCopy.smsAccessOff,
            enabled: _smsGranted,
            onTap: () => _requestPermission('requestSmsPermission'),
          ),
          _systemStatusRow(
            icon: Icons.notifications_outlined,
            title: CompanionCopy.notifications,
            description: _notificationsGranted
                ? CompanionCopy.notificationsOn
                : CompanionCopy.notificationsOff,
            enabled: _notificationsGranted,
            onTap: () => _requestPermission('requestNotificationPermission'),
          ),
          _systemStatusRow(
            icon: Icons.battery_saver_outlined,
            title: CompanionCopy.batteryUse,
            description: _batteryExempt
                ? CompanionCopy.batteryUseOn
                : CompanionCopy.batteryUseOff,
            enabled: _batteryExempt,
            onTap: () =>
                _requestPermission('requestIgnoreBatteryOptimizations'),
          ),
          _systemStatusRow(
            icon: Icons.cloud_off_outlined,
            title: CompanionCopy.consoleConnection,
            description: CompanionCopy.consoleConnectionOn,
            enabled: _paired,
          ),
        ],
      ),
    );
  }

  Widget _buildRelayBody() {
    final logs = [..._relayLogs, ..._tunnelLogs]
      ..sort((a, b) => b.at.compareTo(a.at));
    return RefreshIndicator(
      onRefresh: () async {
        await _pollRelay();
        await _refreshNativeLogs();
      },
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          _systemStatusCard(),
          const SizedBox(height: 16),
          Text(
            CompanionCopy.smsRequests,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          if (!_everPolled)
            const LinearProgressIndicator()
          else if (_awaiting.isEmpty)
            const _Muted(CompanionCopy.noSmsRequests)
          else
            ..._awaiting.map(
              (session) => ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.hourglass_top, color: Colors.amber),
                title: Text(
                  session.institutionName ??
                      (session.status == 'waiting_for_otp'
                          ? CompanionCopy.waitingForSms
                          : CompanionCopy.watchingForSms),
                ),
                subtitle: Text(
                  CompanionCopy.smsRequestDetails(
                    session.status == 'waiting_for_otp'
                        ? CompanionCopy.waitingForSmsHelp
                        : CompanionCopy.watchingForSmsHelp,
                    CompanionCopy.connectionCrawl(
                      session.connectionId,
                      session.id,
                    ),
                  ),
                ),
                isThreeLine: true,
              ),
            ),
          const SizedBox(height: 16),
          Text(
            CompanionCopy.deviceProxy,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          if (!_everPolled)
            const LinearProgressIndicator()
          else if (_awaitingTunnels.isEmpty)
            const _Muted(CompanionCopy.noProxy)
          else
            ..._awaitingTunnels.map(
              (tunnel) => ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.lan, color: Colors.lightBlue),
                title: Text(CompanionCopy.crawl(tunnel.sessionId)),
              ),
            ),
          const SizedBox(height: 16),
          Text(
            CompanionCopy.recentCrawls,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          if (!_everPolled)
            const LinearProgressIndicator()
          else if (_recentCrawls.isEmpty)
            const _Muted(CompanionCopy.noRecentCrawls)
          else
            ..._recentCrawls.take(8).map(_recentCrawlTile),
          const SizedBox(height: 16),
          Text(
            CompanionCopy.activity,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          if (logs.isEmpty)
            const _Muted(CompanionCopy.noActivity)
          else
            ...logs.map(
              (log) => ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.sms, size: 18),
                title: Text(log.message),
                subtitle: Text(absoluteTime(log.at)),
              ),
            ),
        ],
      ),
    );
  }

  Widget _recentCrawlTile(RecentCrawl crawl) {
    final tone = statusTone(crawl.status);
    final at = crawl.at;
    return Semantics(
      button: true,
      hint: CompanionCopy.crawlDetailsHint,
      child: ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Icon(tone.icon, color: tone.color),
        title: Text(crawl.label),
        subtitle: Text(
          at == null
              ? tone.label
              : '${tone.label} · ${relativeTime(at)} (${absoluteTime(at)})',
        ),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => unawaited(_openRecentCrawl(crawl)),
      ),
    );
  }
}

class AmountText extends StatelessWidget {
  final double amount;
  final String currency;
  final bool hidden;
  final TextStyle? style;

  const AmountText({
    super.key,
    required this.amount,
    required this.currency,
    required this.hidden,
    this.style,
  });

  @override
  Widget build(BuildContext context) {
    if (hidden) {
      return Semantics(
        label: CompanionCopy.amountHidden,
        child: ExcludeSemantics(child: Text('••••', style: style)),
      );
    }
    return Text(
      NumberFormat.simpleCurrency(name: currency).format(amount),
      style: (style ?? Theme.of(context).textTheme.bodyLarge)?.copyWith(
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
    );
  }
}

class TransactionTile extends StatelessWidget {
  final FinancialTransaction transaction;
  final bool hidden;

  const TransactionTile({
    super.key,
    required this.transaction,
    required this.hidden,
  });

  @override
  Widget build(BuildContext context) => ListTile(
    leading: CircleAvatar(
      child: Icon(
        transaction.amount < 0 ? Icons.arrow_upward : Icons.arrow_downward,
      ),
    ),
    title: Text(transaction.displayName),
    subtitle: Text(
      '${transaction.accountLabel} · '
      '${DateFormat('d MMM y').format(transaction.bookingDate.toLocal())}'
      '${transaction.status == 'pending' ? ' · ${CompanionCopy.pending}' : ''}',
    ),
    trailing: AmountText(
      amount: transaction.amount,
      currency: transaction.currency,
      hidden: hidden,
    ),
  );
}

class AccountDetailPage extends StatefulWidget {
  final FinancialAccount account;
  final bool amountsHidden;
  final Future<FinancialPage<FinancialTransaction>> Function(String? cursor)
  loadTransactions;

  const AccountDetailPage({
    super.key,
    required this.account,
    required this.amountsHidden,
    required this.loadTransactions,
  });

  @override
  State<AccountDetailPage> createState() => _AccountDetailPageState();
}

class _AccountDetailPageState extends State<AccountDetailPage> {
  List<FinancialTransaction> _transactions = [];
  String? _cursor;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load(reset: true));
  }

  Future<void> _load({required bool reset}) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.loadTransactions(reset ? null : _cursor);
      if (!mounted) return;
      setState(() {
        _transactions = reset ? page.items : [..._transactions, ...page.items];
        _cursor = page.nextCursor;
        _loading = false;
      });
    } catch (error) {
      debugPrint('Account transaction load failed: $error');
      if (mounted) {
        setState(() {
          _loading = false;
          _error = CompanionCopy.loadFailed;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final account = widget.account;
    final balance = account.balance;
    return Scaffold(
      appBar: AppBar(title: Text(account.displayName)),
      body: RefreshIndicator(
        onRefresh: () => _load(reset: true),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          children: [
            Text(
              account.connectionLabel,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            if (account.status == 'inactive')
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text(CompanionCopy.inactive),
              ),
            const SizedBox(height: 16),
            _BalanceRow(
              label: account.isCredit
                  ? CompanionCopy.amountOwed
                  : CompanionCopy.currentBalance,
              amount: account.isCredit
                  ? balance.current.abs()
                  : balance.current,
              currency: account.currency,
              hidden: widget.amountsHidden,
            ),
            if (balance.available != null)
              _BalanceRow(
                label: account.isCredit
                    ? CompanionCopy.availableCredit
                    : CompanionCopy.availableBalance,
                amount: balance.available!,
                currency: account.currency,
                hidden: widget.amountsHidden,
              ),
            if (balance.limit != null)
              _BalanceRow(
                label: CompanionCopy.creditLimit,
                amount: balance.limit!,
                currency: account.currency,
                hidden: widget.amountsHidden,
              ),
            if (balance.asOf != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  CompanionCopy.asOf(absoluteTime(balance.asOf!)),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            const Divider(height: 32),
            Text(
              CompanionCopy.transactions,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            if (_loading && _transactions.isEmpty)
              const Padding(
                padding: EdgeInsets.all(24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text(_error!),
              )
            else if (_transactions.isEmpty)
              const _Muted(CompanionCopy.noAccountTransactions)
            else ...[
              ..._transactions.map(
                (transaction) => TransactionTile(
                  transaction: transaction,
                  hidden: widget.amountsHidden,
                ),
              ),
              if (_cursor != null)
                OutlinedButton(
                  onPressed: _loading ? null : () => _load(reset: false),
                  child: _loading
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text(CompanionCopy.loadMore),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _BalanceRow extends StatelessWidget {
  final String label;
  final double amount;
  final String currency;
  final bool hidden;

  const _BalanceRow({
    required this.label,
    required this.amount,
    required this.currency,
    required this.hidden,
  });

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Row(
      children: [
        Expanded(child: Text(label)),
        AmountText(
          amount: amount,
          currency: currency,
          hidden: hidden,
          style: Theme.of(
            context,
          ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
        ),
      ],
    ),
  );
}

class _EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String detail;

  const _EmptyState({
    required this.icon,
    required this.title,
    required this.detail,
  });

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 52),
          const SizedBox(height: 16),
          Text(title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          Text(detail, textAlign: TextAlign.center),
        ],
      ),
    ),
  );
}

class _Muted extends StatelessWidget {
  final String text;
  const _Muted(this.text);

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Text(
      text,
      style: TextStyle(color: Theme.of(context).colorScheme.outline),
    ),
  );
}

class PairingScannerPage extends StatefulWidget {
  const PairingScannerPage({super.key});

  @override
  State<PairingScannerPage> createState() => _PairingScannerPageState();
}

class _PairingScannerPageState extends State<PairingScannerPage> {
  final _controller = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  bool _handled = false;
  bool _invalid = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw == null) continue;
      if (parsePairingPayload(raw) == null) {
        if (mounted) setState(() => _invalid = true);
        continue;
      }
      _handled = true;
      Navigator.of(context).pop(raw);
      return;
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text(CompanionCopy.scanPairingQr)),
    body: Stack(
      children: [
        MobileScanner(
          controller: _controller,
          onDetect: _onDetect,
          errorBuilder: (_, _) => const Center(
            child: Padding(
              padding: EdgeInsets.all(24),
              child: Text(
                CompanionCopy.cameraRequired,
                textAlign: TextAlign.center,
              ),
            ),
          ),
        ),
        Align(
          alignment: Alignment.bottomCenter,
          child: Container(
            width: double.infinity,
            color: Colors.black87,
            padding: const EdgeInsets.all(20),
            child: Text(
              _invalid ? CompanionCopy.invalidQr : CompanionCopy.qrNotFound,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white),
            ),
          ),
        ),
      ],
    ),
  );
}

class _FinancialLocked implements Exception {
  const _FinancialLocked();
}
