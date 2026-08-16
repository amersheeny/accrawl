import 'package:accrawl_companion/companion_copy.dart';
import 'package:accrawl_companion/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const nativeChannel = MethodChannel('accrawl/sms');

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(nativeChannel, (call) async {
          if (call.method == 'allowsInsecureHttp' ||
              call.method == 'hasSmsPermission') {
            return false;
          }
          return null;
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(nativeChannel, null);
  });

  testWidgets('pairing edit controls expose their visible labels', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(const CompanionApp());
    await tester.pumpAndSettle();

    final fields = find.byType(TextField);
    expect(fields, findsNWidgets(2));
    expect(
      tester.getSemantics(fields.at(0)).label,
      contains(CompanionCopy.consoleAddress),
    );
    expect(
      tester.getSemantics(fields.at(1)).label,
      contains(CompanionCopy.pairingCode),
    );

    semantics.dispose();
  });
}
