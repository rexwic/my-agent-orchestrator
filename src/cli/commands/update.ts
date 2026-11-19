/**
 * `orch update` command.
 *
 * This is a private fork: it never installs upstream releases from npm (that
 * would replace the fork). It shows how to update the fork from git instead.
 */

import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { cliEntryFromArgv } from '../../infrastructure/process/cli-shim.js';
import { amber, dim } from '../output.js';

/** The fork's checkout: the nearest directory above the running CLI with a package.json. */
function forkRoot(): string | undefined {
  const entry = cliEntryFromArgv();
  if (!entry) return undefined;
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return undefined;
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('How to update this fork (it does not install upstream releases from npm)')
    .option('--check', 'Same as without it (kept for compatibility)')
    .action(() => {
      const root = forkRoot();
      console.log();
      console.log(`  ${amber('orch update')} · private fork — no automatic updates from npm`);
      console.log();
      console.log('  Update to the latest fork changes:');
      console.log(dim(`    cd ${root ?? '<your fork checkout>'}`));
      console.log(dim('    git pull'));
      console.log(dim('    npm install && npm run build'));
      console.log();
      console.log('  Bring in upstream (oxgeneral/orch) changes — review them first:');
      console.log(dim('    git fetch upstream'));
      console.log(dim('    git log --oneline HEAD..upstream/main'));
      console.log(dim('    git merge upstream/main   # then npm test && npm run build'));
      console.log();
    });
}
