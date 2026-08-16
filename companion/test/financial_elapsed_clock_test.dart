import 'package:accrawl_companion/financial_elapsed_clock.dart';
import 'package:accrawl_companion/financial_inactivity_lease.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('foreground time advances from the Android elapsed-realtime sample', () {
    final clock = FinancialElapsedClock()
      ..synchronize(
        nativeElapsed: const Duration(hours: 3),
        localElapsed: const Duration(minutes: 10),
      );

    expect(
      clock.now(const Duration(minutes: 12)),
      const Duration(hours: 3, minutes: 2),
    );
  });

  test('resume resynchronization includes time spent in device sleep', () {
    final clock = FinancialElapsedClock()
      ..synchronize(
        nativeElapsed: const Duration(hours: 3),
        localElapsed: const Duration(minutes: 10),
      );
    final lease = FinancialInactivityLease();
    lease.start(clock.now(const Duration(minutes: 10))!);

    clock.synchronize(
      nativeElapsed: const Duration(hours: 3, minutes: 6),
      localElapsed: const Duration(minutes: 10, seconds: 1),
    );

    expect(
      lease.recordActivity(clock.now(const Duration(minutes: 10, seconds: 1))!),
      isFalse,
    );
  });

  test('expired key or accessibility input cannot run a guarded action', () {
    final lease = FinancialInactivityLease();
    lease.start(Duration.zero);
    var exposedFinancialDetail = false;

    if (lease.recordActivity(financialInactivityTimeout)) {
      exposedFinancialDetail = true;
    }

    expect(exposedFinancialDetail, isFalse);
  });
}
