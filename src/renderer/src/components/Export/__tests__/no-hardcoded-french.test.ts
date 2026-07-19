/**
 * Garde anti-récidive : aucun texte d'interface codé en dur dans les
 * composants d'export.
 *
 * L'audit du 2026-07-19 a relevé que les deux modales d'export étaient
 * entièrement en français littéral alors que le test de parité des locales
 * passait au vert. La raison : ce test compare les fichiers de locales entre
 * eux, il ne peut pas voir qu'un composant n'appelle jamais `t()`. Un
 * utilisateur anglophone recevait donc une boîte de dialogue française au
 * moment d'exporter son travail.
 *
 * Ce test lit la source des composants et échoue si un texte visible porte
 * des marques du français. Il ne prétend pas détecter tout texte non
 * traduit — seulement empêcher la régression précise qui s'est produite.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(HERE, '..');

/** Lettres accentuées propres au français. */
const ACCENTED = /[éèêëàâçùûôîï]/i;

/**
 * Mots français fréquents sans accent : sans eux, « Browse » passerait mais
 * pas « Parcourir », ni « Annuler ».
 */
const FRENCH_WORDS =
  /\b(le|la|les|un|une|des|du|dans|pour|avec|sans|sur|vers|puis|donc|est|sont|sera|seront|vous|votre|nous|notre|aucun|aucune|tout|tous|toute|chaque|depuis|fichier|document|titre|auteur|exporter|annuler|parcourir|chapitre|livre|veuillez|impossible|erreur|ouvert|entrer|saisir)\b/i;

/** Attributs et appels où un littéral n'atteint jamais l'utilisateur. */
const IGNORED_LINE =
  /^\s*(import\s|export\s+(type|interface)\b)|className=|data-testid=|console\.(log|warn|error|debug|info)\(|\.css'|\.svg'/;

/**
 * Neutralise les commentaires en préservant les numéros de ligne : les
 * apostrophes d'un commentaire français (« l'export d'un livre »)
 * ressembleraient sinon à des littéraux de chaîne.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function looksFrench(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  // Purement ponctuation, symboles ou chiffres.
  if (/^[\s\p{P}\p{S}\d]+$/u.test(trimmed)) return false;
  // Une clé i18n (`export.pdf.title`) n'est pas du texte d'interface.
  if (/^[a-z][\w]*(\.[\w]+)+$/i.test(trimmed)) return false;
  // Chemins et noms de fichiers.
  if (/^[./]/.test(trimmed) || /\.(md|json|pdf|docx|html|css|tsx?)$/i.test(trimmed)) return false;
  // Identifiant technique en kebab-case (`word-export-scope`).
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/i.test(trimmed)) return false;
  // Un accent tranche à lui seul ; sinon on cherche un mot français.
  return ACCENTED.test(trimmed) || FRENCH_WORDS.test(trimmed);
}

/** Littéraux de chaîne, ligne par ligne (attributs, arguments). */
function stringLiterals(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  source.split('\n').forEach((line, i) => {
    if (IGNORED_LINE.test(line)) return;
    const re = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      out.push({ line: i + 1, text: m[1] ?? m[2] ?? '' });
    }
  });
  return out;
}

/**
 * Texte JSX entre balises, sur l'ensemble du fichier — le libellé d'un
 * bouton est souvent seul sur sa ligne, une analyse ligne à ligne le
 * manquerait (c'est le cas de « Parcourir », vérifié par l'auto-contrôle).
 */
function jsxText(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const re = />([^<>{}]+)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1].trim()) out.push({ line: lineOf(source, m.index), text: m[1] });
  }
  return out;
}

function offendersIn(source: string): { line: number; text: string }[] {
  return [...stringLiterals(source), ...jsxText(source)].filter(({ text }) =>
    looksFrench(text),
  );
}

const COMPONENTS = readdirSync(EXPORT_DIR).filter((f) => f.endsWith('.tsx'));

describe('composants Export — pas de texte français codé en dur', () => {
  it('découvre bien les composants à contrôler', () => {
    expect(COMPONENTS.length).toBeGreaterThan(0);
    expect(COMPONENTS).toContain('PDFExportModal.tsx');
    expect(COMPONENTS).toContain('WordExportModal.tsx');
  });

  it.each(COMPONENTS)('%s ne contient aucun texte français visible', (file) => {
    const source = stripComments(readFileSync(path.join(EXPORT_DIR, file), 'utf-8'));
    const offenders = offendersIn(source).map(
      ({ line, text }) => `L${line}: ${text.trim().slice(0, 70)}`,
    );

    expect(
      offenders,
      `Texte d'interface codé en dur dans ${file} — passer par t() et ajouter la clé dans fr/en/de`,
    ).toEqual([]);
  });

  it('détecte réellement une régression (auto-contrôle)', () => {
    // Sans cette vérification, une heuristique trop permissive donnerait un
    // faux sentiment de sécurité : le test passerait quoi qu'il arrive.
    const regressions = [
      '<button onClick={go}>\n  Parcourir\n</button>',
      '<label>Titre du document</label>',
      "setError('Aucun projet ouvert');",
      '<option value="book">Tout le livre</option>',
    ];
    for (const snippet of regressions) {
      expect(offendersIn(snippet).length, `non détecté : ${snippet}`).toBeGreaterThan(0);
    }
  });

  it('ne signale pas les usages légitimes (contrôle des faux positifs)', () => {
    const legitimate = [
      "{t('export.pdf.browse')}",
      '<label htmlFor="pdf-export-scope">{t(\'export.scope.label\')}</label>',
      "style: 'chicago-note-bibliography',",
      "<code>abstract.md</code>",
      '<button>Browse</button>',
    ];
    for (const snippet of legitimate) {
      expect(offendersIn(snippet), `faux positif : ${snippet}`).toEqual([]);
    }
  });
});
