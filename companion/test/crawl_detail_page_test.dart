import 'dart:convert';
import 'dart:typed_data';

import 'package:accrawl_companion/client.dart';
import 'package:accrawl_companion/companion_copy.dart';
import 'package:accrawl_companion/crawl_detail_page.dart';
import 'package:accrawl_companion/crawl_models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeFinancialClient extends FinancialClient {
  final CrawlEvidence evidence;

  const _FakeFinancialClient(this.evidence)
    : super('https://accrawl.example.com', 'financial-token');

  @override
  Future<CrawlEvidence> crawlEvidence(String sessionId) async => evidence;

  @override
  Future<Uint8List> crawlScreenshot(
    String sessionId,
    int stepNumber,
  ) async => base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  );
}

void main() {
  final evidence = CrawlEvidence(
    session: CrawlSessionDetails(
      id: 'crawl-1',
      connectionId: 'connection-1',
      status: 'completed',
      stepCount: 1,
      startedAt: DateTime.utc(2026, 8, 1, 8),
      completedAt: DateTime.utc(2026, 8, 1, 8, 1),
    ),
    steps: const [
      CrawlStep(
        stepNumber: 1,
        action: 'extract',
        description: 'Read account overview',
        hasScreenshot: true,
        accountsExtracted: 1,
        transactionsExtracted: 1,
        positionsExtracted: 1,
      ),
    ],
    records: CrawlRecords(
      counts: const CrawlRecordCounts(
        accounts: 1,
        transactions: 1,
        positions: 1,
      ),
      accounts: const [
        CrawlAccountRecord(
          providerAccountId: 'account-1',
          name: 'Current account',
          description: '',
          currency: 'GBP',
          type: 'current',
          balance: 42,
        ),
      ],
      transactions: [
        CrawlTransactionRecord(
          providerTransactionId: 'transaction-1',
          bookingDate: DateTime.utc(2026, 8, 1),
          amount: -4.2,
          currency: 'GBP',
          description: 'Coffee',
          isPending: false,
        ),
      ],
      positions: const [
        CrawlPositionRecord(
          providerPositionId: 'position-1',
          name: 'Example fund',
          quantity: 2,
          currency: 'GBP',
          valueNative: 84,
        ),
      ],
    ),
  );

  testWidgets('opens crawl steps, screenshots, and extracted results', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: CrawlDetailPage(
          crawl: const RecentCrawl(
            id: 'crawl-1',
            status: 'completed',
            institutionName: 'Example Bank',
          ),
          client: _FakeFinancialClient(evidence),
          onFinancialAccessRevoked: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Example Bank'), findsOneWidget);
    expect(find.text('Read account overview'), findsOneWidget);

    await tester.tap(find.text(CompanionCopy.crawlScreenshots));
    await tester.pumpAndSettle();
    expect(find.byType(Image), findsOneWidget);

    await tester.tap(find.text(CompanionCopy.crawlResults));
    await tester.pumpAndSettle();
    expect(find.text('Current account'), findsOneWidget);
    expect(find.text('Coffee'), findsOneWidget);
    expect(find.text('Example fund'), findsOneWidget);
  });

  test('rejects malformed crawl evidence at the JSON boundary', () {
    expect(
      () => CrawlSessionDetails.fromJson({
        'id': 'crawl-1',
        'connectionId': 'connection-1',
        'status': 'completed',
        'stepCount': 'one',
      }),
      throwsA(isA<TypeError>()),
    );
    expect(
      () => CrawlRecords.fromJson({
        'counts': {'accounts': 0, 'transactions': 0, 'positions': 0},
        'accounts': 'not-a-list',
        'transactions': <dynamic>[],
        'positions': <dynamic>[],
      }),
      throwsFormatException,
    );
  });
}
