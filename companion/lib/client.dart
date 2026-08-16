import 'dart:convert';
import 'dart:typed_data';
import 'package:http/http.dart' as http;
import 'crawl_models.dart';
import 'financial_models.dart';

/// A session currently waiting for a 2FA code.
class AwaitingSession {
  final String id;
  final String connectionId;
  final String? institutionName;

  /// The institution's learned OTP-sender hint. The companion relays an SMS to this session ONLY when the
  /// SMS sender matches this pattern — binding the message to the bank that asked for it, so an unrelated
  /// OTP-looking SMS can't be relayed (a wrong code burns a 2FA attempt). Null when the institution hasn't
  /// learned a pattern yet, in which case the companion refuses and the operator enters the code manually.
  final String? otpSenderPattern;

  /// The current OTP-request episode counter (sessions.otpRequestEpoch on the server). The companion echoes
  /// it back in the relay POST and folds it into its dedupe key, so the SAME SMS body relayed for a genuinely
  /// NEW request (a resend, or a fresh code that reads identically) isn't suppressed as a duplicate of the
  /// previous episode — while a true in-episode duplicate stays a no-op. Defaults to 0 for an older server
  /// that doesn't yet send it.
  final int otpRequestEpoch;
  final String status;
  final DateTime? otpRequestedAt;
  const AwaitingSession(
    this.id,
    this.connectionId,
    this.institutionName, {
    this.otpSenderPattern,
    this.otpRequestEpoch = 0,
    this.status = 'starting',
    this.otpRequestedAt,
  });
}

/// A session currently waiting for a device-proxy tunnel. The control-plane mints a fresh, session+device
/// bound tunnel token per poll; the native TunnelService is what actually opens the engine WS — this view is
/// only so the UI can show which crawls are waiting on this phone.
class AwaitingTunnel {
  final String sessionId;
  final String tunnelToken;
  final String engineWsUrl;
  const AwaitingTunnel(this.sessionId, this.tunnelToken, this.engineWsUrl);
}

/// A recent crawl outcome shown alongside relay and device-proxy activity.
class RecentCrawl {
  final String id;
  final String? institutionName;
  final String? nickname;
  final String status;
  final DateTime? startedAt;
  final DateTime? completedAt;
  final String? error;
  const RecentCrawl({
    required this.id,
    required this.status,
    this.institutionName,
    this.nickname,
    this.startedAt,
    this.completedAt,
    this.error,
  });

  /// A human label for the crawl: the connection's nickname if set, else the institution name, else the id.
  String get label {
    final n = nickname?.trim();
    if (n != null && n.isNotEmpty) return n;
    final i = institutionName?.trim();
    if (i != null && i.isNotEmpty) return i;
    return id;
  }

  /// When the run last changed — its finish time if terminal, otherwise when it started.
  DateTime? get at => completedAt ?? startedAt;
}

/// Parse an ISO-8601 timestamp string (how the control-plane serializes Postgres timestamps over JSON) into a
/// [DateTime], or null when absent/unparseable.
DateTime? _parseIso(dynamic v) => v is String ? DateTime.tryParse(v) : null;

class PairingPayload {
  final String url;
  final String pairingCode;
  const PairingPayload(this.url, this.pairingCode);
}

/// Decode the versioned, opaque QR payload. It carries only a short-lived
/// request secret; final device and financial credentials never enter the QR.
PairingPayload? parsePairingPayload(String raw) {
  try {
    final value = jsonDecode(raw.trim()) as Map<String, dynamic>;
    final url = value['url'];
    final pairingCode = value['pairingCode'];
    if (value['v'] != 1 ||
        url is! String ||
        url.trim().isEmpty ||
        pairingCode is! String ||
        !pairingCode.startsWith('acpair_')) {
      return null;
    }
    return PairingPayload(url.trim(), pairingCode.trim());
  } catch (_) {
    return null;
  }
}

/// Thin client for the device-authenticated slice of the Accrawl control-plane API.
class AccrawlClient {
  final String baseUrl;
  final String deviceToken;
  const AccrawlClient(this.baseUrl, this.deviceToken);

  Map<String, String> get _headers => {
    'authorization': 'Bearer $deviceToken',
    'content-type': 'application/json',
  };

  Uri _u(String path) =>
      Uri.parse('${baseUrl.replaceAll(RegExp(r'/+$'), '')}$path');

