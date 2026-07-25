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
