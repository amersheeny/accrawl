import { accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function installGitHooks(root) {
  const hook = resolve(root, '.githooks', 'pre-push');
  const git = (args, stdio = 'ignore') => spawnSync('git', args, {
    cwd: root,
    stdio,
  });

  // Package installation also runs in source-only container build contexts,
  // where .git is deliberately absent. That is not a developer checkout.
  if (git(['rev-parse', '--git-dir']).status !== 0) return;

  accessSync(hook, constants.R_OK | constants.X_OK);
  const configured = git(
    ['config', '--local', 'core.hooksPath', '.githooks'],
    'inherit',
  );
  if (configured.status !== 0) process.exit(configured.status ?? 1);
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  installGitHooks(resolve(dirname(modulePath), '..'));
}
