import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  CONTEXT_FILE,
  CONTEXT_TEMPLATE,
  ContextConflictError,
  ContextOutsideProjectError,
  extractContextContent,
  loadWorkspaceHints,
  prependAsPrompt,
  prependAsSystemMessage,
  writeWorkspaceHints,
} from '../loader.js';
import { UnreadableFileError } from '../../fs/user-files.js';
import { workspaceFiles } from '../../workspace/layout.js';
import { ensureWorkspaceDirectories } from '../../workspace/layout.js';
import type { ChatMessage } from '../../llm/providers/base.js';
import { symlinkAvailable } from '../../../__tests__/helpers/native-guards.js';

let tmp = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-hints-'));
  await ensureWorkspaceDirectories(tmp);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('Workspace hints loader (4.1)', () => {
  it('reports absent when no context file exists', async () => {
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(false);
    expect(h.normalized).toBe('');
    // context.md est désormais la face visible et la cible d'écriture.
    expect(h.sourcePath).toContain(CONTEXT_FILE);
  });

  it('reports absent for an empty/whitespace-only hints.md', async () => {
    await writeWorkspaceHints(tmp, '\n   \n');
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(false);
    expect(h.raw).not.toBe('');
    expect(h.normalized).toBe('');
  });

  it('loads user-authored context, heading stripped', async () => {
    await writeWorkspaceHints(
      tmp,
      '# Contexte du projet\n\nCite en Chicago author-date.\n\n'
    );
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(true);
    expect(h.normalized).toBe('Cite en Chicago author-date.');
  });

  it('prependAsPrompt is a no-op when hints absent', async () => {
    const h = await loadWorkspaceHints(tmp);
    expect(prependAsPrompt('Analyse X', h)).toBe('Analyse X');
  });

  it('prependAsPrompt wraps the prompt when hints present', async () => {
    await writeWorkspaceHints(tmp, 'Langue: français.');
    const h = await loadWorkspaceHints(tmp);
    const out = prependAsPrompt('Analyse X', h);
    expect(out).toContain('Langue: français.');
    expect(out).toContain('Analyse X');
    expect(out.indexOf('Langue: français.')).toBeLessThan(
      out.indexOf('Analyse X')
    );
  });

  it('prependAsSystemMessage is a no-op when hints absent', async () => {
    const h = await loadWorkspaceHints(tmp);
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(prependAsSystemMessage(msgs, h)).toBe(msgs);
  });

  it('prependAsSystemMessage prepends a fresh system message', async () => {
    await writeWorkspaceHints(tmp, 'Cite en Chicago.');
    const h = await loadWorkspaceHints(tmp);
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are an assistant.' },
      { role: 'user', content: 'Help' },
    ];
    const out = prependAsSystemMessage(msgs, h);
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('Cite en Chicago.');
    expect(out[1]).toBe(msgs[0]);
    expect(out[2]).toBe(msgs[1]);
  });

  // --- context.md face visible, hints.md hérité ---

  it('n’injecte RIEN pour un context.md jamais édité', async () => {
    // Le gabarit porte ses instructions dans un commentaire HTML : un
    // fichier neuf ne doit rien apprendre au modèle.
    await writeWorkspaceHints(tmp, CONTEXT_TEMPLATE);
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(false);
    expect(h.normalized).toBe('');
  });

  it('n’injecte pas l’ancien gabarit des projets déjà créés', async () => {
    await writeWorkspaceHints(
      tmp,
      '# Contexte du projet\n\nDécrivez ici le contexte de votre recherche. ' +
        'Ce contexte sera utilisé pour améliorer les réponses de l’assistant IA.\n\n' +
        'Exemple : "Cette recherche porte sur l’impact de l’intelligence artificielle."'
    );
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(false);
  });

  it('lit encore .cliodeck/hints.md et concatène les deux sources', async () => {
    await fs.writeFile(workspaceFiles(tmp).hints, 'Toujours en Chicago.', 'utf8');
    await writeWorkspaceHints(tmp, '# Contexte\n\nDanzig, 1919-1939.');
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(true);
    expect(h.sources.context.present).toBe(true);
    expect(h.sources.legacyHints.present).toBe(true);
    // context.md d'abord (le sujet), puis les directives héritées.
    expect(h.normalized).toBe('Danzig, 1919-1939.\n\nToujours en Chicago.');
  });

  it('fonctionne avec le seul hints.md hérité', async () => {
    await fs.writeFile(workspaceFiles(tmp).hints, 'Langue : français.', 'utf8');
    const h = await loadWorkspaceHints(tmp);
    expect(h.present).toBe(true);
    expect(h.normalized).toBe('Langue : français.');
  });

  it('extractContextContent retire commentaires et titre de tête', () => {
    expect(extractContextContent('# Titre\n\n<!-- note -->\nCorps.')).toBe('Corps.');
    expect(extractContextContent('<!-- tout est commenté -->')).toBe('');
  });
});

