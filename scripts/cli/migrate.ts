/**
 * cliodeck import-cliobrain — migrate an existing ClioBrain workspace
 * into the ClioDeck v2 layout (fusion step 5.2).
 *
 * Thin CLI wrapper over `migrateFromCliobrain` (phase 0.3). Reports a
 * typed JSON migration report on stdout so batch scripts / CI can
 * consume it programmatically. Prints a human summary on stderr.
 */

import {
  migrateFromCliobrain,
  migrateFromCliodeckV1,
} from '../../backend/core/workspace/migrator.js';
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

  const report = await migrateFromCliobrain(workspace, { overwrite, name });

  // Run the v1 → v2 migrator too so any accidentally-mixed workspace ends
  // up fully consolidated. `migrateFromCliobrain` is idempotent via its
  // target_exists skip reason.
  const v1Report = await migrateFromCliodeckV1(workspace, { overwrite, name });

  const combined = {
    cliobrain: report,
    cliodeckV1: v1Report,
  };

  process.stdout.write(JSON.stringify(combined, null, 2) + '\n');

  process.stderr.write(
    `\ncliobrain → v2: ${report.copied.length} copied, ${report.skipped.length} skipped, ${report.warnings.length} warnings\n` +
      (report.noop ? `  (noop: ${report.noop})\n` : '') +
      `cliodeck v1 → v2: ${v1Report.copied.length} copied, ${v1Report.skipped.length} skipped\n` +
      (v1Report.noop ? `  (noop: ${v1Report.noop})\n` : '')
  );

  // A noop on both sides is informational, not a failure. A malformed
  // cliobrain config.json IS a failure — the workspace won't open cleanly
  // post-migration without intervention.
  const hardFailure = [...report.warnings, ...v1Report.warnings].some((w) =>
    w.includes('Failed to parse')
  );
  return hardFailure ? 1 : 0;
}
