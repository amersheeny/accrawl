import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'client.dart';
import 'companion_copy.dart';
import 'crawl_models.dart';

class CrawlDetailPage extends StatefulWidget {
  final RecentCrawl crawl;
  final FinancialClient client;
  final VoidCallback onFinancialAccessRevoked;

  const CrawlDetailPage({
    super.key,
    required this.crawl,
    required this.client,
    required this.onFinancialAccessRevoked,
  });

  @override
  State<CrawlDetailPage> createState() => _CrawlDetailPageState();
}

class _CrawlDetailPageState extends State<CrawlDetailPage> {
  CrawlEvidence? _evidence;
  bool _loading = true;
  bool _failed = false;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _generation++;
    super.dispose();
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      final evidence = await widget.client.crawlEvidence(widget.crawl.id);
      if (!mounted || generation != _generation) return;
      setState(() {
        _evidence = evidence;
        _loading = false;
      });
    } on FinancialUnauthorized {
      if (!mounted || generation != _generation) return;
      widget.onFinancialAccessRevoked();
      Navigator.of(context).pop();
    } catch (error) {
      debugPrint('Crawl evidence load failed: $error');
      if (!mounted || generation != _generation) return;
      setState(() {
        _loading = false;
        _failed = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: Text(widget.crawl.label, overflow: TextOverflow.ellipsis),
          bottom: const TabBar(
            tabs: [
              Tab(text: CompanionCopy.crawlSteps),
              Tab(text: CompanionCopy.crawlScreenshots),
              Tab(text: CompanionCopy.crawlResults),
            ],
          ),
        ),
        body: _body(),
      ),
    );
  }

  Widget _body() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_failed || _evidence == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.error_outline,
                size: 48,
                color: Theme.of(context).colorScheme.error,
              ),
              const SizedBox(height: 16),
              Text(
                CompanionCopy.crawlDetailsFailed,
                style: Theme.of(context).textTheme.titleLarge,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              const Text(
                CompanionCopy.crawlDetailsFailedHelp,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 20),
              FilledButton(
                onPressed: _load,
                child: const Text(CompanionCopy.tryAgain),
              ),
            ],
          ),
        ),
      );
    }
    final evidence = _evidence!;
    return Column(
      children: [
        _Summary(session: evidence.session),
        Expanded(
          child: TabBarView(
            children: [
              _StepsTab(steps: evidence.steps),
              _ScreenshotsTab(
                sessionId: evidence.session.id,
                steps: evidence.steps,
                client: widget.client,
              ),
              _ResultsTab(records: evidence.records),
            ],
          ),
        ),
      ],
    );
  }
}

class _Summary extends StatelessWidget {
  final CrawlSessionDetails session;

  const _Summary({required this.session});

  @override
  Widget build(BuildContext context) {
    final started = session.startedAt;
    final duration = started == null
        ? null
        : (session.completedAt ?? DateTime.now()).difference(started);
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: _Fact(
                label: CompanionCopy.started,
                value: started == null
                    ? '—'
                    : DateFormat('d MMM y, HH:mm').format(started.toLocal()),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _Fact(
                label: CompanionCopy.duration,
                value: duration == null ? '—' : _formatDuration(duration),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _Fact(
                label: CompanionCopy.status,
                value: _statusLabel(session.status),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  final String label;
  final String value;

  const _Fact({required this.label, required this.value});

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(label, style: Theme.of(context).textTheme.labelMedium),
      const SizedBox(height: 4),
      Text(value, style: Theme.of(context).textTheme.bodyMedium),
    ],
  );
}

class _StepsTab extends StatelessWidget {
  final List<CrawlStep> steps;

  const _StepsTab({required this.steps});

  @override
  Widget build(BuildContext context) {
    if (steps.isEmpty) {
      return const _Empty(message: CompanionCopy.noCrawlSteps);
    }
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: steps.length,
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final step = steps[index];
        return Card(
          margin: EdgeInsets.zero,
          child: ListTile(
            leading: CircleAvatar(child: Text('${step.stepNumber}')),
            title: Text(step.label),
            subtitle: _stepSubtitle(step),
            trailing: step.hasScreenshot
                ? const Icon(Icons.image_outlined)
                : null,
          ),
        );
      },
    );
  }

  Widget? _stepSubtitle(CrawlStep step) {
    final parts = <String>[
      if (step.error?.trim().isNotEmpty == true) step.error!.trim(),
      if (step.url?.trim().isNotEmpty == true) step.url!.trim(),
    ];
    return parts.isEmpty ? null : Text(parts.join('\n'));
  }
}

class _ScreenshotsTab extends StatelessWidget {
  final String sessionId;
  final List<CrawlStep> steps;
  final FinancialClient client;

  const _ScreenshotsTab({
    required this.sessionId,
    required this.steps,
    required this.client,
  });

