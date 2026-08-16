import 'package:accrawl_companion/companion_copy.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('reviewed copy templates substitute every placeholder', () {
    expect(
      CompanionCopy.updated('2m ago', '1 Jan 2030, 12:00'),
      'Updated 2m ago (1 Jan 2030, 12:00)',
    );
    expect(CompanionCopy.asOf('1 Jan 2030'), 'As of 1 Jan 2030');
    expect(
      CompanionCopy.connectionCrawl('connection-1', 'session-1'),
      'Connection connection-1 · Crawl session-1',
    );
    expect(CompanionCopy.crawl('session-1'), 'Crawl session-1');
    expect(
      CompanionCopy.proxyUsage(3, '42 KB'),
      'Requests: 3. Data transferred: 42 KB.',
    );
    expect(CompanionCopy.minutesAgo(2), '2m ago');
    expect(CompanionCopy.hoursAgo(3), '3h ago');
    expect(CompanionCopy.daysAgo(4), '4d ago');
  });
}
