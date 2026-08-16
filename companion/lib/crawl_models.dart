class CrawlCost {
  final double totalCostUsd;

  const CrawlCost({required this.totalCostUsd});

  factory CrawlCost.fromJson(Map<String, dynamic> json) =>
      CrawlCost(totalCostUsd: (json['totalCostUsd'] as num).toDouble());
}

class CrawlSessionDetails {
  final String id;
  final String connectionId;
  final String status;
  final String? currentStep;
  final int stepCount;
  final String? error;
  final DateTime? startedAt;
  final DateTime? completedAt;
  final CrawlCost? cost;

  const CrawlSessionDetails({
    required this.id,
    required this.connectionId,
    required this.status,
    required this.stepCount,
    this.currentStep,
    this.error,
    this.startedAt,
    this.completedAt,
    this.cost,
  });

  factory CrawlSessionDetails.fromJson(Map<String, dynamic> json) =>
      CrawlSessionDetails(
        id: json['id'] as String,
        connectionId: json['connectionId'] as String,
        status: json['status'] as String,
        currentStep: json['currentStep'] as String?,
        stepCount: (json['stepCount'] as num).toInt(),
        error: json['error'] as String?,
        startedAt: _date(json['startedAt']),
        completedAt: _date(json['completedAt']),
        cost: json['cost'] == null
            ? null
            : CrawlCost.fromJson(json['cost'] as Map<String, dynamic>),
      );
}

class CrawlStep {
  final int stepNumber;
  final String action;
  final String? description;
  final String? url;
  final int? durationMs;
  final String? error;
  final bool hasScreenshot;
  final int accountsExtracted;
  final int transactionsExtracted;
  final int positionsExtracted;
  final DateTime? createdAt;

  const CrawlStep({
    required this.stepNumber,
    required this.action,
    required this.hasScreenshot,
    required this.accountsExtracted,
    required this.transactionsExtracted,
    required this.positionsExtracted,
    this.description,
    this.url,
    this.durationMs,
    this.error,
    this.createdAt,
  });

  factory CrawlStep.fromJson(Map<String, dynamic> json) => CrawlStep(
    stepNumber: (json['stepNumber'] as num).toInt(),
    action: json['action'] as String,
    description: json['description'] as String?,
    url: json['url'] as String?,
    durationMs: (json['durationMs'] as num?)?.toInt(),
    error: json['error'] as String?,
    hasScreenshot: json['hasScreenshot'] as bool? ?? false,
    accountsExtracted: (json['accountsExtracted'] as num?)?.toInt() ?? 0,
    transactionsExtracted:
        (json['transactionsExtracted'] as num?)?.toInt() ?? 0,
    positionsExtracted: (json['positionsExtracted'] as num?)?.toInt() ?? 0,
    createdAt: _date(json['createdAt']),
  );

  String get label {
    final value = description?.trim();
    return value == null || value.isEmpty ? action : value;
  }
}

class CrawlRecordCounts {
  final int accounts;
  final int transactions;
  final int positions;

  const CrawlRecordCounts({
    required this.accounts,
    required this.transactions,
    required this.positions,
  });

  factory CrawlRecordCounts.fromJson(Map<String, dynamic> json) =>
      CrawlRecordCounts(
        accounts: (json['accounts'] as num).toInt(),
        transactions: (json['transactions'] as num).toInt(),
        positions: (json['positions'] as num).toInt(),
      );

  bool get isEmpty => accounts == 0 && transactions == 0 && positions == 0;
}

class CrawlAccountRecord {
  final String providerAccountId;
  final String name;
  final String description;
  final String currency;
  final String type;
  final double balance;

  const CrawlAccountRecord({
    required this.providerAccountId,
    required this.name,
    required this.description,
    required this.currency,
    required this.type,
    required this.balance,
  });

  factory CrawlAccountRecord.fromJson(Map<String, dynamic> json) =>
      CrawlAccountRecord(
        providerAccountId: json['providerAccountId'] as String,
        name: json['name'] as String,
        description: json['description'] as String? ?? '',
        currency: json['currency'] as String,
        type: json['type'] as String,
        balance: (json['balance'] as num).toDouble(),
      );
}

class CrawlTransactionRecord {
  final String? providerAccountId;
  final String providerTransactionId;
  final DateTime bookingDate;
  final double amount;
  final String currency;
  final String? merchant;
  final String description;
  final bool isPending;

  const CrawlTransactionRecord({
    required this.providerTransactionId,
    required this.bookingDate,
    required this.amount,
    required this.currency,
    required this.description,
    required this.isPending,
    this.providerAccountId,
    this.merchant,
  });

  factory CrawlTransactionRecord.fromJson(Map<String, dynamic> json) =>
      CrawlTransactionRecord(
        providerAccountId: json['providerAccountId'] as String?,
        providerTransactionId: json['providerTransactionId'] as String,
        bookingDate: DateTime.parse(json['bookingDate'] as String),
        amount: (json['amount'] as num).toDouble(),
        currency: json['currency'] as String,
        merchant: json['merchant'] as String?,
        description: json['description'] as String,
        isPending: json['isPending'] as bool,
      );

  String get label {
    final value = merchant?.trim();
    return value == null || value.isEmpty ? description : value;
  }
}

class CrawlPositionRecord {
  final String providerPositionId;
  final String? symbol;
  final String name;
  final double quantity;
  final String currency;
  final double valueNative;
  final double? costBasisNative;

  const CrawlPositionRecord({
    required this.providerPositionId,
    required this.name,
    required this.quantity,
    required this.currency,
    required this.valueNative,
    this.symbol,
    this.costBasisNative,
  });

  factory CrawlPositionRecord.fromJson(Map<String, dynamic> json) =>
      CrawlPositionRecord(
        providerPositionId: json['providerPositionId'] as String,
        symbol: json['symbol'] as String?,
        name: json['name'] as String,
        quantity: (json['quantity'] as num).toDouble(),
        currency: json['currency'] as String,
        valueNative: (json['valueNative'] as num).toDouble(),
        costBasisNative: (json['costBasisNative'] as num?)?.toDouble(),
      );
}

class CrawlRecords {
  final CrawlRecordCounts counts;
  final List<CrawlAccountRecord> accounts;
  final List<CrawlTransactionRecord> transactions;
  final List<CrawlPositionRecord> positions;

  const CrawlRecords({
    required this.counts,
    required this.accounts,
    required this.transactions,
    required this.positions,
  });

  factory CrawlRecords.fromJson(Map<String, dynamic> json) => CrawlRecords(
    counts: CrawlRecordCounts.fromJson(json['counts'] as Map<String, dynamic>),
    accounts: _maps(json['accounts']).map(CrawlAccountRecord.fromJson).toList(),
    transactions: _maps(
      json['transactions'],
    ).map(CrawlTransactionRecord.fromJson).toList(),
    positions: _maps(
      json['positions'],
    ).map(CrawlPositionRecord.fromJson).toList(),
  );
}

class CrawlEvidence {
  final CrawlSessionDetails session;
  final List<CrawlStep> steps;
  final CrawlRecords records;

  const CrawlEvidence({
    required this.session,
    required this.steps,
    required this.records,
  });
}

List<Map<String, dynamic>> _maps(dynamic value) {
  if (value is! List<dynamic>) throw const FormatException('expected list');
  return value.map((item) {
    if (item is! Map<String, dynamic>) {
      throw const FormatException('expected object');
    }
    return item;
  }).toList();
}

DateTime? _date(dynamic value) =>
    value is String ? DateTime.tryParse(value) : null;
