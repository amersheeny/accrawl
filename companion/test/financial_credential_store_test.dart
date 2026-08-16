import 'package:accrawl_companion/financial_credential_store.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const storageChannel = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );
  const nativeChannel = MethodChannel('accrawl/sms');
  final storageCalls = <MethodCall>[];
  final nativeCalls = <MethodCall>[];
  var authenticate = true;

  setUp(() {
    storageCalls.clear();
    nativeCalls.clear();
    authenticate = true;
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(storageChannel, (call) async {
          storageCalls.add(call);
          if (call.method == 'read') return 'financial-token';
          return null;
        });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(nativeChannel, (call) async {
          nativeCalls.add(call);
          return authenticate;
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(storageChannel, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(nativeChannel, null);
    debugDefaultTargetPlatformOverride = null;
  });

  test('save releases authenticated cipher state', () async {
    await const FinancialCredentialStore().save('financial-token');

    expect(nativeCalls.map((call) => call.method), [
      'authenticateFinancialCredential',
    ]);
    expect(storageCalls.map((call) => call.method), ['write', 'lock']);
  });

  test('unlock authenticates from a fresh cipher and releases it', () async {
    final token = await const FinancialCredentialStore().unlock();

    expect(token, 'financial-token');
    expect(nativeCalls.map((call) => call.method), [
      'authenticateFinancialCredential',
    ]);
    expect(storageCalls.map((call) => call.method), ['lock', 'read', 'lock']);
  });

  test('cancelled authentication never reads or writes the token', () async {
    authenticate = false;

    await expectLater(
      const FinancialCredentialStore().save('financial-token'),
      throwsStateError,
    );
    expect(await const FinancialCredentialStore().unlock(), isNull);
    expect(storageCalls.map((call) => call.method), ['lock']);
  });

  test('clear destroys ciphertext without requiring authentication', () async {
    await const FinancialCredentialStore().clear();

    expect(storageCalls.map((call) => call.method), [
      'deleteWithoutAuthentication',
      'lock',
    ]);
    expect(nativeCalls, isEmpty);
  });
}
