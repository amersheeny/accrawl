import 'package:accrawl_companion/financial_unlock_lifecycle.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('device credential overlay waits for the app to resume', () async {
    final lifecycle = FinancialUnlockLifecycle();
    lifecycle.beginCredentialPrompt();

    lifecycle.didChange(AppLifecycleState.inactive, unlockInProgress: true);
    final resumed = lifecycle.waitForResumeAfterCredentialPrompt();
    lifecycle.didChange(AppLifecycleState.resumed, unlockInProgress: true);

    expect(await resumed, isTrue);
    lifecycle.endCredentialPrompt();
  });

  test(
    'full-screen device credential flow may pause and hide before resume',
    () async {
      final lifecycle = FinancialUnlockLifecycle();
      lifecycle.beginCredentialPrompt();

      lifecycle.didChange(AppLifecycleState.inactive, unlockInProgress: true);
      lifecycle.didChange(AppLifecycleState.paused, unlockInProgress: true);
      lifecycle.didChange(AppLifecycleState.hidden, unlockInProgress: true);
      final resumed = lifecycle.waitForResumeAfterCredentialPrompt();
      lifecycle.didChange(AppLifecycleState.resumed, unlockInProgress: true);

      expect(await resumed, isTrue);
      lifecycle.endCredentialPrompt();
    },
  );

  test('backgrounding during device authentication cancels unlock', () async {
    final lifecycle = FinancialUnlockLifecycle();

    lifecycle.didChange(AppLifecycleState.inactive, unlockInProgress: true);
    final resumed = lifecycle.waitForResumeAfterCredentialPrompt();

    lifecycle.didChange(AppLifecycleState.hidden, unlockInProgress: true);
    expect(await resumed, isFalse);
  });

  test(
    'inactive outside an unlock prompt does not create a resume wait',
    () async {
      final lifecycle = FinancialUnlockLifecycle();

      lifecycle.didChange(AppLifecycleState.inactive, unlockInProgress: false);
      expect(await lifecycle.waitForResumeAfterCredentialPrompt(), isFalse);
    },
  );
}