  /// Sessions currently awaiting a 2FA code (device-authenticated).
  Future<List<AwaitingSession>> awaitingOtp() async {
    final res = await http.get(
      _u('/api/sessions/awaiting-otp'),
      headers: _headers,
    );
    if (res.statusCode == 401) throw const DeviceUnauthorized();
    if (res.statusCode != 200) throw ClientError(res.statusCode, res.body);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final list = (body['sessions'] as List<dynamic>?) ?? const [];
    return list.map((s) {
      final m = s as Map<String, dynamic>;
      return AwaitingSession(
        m['id'] as String,
        m['connectionId'] as String,
        m['institutionName'] as String?,
        otpSenderPattern: m['otpSenderPattern'] as String?,
        otpRequestEpoch: (m['otpRequestEpoch'] as num?)?.toInt() ?? 0,
        status: m['status'] as String? ?? 'starting',
        otpRequestedAt: _parseIso(m['otpRequestedAt']),
      );
    }).toList();
  }

  /// Sessions currently awaiting a device-proxy tunnel (device-authenticated). Mirrors [awaitingOtp]; the
  /// native TunnelService opens the actual tunnel, so this is purely for surfacing status in the UI.
  Future<List<AwaitingTunnel>> awaitingTunnel() async {
    final res = await http.get(
      _u('/api/sessions/awaiting-tunnel'),
      headers: _headers,
    );
    if (res.statusCode == 401) throw const DeviceUnauthorized();
    if (res.statusCode != 200) throw ClientError(res.statusCode, res.body);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final list = (body['sessions'] as List<dynamic>?) ?? const [];
    return list.map((s) {
      final m = s as Map<String, dynamic>;
      return AwaitingTunnel(
        m['sessionId'] as String,
        m['tunnelToken'] as String,
        m['engineWsUrl'] as String,
      );
    }).toList();
  }

  /// Relay a RAW SMS body to a session for the control-plane to LLM-extract the code from. The companion no
  /// longer parses the code itself (the old regex extractor was a treadmill of edge-case bugs) — it hands the
  /// server the [smsBody] + the [sender] (which the server re-validates against the institution's learned
  /// OTP-sender pattern, defense in depth) + the [otpRequestEpoch] it saw on awaiting-otp (which scopes the
  /// server's idempotency key to this request episode, so a redelivered SMS within one episode is a no-op
  /// while a fresh request is accepted).
  ///
  /// Returns the HTTP status: 202 (a code was extracted + submitted), 200 (no code in the body → not
  /// submitted, the session stays waiting for a manual code), 409 (sender mismatch / stale episode / not
  /// awaiting), 404 (no such session). The server derives the idempotency key from (sessionId|epoch|
  /// sha256(body)), so we don't send one — a same-episode redelivery is no-op'd server-side.
  Future<int> relayOtpSms(
    String sessionId,
    String smsBody,
    String sender,
    int otpRequestEpoch,
  ) async {
    final res = await http.post(
      _u('/api/sessions/$sessionId/otp'),
      headers: _headers,
      body: jsonEncode({
        'smsBody': smsBody,
        'sender': sender,
        'otpRequestEpoch': otpRequestEpoch,
      }),
    );
    if (res.statusCode == 401) throw const DeviceUnauthorized();
    return res.statusCode;
  }

  /// Recent crawl outcomes across all granted connections (device-authenticated), newest first. Accounts,
  /// balances, and transactions are loaded through the dedicated financial-data client below.
  Future<List<RecentCrawl>> recentCrawls() async {
    final res = await http.get(_u('/api/sessions/recent'), headers: _headers);
    if (res.statusCode == 401) throw const DeviceUnauthorized();
    if (res.statusCode != 200) throw ClientError(res.statusCode, res.body);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final list = (body['sessions'] as List<dynamic>?) ?? const [];
    return list.map((s) {
      final m = s as Map<String, dynamic>;
      return RecentCrawl(
        id: m['id'] as String,
        institutionName: m['institutionName'] as String?,
        nickname: m['nickname'] as String?,
        status: m['status'] as String? ?? 'unknown',
        startedAt: _parseIso(m['startedAt']),
        completedAt: _parseIso(m['completedAt']),
        error: m['error'] as String?,
      );
    }).toList();
  }

  /// Register/refresh the push token so the control-plane can wake this device for OTP.
  Future<void> registerPush(String transport, String token) async {
    final res = await http.post(
      _u('/api/devices/push'),
      headers: _headers,
      body: jsonEncode({'pushTransport': transport, 'pushToken': token}),
    );
    if (res.statusCode == 401) throw const DeviceUnauthorized();
    if (res.statusCode != 204) throw ClientError(res.statusCode, res.body);
  }

