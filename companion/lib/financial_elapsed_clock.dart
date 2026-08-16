class FinancialElapsedClock {
  Duration? _nativeElapsedAtSync;
  Duration? _localElapsedAtSync;

  void synchronize({
    required Duration nativeElapsed,
    required Duration localElapsed,
  }) {
    _nativeElapsedAtSync = nativeElapsed;
    _localElapsedAtSync = localElapsed;
  }

  Duration? now(Duration localElapsed) {
    final nativeElapsedAtSync = _nativeElapsedAtSync;
    final localElapsedAtSync = _localElapsedAtSync;
    if (nativeElapsedAtSync == null || localElapsedAtSync == null) return null;
    final sinceSync = localElapsed - localElapsedAtSync;
    if (sinceSync.isNegative) return null;
    return nativeElapsedAtSync + sinceSync;
  }
}
