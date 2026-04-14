/**
 * cliodeck hints … — read/write the workspace `.cliohints` file
 * (fusion step 4.6).
 */

import fs from 'fs/promises';
import {
  loadWorkspaceHints,
  writeWorkspaceHints,
} from '../../backend/core/hints/loader.js';
import type { ParsedArgs } from './args.js';

export async function cmdHintsShow(args: ParsedArgs): Promise<number> {
  const workspace = args.flags.workspace;
  if (!workspace) {
    process.stderr.write('--workspace is required\n');
    return 2;
  }
  const h = await loadWorkspaceHints(workspace);
  process.stdout.write(
    JSON.stringify(
      {
        present: h.present,
        sourcePath: h.sourcePath,
        content: h.raw,
      },
      null,
      2
    ) + '\n'
  );
  return 0;
}

export async function cmdHintsSet(args: ParsedArgs): Promise<number> {
  const workspace = args.flags.workspace;
  const fromFile = args.flags.file;
  if (!workspace) {
    process.stderr.write('--workspace is required\n');
    return 2;
  }

  let content: string;
  if (fromFile) {
    content = await fs.readFile(fromFile, 'utf8');
  } else if (args.positional.length > 0) {
    content = args.positional.join(' ');
  } else {
    // stdin
    content = await readStdin();
  }

  await writeWorkspaceHints(workspace, content);
  process.stdout.write(
    JSON.stringify({ ok: true, bytes: Buffer.byteLength(content) }) + '\n'
  );
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) {
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks).toString('utf8');
}
