import 'companion_copy.dart';

class FinancialBalance {
  final double current;
  final double? available;
  final double? limit;
  final DateTime? asOf;

  const FinancialBalance({
    required this.current,
    this.available,
    this.limit,
    this.asOf,
  });

  factory FinancialBalance.fromJson(Map<String, dynamic> json) =>
      FinancialBalance(
        current: (json['current'] as num).toDouble(),
        available: (json['available'] as num?)?.toDouble(),
        limit: (json['limit'] as num?)?.toDouble(),
        asOf: _date(json['asOf']),
      );
}

class FinancialAccount {
  final String id;
  final String connectionId;
  final String institutionName;
  final String? connectionNickname;
  final String type;
  final String subtype;
  final String name;
  final String? description;
  final String currency;
  final FinancialBalance balance;
  final String status;

  const FinancialAccount({
    required this.id,
    required this.connectionId,
    required this.institutionName,
    required this.type,
    required this.subtype,
    required this.name,
    required this.currency,
    required this.balance,
    required this.status,
    this.connectionNickname,
    this.description,
  });

  factory FinancialAccount.fromJson(Map<String, dynamic> json) =>
      FinancialAccount(
        id: json['id'] as String,
        connectionId: json['connectionId'] as String,
        institutionName: json['institutionName'] as String,
        connectionNickname: json['connectionNickname'] as String?,
        type: json['type'] as String? ?? 'other',
        subtype: json['subtype'] as String? ?? 'other',
        name: json['name'] as String? ?? '',
        description: json['description'] as String?,
        currency: json['currency'] as String,
        balance: FinancialBalance.fromJson(
          json['balance'] as Map<String, dynamic>,
        ),
        status: json['status'] as String? ?? 'active',
      );

  bool get isCredit => type == 'credit';
  String get displayName =>
      name.trim().isEmpty ? CompanionCopy.unknownAccount : name;
  String get connectionLabel {
    final nickname = connectionNickname?.trim();
    return nickname == null || nickname.isEmpty ? institutionName : nickname;
  }
}

class FinancialTransaction {
  final String id;
  final String connectionId;
  final String? accountId;
  final String institutionName;
  final String? connectionNickname;
  final String? accountName;
  final DateTime bookingDate;
  final double amount;
  final String currency;
  final String description;
  final String? merchant;
  final String status;

  const FinancialTransaction({
    required this.id,
    required this.connectionId,
    required this.institutionName,
    required this.bookingDate,
    required this.amount,
    required this.currency,
    required this.description,
    required this.status,
    this.accountId,
    this.connectionNickname,
    this.accountName,
    this.merchant,
  });

  factory FinancialTransaction.fromJson(Map<String, dynamic> json) =>
      FinancialTransaction(
        id: json['id'] as String,
        connectionId: json['connectionId'] as String,
        accountId: json['accountId'] as String?,
        institutionName: json['institutionName'] as String,
        connectionNickname: json['connectionNickname'] as String?,
        accountName: json['accountName'] as String?,
        bookingDate: DateTime.parse(json['bookingDate'] as String),
        amount: (json['amount'] as num).toDouble(),
        currency: json['currency'] as String,
        description: json['description'] as String,
        merchant: json['merchant'] as String?,
        status: json['status'] as String? ?? 'posted',
      );

  String get displayName {
    final merchantName = merchant?.trim();
    return merchantName == null || merchantName.isEmpty
        ? description
        : merchantName;
  }

  String get accountLabel {
    final value = accountName?.trim();
    return value == null || value.isEmpty
        ? CompanionCopy.unassignedTransaction
        : value;
  }
}

DateTime? _date(dynamic value) =>
    value is String ? DateTime.tryParse(value) : null;