/** Le gabarit écrit par les versions d'avant juillet 2026, à l'octet près. */
const LEGACY_TEMPLATE =
  '# Contexte du projet\n\nDécrivez ici le contexte de votre recherche. Ce contexte sera utilisé pour améliorer les réponses de l\'assistant IA.\n\nExemple : "Cette recherche porte sur l\'impact de l\'intelligence artificielle dans l\'éducation supérieure, avec un focus particulier sur la taxonomie de Bloom et les stratégies pédagogiques actives."';

/** « Été » en Latin-1 : des octets qui ne forment pas de l'UTF-8. */
const LATIN1 = Buffer.from([0x23, 0x20, 0xc9, 0x74, 0xe9, 0x0a]);

describe('un context.md qu’on ne sait pas lire n’est pas un context.md absent', () => {
  const contextMd = () => path.join(tmp, CONTEXT_FILE);

  it('absent : rien à signaler, et il peut se créer', async () => {
    const h = await loadWorkspaceHints(tmp);

    expect(h.sources.context.unreadable).toBeUndefined();
    expect(h.sources.context.blank).toBe(true);
  });

  it('pas en UTF-8 : illisible, sans U+FFFD, et le tour de chat continue sans lui', async () => {
    await fs.writeFile(contextMd(), LATIN1);

    const h = await loadWorkspaceHints(tmp);

    expect(h.sources.context.unreadable).toEqual({ reason: 'encoding' });
    expect(h.sources.context.blank).toBe(false);
    expect(h.raw).toBe('');
    expect(h.present).toBe(false);
    expect(JSON.stringify(h)).not.toContain('\uFFFD');
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(prependAsSystemMessage(msgs, h)).toBe(msgs);
  });

  it('un dossier à sa place : illisible aussi', async () => {
    await fs.mkdir(contextMd());

    const h = await loadWorkspaceHints(tmp);

    expect(h.sources.context.unreadable).toEqual({ reason: 'not-a-file' });
    expect(h.sources.context.blank).toBe(false);
    expect(h.present).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'sans droit de lecture : illisible, et jamais présenté comme vide',
    async () => {
      await fs.writeFile(contextMd(), 'Consignes de l’auteur.');
      await fs.chmod(contextMd(), 0o000);
      try {
        const h = await loadWorkspaceHints(tmp);

        expect(h.sources.context.unreadable).toEqual({ reason: 'permission' });
        expect(h.sources.context.blank).toBe(false);
      } finally {
        await fs.chmod(contextMd(), 0o644);
      }
    }
  );

  it('.cliodeck/hints.md illisible : l’autre source reste', async () => {
    await fs.writeFile(workspaceFiles(tmp).hints, LATIN1);
    await fs.writeFile(contextMd(), 'Cite en Chicago.');

    const h = await loadWorkspaceHints(tmp);

    expect(h.sources.legacyHints.unreadable).toEqual({ reason: 'encoding' });
    expect(h.normalized).toBe('Cite en Chicago.');
  });
});

describe('écrire context.md : à la place, et seulement sur le texte qu’on a lu', () => {
  const contextMd = () => path.join(tmp, CONTEXT_FILE);

  it('écrit à côté puis renomme : l’ancienne version reste entière jusqu’au dernier instant', async () => {
    await fs.writeFile(contextMd(), 'Avant.');
    const before = (await fs.stat(contextMd())).ino;

    await writeWorkspaceHints(tmp, 'Après.');

    expect((await fs.stat(contextMd())).ino).not.toBe(before);
    expect(await fs.readFile(contextMd(), 'utf8')).toBe('Après.');
  });

  it('expectedRaw périmé : erreur de conflit, et fichier inchangé', async () => {
    await fs.writeFile(contextMd(), 'Modifié dans l’éditeur.');

    await expect(writeWorkspaceHints(tmp, 'Depuis les réglages.', { expectedRaw: 'Lu à l’ouverture.' })).rejects.toBeInstanceOf(
      ContextConflictError
    );

    expect(await fs.readFile(contextMd(), 'utf8')).toBe('Modifié dans l’éditeur.');
  });

  it('expectedRaw à jour : écrit', async () => {
    await fs.writeFile(contextMd(), 'Lu à l’ouverture.');

    await writeWorkspaceHints(tmp, 'Depuis les réglages.', { expectedRaw: 'Lu à l’ouverture.' });

    expect(await fs.readFile(contextMd(), 'utf8')).toBe('Depuis les réglages.');
  });

  it('un fichier apparu depuis une lecture qui l’avait vu absent est un conflit', async () => {
    const { raw } = await loadWorkspaceHints(tmp);
    await fs.writeFile(contextMd(), 'Créé entre-temps.');

    await expect(writeWorkspaceHints(tmp, 'Depuis les réglages.', { expectedRaw: raw })).rejects.toBeInstanceOf(
      ContextConflictError
    );

    expect(await fs.readFile(contextMd(), 'utf8')).toBe('Créé entre-temps.');
  });

  it('un fichier disparu depuis la lecture : plus rien à écraser, il se recrée', async () => {
    await fs.writeFile(contextMd(), 'Lu à l’ouverture.');
    const { raw } = await loadWorkspaceHints(tmp);
    await fs.rm(contextMd());

    await writeWorkspaceHints(tmp, 'Depuis les réglages.', { expectedRaw: raw });

    expect(await fs.readFile(contextMd(), 'utf8')).toBe('Depuis les réglages.');
  });

  it('un fichier illisible ne se réécrit pas, même avec un attendu vide', async () => {
    await fs.writeFile(contextMd(), LATIN1);

    await expect(writeWorkspaceHints(tmp, 'Écrasé.', { expectedRaw: '' })).rejects.toBeInstanceOf(UnreadableFileError);

    expect(await fs.readFile(contextMd())).toEqual(LATIN1);
  });

  /**
   * Le faux conflit empêcherait d'enregistrer un fichier que personne n'a touché : ce qui a
   * été lu se compare à ce que l'écriture relit, sous la même forme, quels que soient ses octets.
   */
  it.each<[string, string | Buffer]>([
    ['un BOM', '\uFEFF# Contexte\n\nTexte.\n'],
    ['des fins de ligne CRLF', '# Contexte\r\n\r\nTexte.\r\n'],
    ['des fins de ligne mêlées', '# Contexte\r\n\nTexte.\n'],
    ['des accents composés (NFC)', '# Été\n\nÉvénements.\n'.normalize('NFC')],
    ['des accents décomposés (NFD)', '# Été\n\nÉvénements.\n'.normalize('NFD')],
    ['pas de saut de ligne final', '# Contexte\n\nTexte.'],
    ['le gabarit', CONTEXT_TEMPLATE],
    ['un fichier vide', ''],
  ])('pas de faux conflit avec %s', async (_label, bytes) => {
    await fs.writeFile(contextMd(), bytes);
    const { raw } = await loadWorkspaceHints(tmp);

    await writeWorkspaceHints(tmp, 'Depuis les réglages.', { expectedRaw: raw });

    expect(await fs.readFile(contextMd(), 'utf8')).toBe('Depuis les réglages.');
  });

  it('pas de faux conflit sur un fichier absent à la lecture', async () => {
    const { raw } = await loadWorkspaceHints(tmp);

    await writeWorkspaceHints(tmp, 'Depuis les réglages.', { expectedRaw: raw });

    expect(await fs.readFile(contextMd(), 'utf8')).toBe('Depuis les réglages.');
  });
});

/**
 * « Rien de l'auteur » se juge sur le texte brut. `extractContextContent` retire ce qui ne doit
 * pas atteindre le modèle, et `present` en découle : ils déclarent vide un fichier qui porte des
 * consignes dans un commentaire, ou des titres qu'il reste à remplir.
 */
describe('un context.md sans rien de l’auteur', () => {
  const blankOf = async (bytes: string) => {
    await fs.writeFile(path.join(tmp, CONTEXT_FILE), bytes);
    return (await loadWorkspaceHints(tmp)).sources.context.blank;
  };

  it.each<[string, string]>([
    ['vide', ''],
    ['des blancs seulement', ' \n\t\n'],
    ['un BOM seul', '\uFEFF\n'],
    ['le gabarit', CONTEXT_TEMPLATE],
    ['le gabarit et des blancs de fin', `${CONTEXT_TEMPLATE}  \n\n`],
  ])('%s : rien à préserver', async (_label, bytes) => {
    expect(await blankOf(bytes)).toBe(true);
  });

  it.each<[string, string]>([
    ['du texte', 'Consignes.'],
    ['un titre seul', '# Mon projet\n'],
    ['du texte dans un commentaire', '<!-- Ne pas citer Wikipédia. -->\n'],
    ['le gabarit au titre retouché', CONTEXT_TEMPLATE.replace('Contexte du projet', 'Contexte de ma thèse')],
    ['le gabarit au commentaire retouché', CONTEXT_TEMPLATE.replace('sujet, période', 'Danzig, 1919-1939')],
    ['des blancs avant le gabarit', `\n${CONTEXT_TEMPLATE}`],
    ['l’ancien gabarit', LEGACY_TEMPLATE],
  ])('%s : à préserver, même si rien ne part au modèle', async (_label, bytes) => {
    expect(await blankOf(bytes)).toBe(false);
  });
});

describe('une section ajoutée à l’ancien gabarit', () => {
  it('atteint le modèle, sans l’exemple du gabarit', async () => {
    await fs.writeFile(path.join(tmp, CONTEXT_FILE), `${LEGACY_TEMPLATE}\n\n# Danzig\n\n## Research Topic\n\nPorts baltes\n`);

    const h = await loadWorkspaceHints(tmp);

    expect(h.normalized).toContain('Ports baltes');
    expect(h.normalized).not.toContain('Décrivez ici');
    expect(h.normalized).not.toContain('intelligence artificielle');
  });

  it('le gabarit laissé tel quel reste inerte, en CRLF aussi', async () => {
    await fs.writeFile(path.join(tmp, CONTEXT_FILE), LEGACY_TEMPLATE.replace(/\n/g, '\r\n'));

    expect((await loadWorkspaceHints(tmp)).present).toBe(false);
  });
});

/**
 * Un projet reçu garde ses liens : `context.md` peut pointer vers un fichier de l'auteur,
 * et ce contexte part en message `system` à chaque tour, sans qu'on ait rien demandé.
 */
describe.skipIf(!symlinkAvailable)('un fichier de contexte en lien symbolique', () => {
  const SECRET = 'SECRET-HORS-PROJET';
  const JOURNAL = `# Journal\n\n${SECRET} : texte privé.\n`;
  let outside = '';
  const contextMd = () => path.join(tmp, CONTEXT_FILE);
  const hintsMd = () => workspaceFiles(tmp).hints;

  beforeEach(async () => {
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cliodeck-hints-dehors-'));
    await fs.writeFile(path.join(outside, 'journal.md'), JOURNAL);
  });

  afterEach(async () => {
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('context.md lié hors du projet : rien n’est lu, ni pour le modèle ni pour l’interface', async () => {
    await fs.symlink(path.join(outside, 'journal.md'), contextMd());

    const h = await loadWorkspaceHints(tmp);

    expect(h.present).toBe(false);
    expect(h.normalized).toBe('');
    expect(h.raw).toBe('');
    expect(JSON.stringify(h)).not.toContain(SECRET);
    // Ni absent, ni illisible : c'est un refus, et il se dit.
    expect(h.sources.context.unreadable).toEqual({ reason: 'outside-project' });
    expect(h.sources.context.blank).toBe(false);
  });

  it('.cliodeck/hints.md lié hors du projet : pareil', async () => {
    await fs.symlink(path.join(outside, 'journal.md'), hintsMd());

    const h = await loadWorkspaceHints(tmp);

    expect(h.present).toBe(false);
    expect(JSON.stringify(h)).not.toContain(SECRET);
  });

  it('`.cliodeck` lié hors du projet : son hints.md n’est pas lu', async () => {
    await fs.rm(path.join(tmp, '.cliodeck'), { recursive: true });
    await fs.writeFile(path.join(outside, 'hints.md'), JOURNAL);
    await fs.symlink(outside, path.join(tmp, '.cliodeck'));

    const h = await loadWorkspaceHints(tmp);

    expect(h.present).toBe(false);
    expect(JSON.stringify(h)).not.toContain(SECRET);
  });

  it('l’une liée dehors, l’autre ordinaire : l’ordinaire reste', async () => {
    await fs.symlink(path.join(outside, 'journal.md'), contextMd());
    await fs.writeFile(hintsMd(), 'Cite en Chicago.');

    const h = await loadWorkspaceHints(tmp);

    expect(h.normalized).toBe('Cite en Chicago.');
    expect(h.normalized).not.toContain(SECRET);
  });

  it('un lien qui reste dans le projet continue de marcher', async () => {
    await fs.writeFile(path.join(tmp, 'notes-contexte.md'), 'Langue : français.');
    await fs.symlink('notes-contexte.md', contextMd());

    const h = await loadWorkspaceHints(tmp);

    expect(h.normalized).toBe('Langue : français.');
    expect(h.raw).toBe('Langue : français.');
  });

  it('une racine passée par un lien ne fait rien perdre', async () => {
    await writeWorkspaceHints(tmp, 'Langue : français.');
    const alias = `${tmp}-alias`;
    await fs.symlink(tmp, alias);
    try {
      expect((await loadWorkspaceHints(alias)).normalized).toBe('Langue : français.');
    } finally {
      await fs.rm(alias);
    }
  });

  it('écrire ne suit pas le lien : le fichier extérieur reste intact, et le refus se dit', async () => {
    await fs.symlink(path.join(outside, 'journal.md'), contextMd());

    await expect(writeWorkspaceHints(tmp, 'Écrasé.')).rejects.toThrow(/sort du projet/);

    expect(await fs.readFile(path.join(outside, 'journal.md'), 'utf8')).toBe(JOURNAL);
  });

  it('écrire sur le texte attendu ne suit pas le lien non plus, et ce n’est pas un conflit', async () => {
    await fs.symlink(path.join(outside, 'journal.md'), contextMd());

    await expect(writeWorkspaceHints(tmp, 'Écrasé.', { expectedRaw: '' })).rejects.toBeInstanceOf(
      ContextOutsideProjectError
    );

    expect(await fs.readFile(path.join(outside, 'journal.md'), 'utf8')).toBe(JOURNAL);
  });

  it('écrire ne crée rien à l’autre bout d’un lien cassé', async () => {
    await fs.symlink(path.join(outside, 'cree-dehors.md'), contextMd());

    await expect(writeWorkspaceHints(tmp, 'Écrasé.')).rejects.toThrow(/sort du projet/);

    await expect(fs.access(path.join(outside, 'cree-dehors.md'))).rejects.toThrow();
  });

  it('écrire à travers un lien interne reste possible', async () => {
    await fs.writeFile(path.join(tmp, 'notes-contexte.md'), 'Avant.');
    await fs.symlink('notes-contexte.md', contextMd());

    await writeWorkspaceHints(tmp, 'Après.');

    expect(await fs.readFile(path.join(tmp, 'notes-contexte.md'), 'utf8')).toBe('Après.');
    expect((await fs.lstat(contextMd())).isSymbolicLink()).toBe(true);

    await writeWorkspaceHints(tmp, 'Encore après.', { expectedRaw: 'Après.' });

    expect(await fs.readFile(path.join(tmp, 'notes-contexte.md'), 'utf8')).toBe('Encore après.');
    expect((await fs.lstat(contextMd())).isSymbolicLink()).toBe(true);
  });
});
