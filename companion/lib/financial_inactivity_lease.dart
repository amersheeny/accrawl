const financialInactivityTimeout = Duration(minutes: 5);

class FinancialInactivityLease {
  FinancialInactivityLease({this.timeout = financialInactivityTimeout});

  final Duration timeout;
  Duration? _lastActivityAt;

  bool get active => _lastActivityAt != null;

  void start(Duration now) {
    _lastActivityAt = now;
  }

  bool recordActivity(Duration now) {
    if (!active || remaining(now)! <= Duration.zero) {
      clear();
      return false;
    }
    _lastActivityAt = now;
    return true;
  }

  Duration? remaining(Duration now) {
    final lastActivityAt = _lastActivityAt;
    if (lastActivityAt == null) return null;
    final elapsed = now - lastActivityAt;
    if (elapsed.isNegative) return Duration.zero;
    if (elapsed >= timeout) return Duration.zero;
    return timeout - elapsed;
  }

  void clear() {
    _lastActivityAt = null;
  }
}