  @override
  Widget build(BuildContext context) {
    final screenshotSteps = steps.where((step) => step.hasScreenshot).toList();
    if (screenshotSteps.isEmpty) {
      return const _Empty(message: CompanionCopy.noCrawlScreenshots);
    }
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: screenshotSteps.length,
      separatorBuilder: (_, _) => const SizedBox(height: 16),
      itemBuilder: (context, index) {
        final step = screenshotSteps[index];
        return Card(
          clipBehavior: Clip.antiAlias,
          margin: EdgeInsets.zero,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.all(12),
                child: Text(
                  step.label,
                  style: Theme.of(context).textTheme.titleSmall,
                ),
              ),
              _Screenshot(
                load: () => client.crawlScreenshot(sessionId, step.stepNumber),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _Screenshot extends StatefulWidget {
  final Future<Uint8List> Function() load;

  const _Screenshot({required this.load});

  @override
  State<_Screenshot> createState() => _ScreenshotState();
}

class _ScreenshotState extends State<_Screenshot> {
  late final Future<Uint8List> _image = widget.load();

  @override
  Widget build(BuildContext context) => FutureBuilder<Uint8List>(
    future: _image,
    builder: (context, snapshot) {
      if (snapshot.hasData) {
        return Image.memory(
          snapshot.data!,
          fit: BoxFit.contain,
          gaplessPlayback: true,
          errorBuilder: (_, _, _) =>
              const _ScreenshotMessage(message: CompanionCopy.screenshotFailed),
        );
      }
      if (snapshot.hasError) {
        return const _ScreenshotMessage(
          message: CompanionCopy.screenshotFailed,
        );
      }
      return const _ScreenshotMessage(
        message: CompanionCopy.loadingScreenshot,
        progress: true,
      );
    },
  );
}

class _ScreenshotMessage extends StatelessWidget {
  final String message;
  final bool progress;

  const _ScreenshotMessage({required this.message, this.progress = false});

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 180,
    child: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (progress) ...[
            const CircularProgressIndicator(),
            const SizedBox(height: 12),
          ],
          Text(message),
        ],
      ),
    ),
  );
}

class _ResultsTab extends StatelessWidget {
  final CrawlRecords records;

  const _ResultsTab({required this.records});

  @override
  Widget build(BuildContext context) {
    if (records.counts.isEmpty) {
      return const _Empty(message: CompanionCopy.noCrawlResults);
    }
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (records.accounts.isNotEmpty)
          _ResultGroup(
            title: CompanionCopy.accounts,
            count: records.counts.accounts,
            children: records.accounts
                .map(
                  (account) => ListTile(
                    title: Text(account.name),
                    subtitle: Text(account.type),
                    trailing: Text(
                      NumberFormat.simpleCurrency(
                        name: account.currency,
                      ).format(account.balance),
                    ),
                  ),
                )
                .toList(),
          ),
        if (records.transactions.isNotEmpty)
          _ResultGroup(
            title: CompanionCopy.transactions,
            count: records.counts.transactions,
            children: records.transactions
                .map(
                  (transaction) => ListTile(
                    title: Text(transaction.label),
                    subtitle: Text(
                      DateFormat(
                        'd MMM y',
                      ).format(transaction.bookingDate.toLocal()),
                    ),
                    trailing: Text(
                      NumberFormat.simpleCurrency(
                        name: transaction.currency,
                      ).format(transaction.amount),
                    ),
                  ),
                )
                .toList(),
          ),
        if (records.positions.isNotEmpty)
          _ResultGroup(
            title: CompanionCopy.positions,
            count: records.counts.positions,
            children: records.positions
                .map(
                  (position) => ListTile(
                    title: Text(position.name),
                    subtitle: position.symbol == null
                        ? null
                        : Text(position.symbol!),
                    trailing: Text(
                      NumberFormat.simpleCurrency(
                        name: position.currency,
                      ).format(position.valueNative),
                    ),
                  ),
                )
                .toList(),
          ),
      ],
    );
  }
}

class _ResultGroup extends StatelessWidget {
  final String title;
  final int count;
  final List<Widget> children;

  const _ResultGroup({
    required this.title,
    required this.count,
    required this.children,
  });

  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.only(bottom: 12),
    child: ExpansionTile(
      initiallyExpanded: true,
      title: Text(title),
      trailing: Text('$count'),
      children: children,
    ),
  );
}

class _Empty extends StatelessWidget {
  final String message;

  const _Empty({required this.message});

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Text(message, textAlign: TextAlign.center),
    ),
  );
}

String _statusLabel(String status) => switch (status) {
  'completed' => CompanionCopy.completed,
  'failed' => CompanionCopy.failed,
  'cancelled' => CompanionCopy.cancelled,
  'waiting_for_otp' => CompanionCopy.waitingForTwoFactorCode,
  _ => CompanionCopy.crawling,
};

String _formatDuration(Duration duration) {
  final hours = duration.inHours;
  final minutes = duration.inMinutes.remainder(60);
  final seconds = duration.inSeconds.remainder(60);
  if (hours > 0) return '${hours}h ${minutes}m';
  if (minutes > 0) return '${minutes}m ${seconds}s';
  return '${seconds}s';
}
