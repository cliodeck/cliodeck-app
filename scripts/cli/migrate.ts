/**
 * cliodeck import-cliobrain — bring a workspace to the flat `.cliodeck/*`
 * layout. Despite the name, this CLI is the catch-all migration entry point:
 * it dispatches on workspace state (ClioBrain, pre-fusion v1, in-flight
 * v2-subdir, or already flat) via `migrateWorkspaceToFlat`.
 *
 * Returns the typed JSON migration report on stdout for scripts/CI to
 * consume; a human summary goes to stderr.
 */

import { migrateWorkspaceToFlat } from '../../backend/core/workspace/migrator.js';
import type { ParsedArgs } from './args.js';

export async function cmdImportCliobrain(args: ParsedArgs): Promise<number> {
  const workspace = args.positional[0] ?? args.flags.workspace;
  const overwrite = args.booleans.overwrite === true;
  const name = args.flags.name;

  if (!workspace) {
    process.stderr.write(
      'usage: cliodeck import-cliobrain <workspace> [--overwrite] [--name <label>]\n'
    );
    return 2;
  }

  const report = await migrateWorkspaceToFlat(workspace, { overwrite, name });

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  process.stderr.write(
    `\nmigration kind: ${report.kind}\n` +
      `copied: ${report.copied.length}, skipped: ${report.skipped.length}, warnings: ${report.warnings.length}\n` +
      (report.noop ? `(noop: ${report.noop})\n` : '')
  );

  // A noop is informational. A malformed cliobrain config.json IS a failure —
  // the workspace won't open cleanly post-migration without intervention.
  const hardFailure = report.warnings.some((w) => w.includes('Failed to parse'));
  return hardFailure ? 1 : 0;
}
