/**
 * Ouvrir un projet ClioDeck partagé par un tiers démarrait les serveurs MCP
 * de son `config.json` sans validation ni confirmation — soit l'exécution de
 * la commande de son choix. Le registre porte la mémoire des accords ; il
 * vit hors du workspace, faute de quoi un `config.json` hostile pourrait
 * s'auto-approuver.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  McpApprovalRegistry,
  fingerprintClient,
} from '../mcp-approval-registry.js';
import { SECRET_SENTINEL } from '../mcp-env-secrets.js';

const LEGITIME = {
  name: 'europeana',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@cliodeck/mcp-europeana'],
};

describe('fingerprintClient', () => {
  it('donne la même empreinte pour le même serveur', () => {
    expect(fingerprintClient(LEGITIME)).toBe(fingerprintClient({ ...LEGITIME }));
  });

  it('change dès que la commande change', () => {
    expect(fingerprintClient({ ...LEGITIME, command: '/bin/sh' })).not.toBe(
      fingerprintClient(LEGITIME)
    );
  });

  it('change dès que les arguments changent', () => {
    // Le scénario d'attaque : garder un nom et une commande d'apparence
    // anodine, et glisser la charge dans les arguments.
    expect(
      fingerprintClient({ ...LEGITIME, args: ['-y', 'paquet-malveillant'] })
    ).not.toBe(fingerprintClient(LEGITIME));
  });

  it('ignore le nom — un projet hostile peut le recopier', () => {
    expect(fingerprintClient({ ...LEGITIME, name: 'autre-nom' })).toBe(
      fingerprintClient(LEGITIME)
    );
  });

  // S09-1-22 : un projet reçu reprenait une commande déjà approuvée en y ajoutant un env qui la
  // détourne (registre de paquets, PATH). L'empreinte l'ignorait : aucun dialogue.
  it('change dès que l’env change, valeurs comprises', () => {
    const registre = { ...LEGITIME, env: { NPM_CONFIG_REGISTRY: 'https://registre.example/' } };
    expect(fingerprintClient(registre)).not.toBe(fingerprintClient(LEGITIME));
    expect(
      fingerprintClient({ ...LEGITIME, env: { NPM_CONFIG_REGISTRY: 'https://autre.example/' } })
    ).not.toBe(fingerprintClient(registre));
    expect(fingerprintClient({ ...LEGITIME, env: { PATH: '/tmp/bin' } })).not.toBe(
      fingerprintClient(LEGITIME)
    );
  });

  it('ne dépend pas de l’ordre des clés de l’env', () => {
    expect(fingerprintClient({ ...LEGITIME, env: { B: '2', A: '1' } })).toBe(
      fingerprintClient({ ...LEGITIME, env: { A: '1', B: '2' } })
    );
  });

  // S09-2-3 : un serveur SSE passe désormais par le registre ; son accord vaut pour une adresse.
  it('change dès que l’adresse d’un serveur SSE change', () => {
    const sse = { name: 'archives', transport: 'sse' as const, url: 'https://archives.example/sse' };
    expect(fingerprintClient({ ...sse, url: 'https://collecte.example/sse' })).not.toBe(
      fingerprintClient(sse)
    );
  });

  // Les accords déjà enregistrés (`mcp-approvals.json`) d'un serveur sans env ni adresse ne bougent
  // pas d'un octet. Valeur calculée en exécutant le code de `main` (5bb3697), pas à la main.
  it('garde l’empreinte d’avant pour un serveur sans env ni adresse', () => {
    expect(fingerprintClient(LEGITIME)).toBe(
      'c6885d938beae2a6904d3b38f62b9efefc79c63d64a6727fce7af56c4f2f012e'
    );
    // Un env vide ne change rien : rien n'y redirige la commande.
    expect(fingerprintClient({ ...LEGITIME, env: {} })).toBe(fingerprintClient(LEGITIME));
  });

  // L'empreinte est calculée après la migration des secrets (`migrateClientEnvSecrets`) : elle voit
  // la sentinelle, jamais la clé, et ne change pas quand l'auteur change sa clé.
  it('voit la sentinelle d’un secret, stable, et distincte d’une valeur en clair', () => {
    const avecSecret = { ...LEGITIME, env: { EUROPEANA_API_KEY: SECRET_SENTINEL } };
    expect(fingerprintClient(avecSecret)).toBe(fingerprintClient({ ...avecSecret }));
    expect(fingerprintClient(avecSecret)).not.toBe(
      fingerprintClient({ ...LEGITIME, env: { EUROPEANA_API_KEY: 'cle-en-clair' } })
    );
  });
});

describe('McpApprovalRegistry', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-mcp-'));
    file = path.join(dir, 'mcp-approvals.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('ne connaît rien tant que rien n’a été approuvé', async () => {
    const reg = new McpApprovalRegistry(file);
    expect(await reg.isApproved(fingerprintClient(LEGITIME))).toBe(false);
  });

  it('mémorise un accord et le retrouve après redémarrage', async () => {
    const fp = fingerprintClient(LEGITIME);
    await new McpApprovalRegistry(file).approve(fp, LEGITIME);

    // Nouvelle instance : relit le fichier, comme au lancement suivant.
    expect(await new McpApprovalRegistry(file).isApproved(fp)).toBe(true);
  });

  it('n’étend pas l’accord à une commande modifiée', async () => {
    await new McpApprovalRegistry(file).approve(
      fingerprintClient(LEGITIME),
      LEGITIME
    );
    const reg = new McpApprovalRegistry(file);

    expect(
      await reg.isApproved(fingerprintClient({ ...LEGITIME, command: '/bin/sh' }))
    ).toBe(false);
    expect(
      await reg.isApproved(
        fingerprintClient({ ...LEGITIME, args: ['-c', 'curl … | sh'] })
      )
    ).toBe(false);
  });

  it('repart d’un registre vide si le fichier est illisible', async () => {
    // Se tromper ici coûte une confirmation de plus, jamais un démarrage
    // silencieux.
    await fs.writeFile(file, 'ceci n’est pas du JSON', 'utf8');
    expect(
      await new McpApprovalRegistry(file).isApproved(fingerprintClient(LEGITIME))
    ).toBe(false);
  });

  it('n’accepte pas un JSON de forme inattendue comme liste d’accords', async () => {
    await fs.writeFile(file, '["' + fingerprintClient(LEGITIME) + '"]', 'utf8');
    expect(
      await new McpApprovalRegistry(file).isApproved(fingerprintClient(LEGITIME))
    ).toBe(false);
  });
});
