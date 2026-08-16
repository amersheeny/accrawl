import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter/services.dart';

import 'companion_copy.dart';

class FinancialCredentialStore {
  static const _key = 'financial_access_token';
  static const _native = MethodChannel('accrawl/sms');

  final FlutterSecureStorage _storage;

  const FinancialCredentialStore({
    this._storage = const FlutterSecureStorage(
      aOptions: AndroidOptions.biometric(
        enforceBiometrics: true,
        biometricType: AndroidBiometricType.biometricOrDeviceCredential,
        resetOnError: false,
        migrateOnAlgorithmChange: true,
        migrateWithBackup: false,
        storageNamespace: 'accrawl_companion_financial',
        biometricPromptTitle: CompanionCopy.unlockFinancialData,
        biometricPromptSubtitle: CompanionCopy.unlockExplanation,
      ),
    ),
  });

  Future<bool> _authenticateLegacyDeviceCredential() async =>
      await _native.invokeMethod<bool>('authenticateFinancialCredential', {
        'title': CompanionCopy.unlockFinancialData,
        'subtitle': CompanionCopy.unlockExplanation,
      }) ??
      false;

  Future<void> save(String token) async {
    if (!await _authenticateLegacyDeviceCredential()) {
      throw StateError('Device credential authentication was not completed');
    }
    try {
      await _storage.write(key: _key, value: token);
    } finally {
      await _storage.lock();
    }
  }

  Future<String?> unlock() async {
    await _storage.lock();
    if (!await _authenticateLegacyDeviceCredential()) return null;
    try {
      return await _storage.read(key: _key);
    } finally {
      await _storage.lock();
    }
  }

  Future<void> clear() async {
    try {
      await _storage.deleteWithoutAuthentication(key: _key);
    } finally {
      await _storage.lock();
    }
  }

  Future<void> lock() => _storage.lock();
}
