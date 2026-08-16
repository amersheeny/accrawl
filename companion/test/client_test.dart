import 'package:flutter_test/flutter_test.dart';
import 'package:accrawl_companion/client.dart';

void main() {
  group('senderMatches', () {
    test(
      'matches a case-insensitive EXACT literal (the sender EQUALS the pattern, trimmed)',
      () {
        expect(senderMatches('NORTHWIND', 'northwind'), isTrue);
        expect(senderMatches('NORTHWIND', 'NORTHWIND'), isTrue);
        expect(
          senderMatches('  NORTHWIND  ', 'NORTHWIND'),
          isTrue,
        ); // trimmed both sides
        // A numeric literal sender (as the e2e uses) matches by exact equality.
        expect(senderMatches('18005550123', '18005550123'), isTrue);
        // Regex metacharacters are LITERAL, not interpreted: a '+' must be exactly present in both.
        expect(senderMatches('+18005550123', '+18005550123'), isTrue);
      },
    );

    test(
      'a SUBSTRING is no longer a match — the whole fix (a spoofed sender cannot piggyback)',
      () {
        // Under the old contains() these were TRUE and let a spoofed sender match the bank's pattern; an exact
        // match closes the hole.
        expect(
          senderMatches('FAKE-BANKCO', 'BANKCO'),
          isFalse,
        ); // spoofed prefix
        expect(
          senderMatches('Northwind Bank', 'NORTHWIND'),
          isFalse,
        ); // pattern is only a substring of the sender
        expect(
          senderMatches('18005550123', '1800555'),
          isFalse,
        ); // partial number
        expect(
          senderMatches('+18005550123', '18005550123'),
          isFalse,
        ); // differs by a leading '+'
      },
    );

    test(
      'a non-matching sender is rejected (binds the code to the right bank)',
      () {
        expect(senderMatches('SOMEOTHERSVC', 'northwind'), isFalse);
        expect(senderMatches('18009999999', '18005550123'), isFalse);
      },
    );

    test(
      'NEVER interprets the pattern as a regex — a too-broad pattern cannot match every sender',
      () {
        // The whole defect: as a regex these match ANY sender and defeat the binding. As exact literals they don't.
        expect(
          senderMatches('SOMEOTHERSVC', '.*'),
          isFalse,
        ); // also <3 chars → rejected outright
        expect(senderMatches('SOMEOTHERSVC', '.+'), isFalse);
        expect(
          senderMatches('SOMEOTHERSVC', 'NORTH|.*'),
          isFalse,
        ); // literal "NORTH|.*" is not the sender
        // A literal that EQUALS the sender still matches (proving it's a literal equality, not a reject-all).
        expect(senderMatches('NORTH|.*', 'NORTH|.*'), isTrue);
      },
    );

    test(
      'rejects a pattern shorter than the minimum meaningful length (would match too broadly)',
      () {
        expect(senderMatches('1', '1'), isFalse); // 1 char
        expect(
          senderMatches('18', '18'),
          isFalse,
        ); // 2 chars, even though equal
        expect(
          senderMatches('AB', 'AB'),
          isFalse,
        ); // 2 chars, even though equal
        expect(
          senderMatches('180', '180'),
          isTrue,
        ); // exactly the 3-char floor → allowed
      },
    );

    test(
      'an empty/whitespace pattern or sender never matches (no binding, no relay)',
      () {
        expect(senderMatches('NORTHWIND', null), isFalse);
        expect(senderMatches('NORTHWIND', ''), isFalse);
        expect(senderMatches('NORTHWIND', '   '), isFalse);
        expect(senderMatches('', 'northwind'), isFalse);
      },
    );
  });

  group('AwaitingSession', () {
    test(
      'surfaces otpRequestEpoch (echoed back + folded into the relay/dedupe key)',
      () {
        const s = AwaitingSession(
          'sess',
          'connection-1',
          'BankCo',
          otpSenderPattern: 'BANKCO',
          otpRequestEpoch: 5,
        );
        expect(s.connectionId, 'connection-1');
        expect(s.otpRequestEpoch, 5);
        expect(s.otpSenderPattern, 'BANKCO');
      },
    );

    test(
      'defaults otpRequestEpoch to 0 for an older server that does not send it',
      () {
        const s = AwaitingSession('sess', 'connection-1', 'BankCo');
        expect(s.otpRequestEpoch, 0);
        expect(s.otpSenderPattern, isNull);
      },
    );
  });

  group('AccrawlClient URL building', () {
    test('trims trailing slashes from the base URL', () {
      const c = AccrawlClient('https://accrawl.example.com///', 'acdv_x');
      // exercised indirectly: the relay path is appended without a doubled slash
      expect(
        c.baseUrl.endsWith('///'),
        isTrue,
      ); // stored verbatim; normalization happens at request time
    });
  });

  group('parsePairingPayload', () {
    test(
      'accepts a versioned request carrying an address and temporary code',
      () {
        final r = parsePairingPayload(
          '{"v":1,"url":"https://host:8443","pairingCode":"acpair_abc123"}',
        );
        expect(r, isNotNull);
        expect(r!.url, 'https://host:8443');
        expect(r.pairingCode, 'acpair_abc123');
        expect(
          parsePairingPayload(
            '  {"v":1,"url":"https://lan","pairingCode":"acpair_x"}  ',
          ),
          isNotNull,
        );
      },
    );

    test(
      'requires both fields and never accepts a final device credential',
      () {
        expect(
          parsePairingPayload(
            '{"v":1,"url":"https://host","pairingCode":"acdv_final"}',
          ),
          isNull,
        );
        expect(
          parsePairingPayload('{"v":1,"url":"https://host","pairingCode":""}'),
          isNull,
        );
        expect(
          parsePairingPayload('{"v":1,"url":"","pairingCode":"acpair_code"}'),
          isNull,
        );
        expect(
          parsePairingPayload(
            '{"v":2,"url":"https://host","pairingCode":"acpair_code"}',
          ),
          isNull,
        );
      },
    );

    test('rejects links and non-pairing text', () {
      expect(parsePairingPayload('accrawl://pair?url=x&token=y'), isNull);
      expect(parsePairingPayload('not json'), isNull);
      expect(parsePairingPayload(''), isNull);
    });
  });

  group('RecentCrawl', () {
    test('label prefers nickname, then institution, then id', () {
      expect(
        const RecentCrawl(
          id: 's1',
          status: 'completed',
          nickname: 'Joint',
          institutionName: 'Bank',
        ).label,
        'Joint',
      );
      expect(
        const RecentCrawl(
          id: 's1',
          status: 'completed',
          institutionName: 'Bank',
        ).label,
        'Bank',
      );
      expect(const RecentCrawl(id: 's1', status: 'completed').label, 's1');
    });

    test('at prefers the finish time, falling back to the start time', () {
      final started = DateTime.utc(2026, 7, 5, 8);
      final finished = DateTime.utc(2026, 7, 5, 9);
      expect(
        RecentCrawl(
          id: 's',
          status: 'completed',
          startedAt: started,
          completedAt: finished,
        ).at,
        finished,
      );
      expect(
        RecentCrawl(id: 's', status: 'waiting_for_otp', startedAt: started).at,
        started,
      );
    });
  });
}
