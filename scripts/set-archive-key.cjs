/**
 * One-shot bootstrap: store an archive connector key in ClioDeck's
 * secureStorage from the command line.
 *
 *   node_modules/.bin/electron --no-sandbox scripts/set-archive-key.cjs <connector> <key>
 *
 * Runs under full Electron (NOT ELECTRON_RUN_AS_NODE) because safeStorage
 * needs a real Electron app context. Quits as soon as the key is written.
 *
 * Avoids ever printing the key to stdout/stderr; only confirms success.
 */

const { app, safeStorage } = require('electron');

// Force the userData path to match the production app (`~/.config/cliodeck/`
// on Linux). Without this, a bare `electron <script>` invocation defaults
// to `app.getName() === 'Electron'`, sending the secret to a sibling
// directory the real app never reads.
app.setName('cliodeck');

const VALID_CONNECTORS = new Set(['europeana']);

async function main() {
  const args = process.argv.slice(2);
  // electron passes the script path before user args under some setups;
  // pop until we find a known connector keyword.
  let connector = null;
  let key = null;
  for (let i = 0; i < args.length; i++) {
    if (VALID_CONNECTORS.has(args[i])) {
      connector = args[i];
      key = args[i + 1] ?? null;
      break;
    }
  }
  if (!connector || !key) {
    console.error(
      'Usage: electron scripts/set-archive-key.cjs <connector> <key>'
    );
    console.error(`Known connectors: ${[...VALID_CONNECTORS].join(', ')}`);
    process.exit(2);
  }

  await app.whenReady();

  const { default: Store } = await import('electron-store');
  const store = new Store({
    name: 'cliodeck-secrets',
    projectName: 'cliodeck',
  });

  const sensitiveKey =
    connector === 'europeana' ? 'mcp.europeana.apiKey' : null;
  if (!sensitiveKey) {
    console.error(`No mapping for connector '${connector}'`);
    app.quit();
    process.exit(2);
  }

  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(key);
    store.set(sensitiveKey, encrypted.toString('base64'));
    console.log(`OK: stored ${connector} key (encrypted via safeStorage).`);
  } else {
    store.set(sensitiveKey, key);
    console.warn(
      `WARN: stored ${connector} key in plaintext — OS encryption unavailable on this system.`
    );
  }

  app.quit();
}

main().catch((e) => {
  console.error('Fatal:', e);
  app.quit();
  process.exit(1);
});
