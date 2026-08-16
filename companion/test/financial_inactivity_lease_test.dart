import 'package:accrawl_companion/financial_inactivity_lease.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const startedAt = Duration(seconds: 10);

  test('expires only after five minutes without activity', () {
    final lease = FinancialInactivityLease();

    lease.start(startedAt);

    expect(
      lease.remaining(startedAt + const Duration(minutes: 4, seconds: 59)),
      const Duration(seconds: 1),
    );
    expect(
      lease.remaining(startedAt + financialInactivityTimeout),
      Duration.zero,
    );
  });

  test('user activity restarts the inactivity window', () {
    final lease = FinancialInactivityLease();
    lease.start(startedAt);

    final activityAt = startedAt + const Duration(minutes: 4);
    expect(lease.recordActivity(activityAt), isTrue);

    expect(
      lease.remaining(activityAt + const Duration(minutes: 4)),
      const Duration(minutes: 1),
    );
  });

  test('activity at or after the deadline cannot revive an expired lease', () {
    for (final elapsed in [
      financialInactivityTimeout,
      financialInactivityTimeout + const Duration(seconds: 1),
    ]) {
      final lease = FinancialInactivityLease();
      lease.start(startedAt);

      expect(lease.recordActivity(startedAt + elapsed), isFalse);
      expect(lease.active, isFalse);
    }
  });

  test('a monotonic clock regression expires rather than extending access', () {
    final lease = FinancialInactivityLease();
    lease.start(startedAt);

    expect(
      lease.remaining(startedAt - const Duration(seconds: 1)),
      Duration.zero,
    );
    expect(
      lease.recordActivity(startedAt - const Duration(seconds: 1)),
      isFalse,
    );
  });

  test('clear ends the active lease', () {
    final lease = FinancialInactivityLease();
    lease.start(startedAt);

    lease.clear();

    expect(lease.active, isFalse);
    expect(lease.remaining(startedAt), isNull);
  });
}