  Future<void> revokeSelf() async {
    final res = await http.delete(_u('/api/devices/self'), headers: _headers);
    if (res.statusCode == 401) throw const DeviceUnauthorized();
    if (res.statusCode != 204) throw ClientError(res.statusCode, res.body);
  }
}

enum PairingStatus { waitingForApproval, expired, used, cancelled, paired }

class PairingClaimResult {
  final PairingStatus status;
  final String? verificationCode;
  const PairingClaimResult(this.status, {this.verificationCode});
}

class PairingCompletion {
  final PairingStatus status;
  final String? deviceId;
  final String? deviceToken;
  final String? financialToken;
  const PairingCompletion(
    this.status, {
    this.deviceId,
    this.deviceToken,
    this.financialToken,
  });
}

PairingStatus _pairingStatus(dynamic value) {
  switch (value) {
    case 'waiting_for_approval':
    case 'waiting_for_phone':
    case 'approved':
      return PairingStatus.waitingForApproval;
    case 'expired':
      return PairingStatus.expired;
    case 'used':
      return PairingStatus.used;
    case 'cancelled':
      return PairingStatus.cancelled;
    case 'paired':
      return PairingStatus.paired;
    default:
      throw const FormatException('unknown pairing status');
  }
}

class PairingClient {
  final String baseUrl;
  const PairingClient(this.baseUrl);

  Uri _u(String path) =>
      Uri.parse('${baseUrl.replaceAll(RegExp(r'/+$'), '')}$path');

