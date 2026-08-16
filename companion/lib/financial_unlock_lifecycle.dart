import 'dart:async';

import 'package:flutter/widgets.dart';

class FinancialUnlockLifecycle {
  AppLifecycleState _state = AppLifecycleState.resumed;
  Completer<bool>? _resumeAfterCredentialPrompt;
  bool _credentialPromptExpected = false;

  void beginCredentialPrompt() {
    _credentialPromptExpected = true;
  }

  void endCredentialPrompt() {
    _credentialPromptExpected = false;
  }

  void didChange(AppLifecycleState state, {required bool unlockInProgress}) {
    _state = state;
    if (state == AppLifecycleState.resumed) {
      _completeResumeWaiter(true);
      return;
    }
    if (_credentialPromptExpected && unlockInProgress) {
      return;
    }
    _completeResumeWaiter(false);
  }

  Future<bool> waitForResumeAfterCredentialPrompt() {
    if (_state == AppLifecycleState.resumed) {
      return Future<bool>.value(true);
    }
    if (!_credentialPromptExpected) {
      return Future<bool>.value(false);
    }
    return (_resumeAfterCredentialPrompt ??= Completer<bool>()).future;
  }

  void _completeResumeWaiter(bool resumed) {
    final waiter = _resumeAfterCredentialPrompt;
    _resumeAfterCredentialPrompt = null;
    if (waiter != null && !waiter.isCompleted) {
      waiter.complete(resumed);
    }
  }
}
