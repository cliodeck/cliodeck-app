/**
 * Le crochet de signature macOS doit rendre à `codesign` l'empreinte du
 * certificat.
 *
 * electron-builder 26 la remplace par le NOM du certificat au dernier moment,
 * et `codesign` ne retrouve pas un nom accentué : « Developer ID Application:
 * Frédéric Clavert (…): no identity found ». Le défaut ne se voit que lors
 * d'un build signé — donc jamais en CI, et seulement sur le poste qui détient
 * le certificat. Ce test garde les deux choses qui peuvent se perdre sans
 * bruit : le branchement du crochet, et le fait qu'il ne touche pas aux
 * options qu'il reçoit.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  build: { mac: { sign?: string } };
};

describe('scripts/mac-sign.cjs', () => {
  it('est branché sur la signature macOS', () => {
    const hook = manifest.build.mac.sign;
    expect(hook).toBe('./scripts/mac-sign.cjs');
    expect(fs.existsSync(path.join(ROOT, hook as string))).toBe(true);
  });

  it('signe avec les options reçues, empreinte comprise, sans y toucher', async () => {
    // Le crochet charge la fonction de signature d'electron-builder par
    // `require` : on la remplace dans le cache des modules avant de le charger.
    const signer = require.resolve('app-builder-lib/out/codeSign/macCodeSign');
    const sign = vi.fn().mockResolvedValue(undefined);
    require.cache[signer] = { id: signer, filename: signer, loaded: true, exports: { sign } } as unknown as NodeJS.Module;
    try {
      const macSign = require(path.join(ROOT, 'scripts/mac-sign.cjs')) as (options: unknown) => Promise<unknown>;
      const options = { app: '/tmp/ClioDeck.app', identity: 'ADEA96B20E228957D0AD44F5C691FDB569AADDD1' };

      await macSign(options);

      expect(sign).toHaveBeenCalledTimes(1);
      expect(sign.mock.calls[0][0]).toBe(options);
    } finally {
      delete require.cache[signer];
      delete require.cache[require.resolve(path.join(ROOT, 'scripts/mac-sign.cjs'))];
    }
  });
});