  Future<PairingClaimResult> claim(String pairingCode, String claim) async {
    final res = await http
        .post(
          _u('/api/devices/pairing/claim'),
          headers: const {'content-type': 'application/json'},
          body: jsonEncode({'pairingCode': pairingCode, 'claim': claim}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode == 426) throw const HttpsRequired();
    if (res.statusCode != 200) throw ClientError(res.statusCode, res.body);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return PairingClaimResult(
      _pairingStatus(body['status']),
      verificationCode: body['verificationCode'] as String?,
    );
  }

  Future<PairingCompletion> complete(String pairingCode, String claim) async {
    final res = await http
        .post(
          _u('/api/devices/pairing/complete'),
          headers: const {'content-type': 'application/json'},
          body: jsonEncode({'pairingCode': pairingCode, 'claim': claim}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode == 426) throw const HttpsRequired();
    if (res.statusCode != 200 && res.statusCode != 201) {
      throw ClientError(res.statusCode, res.body);
    }
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return PairingCompletion(
      _pairingStatus(body['status']),
      deviceId: body['deviceId'] as String?,
      deviceToken: body['deviceToken'] as String?,
      financialToken: body['financialToken'] as String?,
    );
  }
}

class FinancialPage<T> {
  final List<T> items;
  final String? nextCursor;
  const FinancialPage(this.items, this.nextCursor);
}

class FinancialClient {
  final String baseUrl;
  final String token;
  const FinancialClient(this.baseUrl, this.token);

  Map<String, String> get _headers => {
    'authorization': 'Bearer $token',
    'content-type': 'application/json',
  };

  Uri _u(String path, [String? cursor]) {
    final uri = Uri.parse('${baseUrl.replaceAll(RegExp(r'/+$'), '')}$path');
    return cursor == null
        ? uri.replace(queryParameters: const {'limit': '50'})
        : uri.replace(queryParameters: {'limit': '50', 'cursor': cursor});
  }

  Future<FinancialPage<FinancialAccount>> accounts([String? cursor]) async {
    final res = await http.get(
      _u('/api/companion/accounts', cursor),
      headers: _headers,
    );
    if (res.statusCode == 401) throw const FinancialUnauthorized();
    if (res.statusCode == 426) throw const HttpsRequired();
    if (res.statusCode != 200) throw ClientError(res.statusCode, res.body);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return FinancialPage(
      ((body['items'] as List<dynamic>?) ?? const [])
          .map(
            (item) => FinancialAccount.fromJson(item as Map<String, dynamic>),
          )
          .toList(),
      body['nextCursor'] as String?,
    );
  }

  Future<FinancialPage<FinancialTransaction>> transactions({
    String? cursor,
    String? accountId,
  }) async {
    final path = accountId == null
        ? '/api/companion/transactions'
        : '/api/companion/accounts/${Uri.encodeComponent(accountId)}/transactions';
    final res = await http.get(_u(path, cursor), headers: _headers);
    if (res.statusCode == 401) throw const FinancialUnauthorized();
    if (res.statusCode == 426) throw const HttpsRequired();
    if (res.statusCode != 200) throw ClientError(res.statusCode, res.body);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return FinancialPage(
      ((body['items'] as List<dynamic>?) ?? const [])
          .map(
            (item) =>
                FinancialTransaction.fromJson(item as Map<String, dynamic>),
          )
          .toList(),
      body['nextCursor'] as String?,
    );
  }

  Future<CrawlEvidence> crawlEvidence(String sessionId) async {
    final id = Uri.encodeComponent(sessionId);
    final responses = await Future.wait([
      http.get(_u('/api/sessions/$id'), headers: _headers),
      http.get(_u('/api/sessions/$id/steps'), headers: _headers),
      http.get(_u('/api/sessions/$id/records'), headers: _headers),
    ]);
    for (final response in responses) {
      if (response.statusCode == 401) throw const FinancialUnauthorized();
      if (response.statusCode == 426) throw const HttpsRequired();
      if (response.statusCode != 200) {
        throw ClientError(response.statusCode, response.body);
      }
    }
    final sessionBody = jsonDecode(responses[0].body);
    final stepsBody = jsonDecode(responses[1].body);
    final recordsBody = jsonDecode(responses[2].body);
    if (sessionBody is! Map<String, dynamic> ||
        stepsBody is! Map<String, dynamic> ||
        recordsBody is! Map<String, dynamic>) {
      throw const FormatException('invalid crawl evidence response');
    }
    final rawSteps = stepsBody['steps'];
    if (rawSteps is! List<dynamic>) {
      throw const FormatException('invalid crawl steps response');
    }
    return CrawlEvidence(
      session: CrawlSessionDetails.fromJson(sessionBody),
      steps: rawSteps.map((item) {
        if (item is! Map<String, dynamic>) {
          throw const FormatException('invalid crawl step');
        }
        return CrawlStep.fromJson(item);
      }).toList(),
      records: CrawlRecords.fromJson(recordsBody),
    );
  }

  Future<Uint8List> crawlScreenshot(String sessionId, int stepNumber) async {
    final id = Uri.encodeComponent(sessionId);
    final response = await http.get(
      _u('/api/sessions/$id/steps/$stepNumber/screenshot'),
      headers: _headers,
    );
    if (response.statusCode == 401) throw const FinancialUnauthorized();
    if (response.statusCode == 426) throw const HttpsRequired();
    if (response.statusCode != 200) {
      throw ClientError(response.statusCode, response.body);
    }
    final contentType = response.headers['content-type'] ?? '';
    if (!contentType.startsWith('image/')) {
      throw const FormatException('invalid screenshot response');
    }
    return response.bodyBytes;
  }
}

/// Smallest pattern we'll trust to bind a code to a bank. A 1–2 char pattern (e.g. a stray "1", "AB")
/// matches far too many senders to be a real binding, so we refuse it — the operator types the code instead.
const int _minSenderPatternLength = 3;

/// Does an SMS `sender` match an institution's learned [pattern]? The pattern is treated as a case-insensitive
/// LITERAL that must EXACTLY EQUAL the SMS sender (both trimmed) — NOT a substring. A substring/contains test
/// let a spoofed sender like `FAKE-BANKCO` match the bank's `BANKCO` pattern and relay a code from an
/// attacker-controlled number (a wrong code burns a 2FA attempt); requiring exact equality closes that hole.
/// It is NEVER interpreted as a regex: a too-broad pattern like `.*`, `.+`, or `NORTH|.*` would otherwise
/// match and defeat the binding, and an attacker-supplied pattern could trigger ReDoS. An empty/whitespace
/// pattern, or one shorter than [_minSenderPatternLength] after trimming, never matches — we must never relay
/// to a session with no real (meaningful) sender binding. Mirrored exactly by NativeRelay.senderMatches on
/// the Kotlin side.
bool senderMatches(String sender, String? pattern) {
  final p = pattern?.trim();
  if (p == null || p.length < _minSenderPatternLength) return false;
  final s = sender.trim();
  if (s.isEmpty) return false;
  return s.toLowerCase() == p.toLowerCase();
}

class DeviceUnauthorized implements Exception {
  const DeviceUnauthorized();
  @override
  String toString() => 'device token rejected (revoked or invalid)';
}

class FinancialUnauthorized implements Exception {
  const FinancialUnauthorized();
}

class HttpsRequired implements Exception {
  const HttpsRequired();
}

class ClientError implements Exception {
  final int status;
  final String body;
  const ClientError(this.status, this.body);
  @override
  String toString() => 'ClientError($status): $body';
}
