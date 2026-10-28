#!/usr/bin/env node
/**
 * Part du manuscrit dans les réponses de l'assistant, en lecture seule.
 *
 *   npm run rag:manuscript-share -- /chemin/vers/le/projet [--since 2026-10-01] [--json]
 *
 * Lit `history_chat_messages.sources_json` dans `.cliodeck/brain.db` : chaque
 * réponse de l'assistant y garde, par extrait injecté dans le prompt, le
 * corpus d'origine (`sourceType`) et la similarité publiée. Le script en tire
 * la part du manuscrit par réponse et par mode de chat, et un histogramme de
 * similarité par corpus — la seule mesure empirique dont le projet dispose
 * sur l'hypothèse de « similarité de soi à soi » (docs/poids-du-manuscrit.md,
 * palier 1). Les similarités sont celles des extraits **retenus** pour le
 * prompt, après seuil et quota : la distribution est tronquée par le bas.
 *
 * Code de sortie : 0 si la mesure est produite, 2 en cas d'erreur (usage,
 * base ou table absente). La base n'est jamais écrite : ouverture `immutable`
 * ou, si l'app la tient ouverte, lecture seule classique — même chemin que le
 * bilan de santé (`openBrainDb`). À lancer par `scripts/electron-node.mjs`
 * (Node ≥ 22.13 pour `node:sqlite`).
 *
 * L'agrégation (`aggregateRows`) et le rendu (`renderMarkdown`) sont des
 * fonctions pures, testées dans scripts/__tests__/manuscript-share.test.ts ;
 * le module ne lance la ligne de commande que s'il est le point d'entrée.
 */

import { existsSync, realpathSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openBrainDb } from './project-health/checks.mjs';

/** Corpus connus, dans l'ordre des tableaux ; tout autre `sourceType` rencontré est ajouté à la suite. */
export const KNOWN_SOURCE_TYPES = ['manuscript', 'secondary', 'primary', 'vault', 'readingNotes'];
/** Lignes antérieures au champ `sourceType` (ou valeur absente) : comptées à part, jamais devinées. */
export const UNKNOWN_SOURCE_TYPE = 'unknown';
/** `mode_id` est NULL sur les lignes d'avant la migration v2 et sur celles du mode libre sans identifiant. */
export const SANS_MODE = '(sans mode)';
/** Dix classes de 0,1 entre 0 et 1 ; la dernière est fermée (1,0 y compte). */
export const BIN_COUNT = 10;
/**
 * Approximation de « le modèle cite le manuscrit » : la numérotation des
 * extraits du manuscrit est `[M1]` (`[M 1]` avant le palier 1). Un faux
 * positif reste possible (« [Mémoire… »), d'où le chiffre exigé après le M.
 */
export const MANUSCRIPT_CITATION = /\[M\s?\d/;

const LABELS = {
  manuscript: 'Manuscrit',
  secondary: 'Bibliographie',
  primary: 'Sources primaires',
  vault: 'Vault Obsidian',
  readingNotes: 'Notes de lecture',
  [UNKNOWN_SOURCE_TYPE]: 'Sans type (lignes anciennes)',
};

const corpusLabel = (type) => LABELS[type] ?? type;

// ---------------------------------------------------------------------------
// Agrégation (pure)
// ---------------------------------------------------------------------------

/**
 * Normalise `sources_json` : une liste de `{ sourceType, similarity }`, le
 * type manquant devenant `unknown`, la similarité non numérique `null`. Une
 * valeur illisible n'interrompt rien : la réponse compte comme sans source et
 * est signalée (`illisible`).
 */
export function parseSources(sourcesJson) {
  if (sourcesJson == null || sourcesJson === '') return { sources: [], illisible: false };
  let parsed;
  try {
    parsed = JSON.parse(sourcesJson);
  } catch {
    return { sources: [], illisible: true };
  }
  if (!Array.isArray(parsed)) return { sources: [], illisible: true };
  const sources = parsed
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      sourceType: typeof s.sourceType === 'string' && s.sourceType ? s.sourceType : UNKNOWN_SOURCE_TYPE,
      similarity: typeof s.similarity === 'number' && Number.isFinite(s.similarity) ? s.similarity : null,
    }));
  return { sources, illisible: false };
}

export function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Indice de classe d'une similarité, ou -1 hors de [0 ; 1] (un cosinus peut être négatif). */
export function binIndex(similarity) {
  if (similarity < 0 || similarity > 1) return -1;
  return Math.min(BIN_COUNT - 1, Math.floor(similarity * BIN_COUNT));
}

function newGroup() {
  return {
    reponses: 0,
    avecSources: 0,
    avecManuscrit: 0,
    toutManuscrit: 0,
    citentManuscrit: 0,
    sourcesIllisibles: 0,
    parts: [],
    extraits: {},
    similarites: {},
  };
}

function addAnswer(group, { sources, illisible }, cite) {
  group.reponses++;
  if (illisible) group.sourcesIllisibles++;
  if (cite) group.citentManuscrit++;
  if (sources.length === 0) return;
  group.avecSources++;
  let manuscrit = 0;
  for (const source of sources) {
    group.extraits[source.sourceType] = (group.extraits[source.sourceType] ?? 0) + 1;
    if (source.sourceType === 'manuscript') manuscrit++;
    if (source.similarity !== null) (group.similarites[source.sourceType] ??= []).push(source.similarity);
  }
  if (manuscrit > 0) group.avecManuscrit++;
  if (manuscrit === sources.length) group.toutManuscrit++;
  group.parts.push(manuscrit / sources.length);
}

/** Corpus connus d'abord, puis ceux que les données apportent en plus (`unknown`, valeurs inattendues). */
function corpusOrder(...keyLists) {
  const extra = new Set();
  for (const keys of keyLists) for (const k of keys) if (!KNOWN_SOURCE_TYPES.includes(k)) extra.add(k);
  return [...KNOWN_SOURCE_TYPES, ...[...extra].sort()];
}

function finaliseGroup(group) {
  const order = corpusOrder(Object.keys(group.extraits), Object.keys(group.similarites));
  const total = Object.values(group.extraits).reduce((a, b) => a + b, 0);
  const parCorpus = {};
  const histogramme = {};
  for (const type of order) {
    parCorpus[type] = group.extraits[type] ?? 0;
    const values = group.similarites[type] ?? [];
    const bornes = new Array(BIN_COUNT).fill(0);
    let horsBornes = 0;
    for (const v of values) {
      const i = binIndex(v);
      if (i < 0) horsBornes++;
      else bornes[i]++;
    }
    histogramme[type] = { n: values.length, bornes, horsBornes, moyenne: mean(values), mediane: median(values) };
  }
  return {
    reponses: group.reponses,
    avecSources: group.avecSources,
    avecManuscrit: group.avecManuscrit,
    sourcesIllisibles: group.sourcesIllisibles,
    citentManuscrit: group.citentManuscrit,
    partManuscrit: {
      // Sur les réponses qui ont au moins une source : une réponse sans source n'a pas de part.
      moyenne: mean(group.parts),
      mediane: median(group.parts),
      toutManuscrit: group.toutManuscrit,
      // Tous extraits confondus, toutes réponses : la part « en volume ».
      globale: total ? (group.extraits.manuscript ?? 0) / total : null,
    },
    extraits: { total, parCorpus },
    histogramme,
  };
}

/**
 * Agrège les lignes de `history_chat_messages` (`role`, `content`,
 * `sources_json`, `timestamp`, `mode_id`) : vue d'ensemble et par mode.
 * Seules les réponses de l'assistant comptent ; `since` (ISO 8601) écarte ce
 * qui précède, une ligne sans date lisible comprise.
 */
export function aggregateRows(rows, options = {}) {
  const since = options.since ?? null;
  const sinceMs = since ? Date.parse(since) : null;
  if (since && Number.isNaN(sinceMs)) throw new Error(`Date invalide pour --since : ${since}`);

  const ensemble = newGroup();
  const modes = new Map();
  for (const row of rows) {
    if (row.role !== 'assistant') continue;
    if (sinceMs !== null && !(Date.parse(row.timestamp) >= sinceMs)) continue;
    const modeId = row.mode_id || SANS_MODE;
    if (!modes.has(modeId)) modes.set(modeId, newGroup());
    const parsed = parseSources(row.sources_json);
    const cite = MANUSCRIPT_CITATION.test(row.content ?? '');
    addAnswer(ensemble, parsed, cite);
    addAnswer(modes.get(modeId), parsed, cite);
  }

  const parMode = [...modes.entries()]
    .sort(([a, ga], [b, gb]) => gb.reponses - ga.reponses || a.localeCompare(b, 'fr'))
    .map(([modeId, group]) => ({ modeId, ...finaliseGroup(group) }));

  return { since, ensemble: finaliseGroup(ensemble), modes: parMode };
}

// ---------------------------------------------------------------------------
// Rendu Markdown (pur)
// ---------------------------------------------------------------------------

const dec = (x, digits = 1) => x.toFixed(digits).replace('.', ',');
const fmtPct = (x) => (x == null ? '—' : `${dec(x * 100)} %`);
const fmtSim = (x) => (x == null ? '—' : dec(x, 3));
const binLabel = (i) =>
  i === BIN_COUNT - 1 ? `[${dec(i / BIN_COUNT)} ; 1,0]` : `[${dec(i / BIN_COUNT)} ; ${dec((i + 1) / BIN_COUNT)}[`;

function table(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

function summaryRows(group) {
  const rows = [
    ['Réponses de l’assistant', group.reponses],
    ['… avec au moins une source', group.avecSources],
    ['… avec au moins un extrait du manuscrit', group.avecManuscrit],
    ['Part du manuscrit dans les extraits — moyenne (réponses avec sources)', fmtPct(group.partManuscrit.moyenne)],
    ['Part du manuscrit — médiane', fmtPct(group.partManuscrit.mediane)],
    ['Part du manuscrit — tous extraits confondus', fmtPct(group.partManuscrit.globale)],
    ['Réponses dont 100 % des extraits viennent du manuscrit', group.partManuscrit.toutManuscrit],
    ['Réponses qui citent le manuscrit (marque « [M n] », approximation)', group.citentManuscrit],
  ];
  if (group.sourcesIllisibles) rows.push(['Réponses dont `sources_json` est illisible', group.sourcesIllisibles]);
  return rows;
}

export function renderMarkdown(agg, meta = {}) {
  const { ensemble } = agg;
  const out = [];

  out.push(`# Part du manuscrit dans les réponses${meta.projet ? ` — ${meta.projet}` : ''}`);
  out.push('');
  if (meta.base) {
    const mode = meta.walPending ? 'base ouverte par l’app ou fermée brutalement : lecture seule classique' : 'lecture seule, `immutable`';
    out.push(`Base : \`${meta.base}\` (${mode})  `);
  }
  out.push(`Période : ${agg.since ? `depuis ${agg.since}` : 'toute la période'}  `);
  out.push('Similarités : celles des extraits retenus pour le prompt (après seuil et quota), pas de tout le corpus.');
  out.push('');

  out.push('## Vue d’ensemble');
  out.push('');
  out.push(table(['Indicateur', 'Valeur'], summaryRows(ensemble)));
  out.push('');

  const corpora = Object.keys(ensemble.extraits.parCorpus);
  out.push('### Extraits par corpus');
  out.push('');
  out.push(
    table(
      ['Corpus', 'Extraits', 'Part'],
      corpora.map((type) => [
        `${corpusLabel(type)} (\`${type}\`)`,
        ensemble.extraits.parCorpus[type],
        fmtPct(ensemble.extraits.total ? ensemble.extraits.parCorpus[type] / ensemble.extraits.total : null),
      ]),
    ),
  );
  out.push('');

  out.push('## Par mode de chat');
  out.push('');
  if (agg.modes.length === 0) {
    out.push('Aucune réponse de l’assistant sur la période.');
  } else {
    out.push(
      table(
        ['Mode', 'Réponses', 'Avec sources', 'Avec manuscrit', 'Part moyenne', 'Part médiane', '100 % manuscrit', 'Citent [M n]'],
        agg.modes.map((m) => [
          m.modeId === SANS_MODE ? SANS_MODE : `\`${m.modeId}\``,
          m.reponses,
          m.avecSources,
          m.avecManuscrit,
          fmtPct(m.partManuscrit.moyenne),
          fmtPct(m.partManuscrit.mediane),
          m.partManuscrit.toutManuscrit,
          m.citentManuscrit,
        ]),
      ),
    );
  }
  out.push('');

  out.push('## Similarité par corpus');
  out.push('');
  out.push(
    '> **Seule mesure empirique du projet sur l’hypothèse de « similarité de soi à soi »** : le manuscrit, écrit dans la langue et le vocabulaire de la question, obtiendrait des similarités plus hautes que les sources. Les valeurs sont celles publiées dans `sources_json`, c’est-à-dire les extraits **retenus** pour le prompt ; ceux écartés par le seuil ou le quota n’y figurent pas, la distribution est donc tronquée par le bas et dépend du modèle d’embedding du projet.',
  );
  out.push('');
  const histoCorpora = Object.keys(ensemble.histogramme);
  const histoRows = [];
  for (let i = 0; i < BIN_COUNT; i++) {
    histoRows.push([binLabel(i), ...histoCorpora.map((type) => ensemble.histogramme[type].bornes[i])]);
  }
  if (histoCorpora.some((type) => ensemble.histogramme[type].horsBornes > 0)) {
    histoRows.push(['hors [0 ; 1]', ...histoCorpora.map((type) => ensemble.histogramme[type].horsBornes)]);
  }
  histoRows.push(['**n**', ...histoCorpora.map((type) => `**${ensemble.histogramme[type].n}**`)]);
  histoRows.push(['moyenne', ...histoCorpora.map((type) => fmtSim(ensemble.histogramme[type].moyenne))]);
  histoRows.push(['médiane', ...histoCorpora.map((type) => fmtSim(ensemble.histogramme[type].mediane))]);
  out.push(table(['Intervalle', ...histoCorpora.map(corpusLabel)], histoRows));
  out.push('');

  const perMode = [];
  for (const m of agg.modes) {
    for (const type of Object.keys(m.histogramme)) {
      const h = m.histogramme[type];
      if (h.n === 0) continue;
      perMode.push([m.modeId === SANS_MODE ? SANS_MODE : `\`${m.modeId}\``, corpusLabel(type), h.n, fmtSim(h.moyenne), fmtSim(h.mediane)]);
    }
  }
  if (perMode.length > 0) {
    out.push('### Par mode de chat');
    out.push('');
    out.push(table(['Mode', 'Corpus', 'n', 'Moyenne', 'Médiane'], perMode));
    out.push('');
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Lecture de la base et ligne de commande
// ---------------------------------------------------------------------------

/**
 * Les réponses de l'assistant, dans l'ordre chronologique ; `null` si la base
 * n'a jamais eu de conversation (table absente). `mode_id` est arrivé par la
 * migration v2 : une base d'avant est lue avec NULL à sa place.
 */
export function readRows(db) {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_chat_messages'")
    .get();
  if (!table) return null;
  const columns = db.prepare('PRAGMA table_info(history_chat_messages)').all().map((c) => c.name);
  const modeExpr = columns.includes('mode_id') ? 'mode_id' : 'NULL AS mode_id';
  return db
    .prepare(
      `SELECT role, content, sources_json, timestamp, ${modeExpr} FROM history_chat_messages WHERE role = 'assistant' ORDER BY timestamp`,
    )
    .all();
}

const USAGE = 'usage : npm run rag:manuscript-share -- /chemin/vers/le/projet [--since 2026-10-01] [--json]';

export function parseArgs(args) {
  const options = { json: false, since: null, target: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--since') {
      options.since = args[++i] ?? null;
      if (!options.since) return { error: '--since attend une date ISO 8601 (ex. 2026-10-01)' };
    } else if (arg.startsWith('--since=')) options.since = arg.slice('--since='.length);
    else if (arg.startsWith('--')) return { error: `option inconnue : ${arg}` };
    else if (options.target) return { error: `un seul chemin de projet attendu, reçu aussi : ${arg}` };
    else options.target = arg;
  }
  if (!options.target) return { error: null };
  if (options.since && Number.isNaN(Date.parse(options.since))) {
    return { error: `date invalide pour --since : ${options.since} (attendu : ISO 8601, ex. 2026-10-01)` };
  }
  return { options };
}

async function main(argv) {
  const parsed = parseArgs(argv.slice(2));
  if (!parsed.options) {
    if (parsed.error) console.error(parsed.error);
    console.error(USAGE);
    return 2;
  }
  const { target, since, json } = parsed.options;

  const projectPath = path.resolve(target);
  const dbPath = path.join(projectPath, '.cliodeck', 'brain.db');
  if (!existsSync(dbPath)) {
    console.error(`Pas de .cliodeck/brain.db dans ${projectPath}`);
    return 2;
  }

  // node:sqlite émet un avertissement « experimental » sur certaines versions.
  process.removeAllListeners('warning');

  const { db, walPending } = await openBrainDb(dbPath);
  let rows;
  try {
    rows = readRows(db);
  } finally {
    db.close();
  }
  if (rows === null) {
    console.error('Pas de table history_chat_messages dans cette base : aucune conversation enregistrée.');
    return 2;
  }

  const agg = aggregateRows(rows, { since });
  const meta = { projet: projectPath, base: dbPath, walPending };
  if (json) console.log(JSON.stringify({ ...meta, ...agg }, null, 2));
  else console.log(renderMarkdown(agg, meta));
  return 0;
}

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // `exitCode` plutôt que `process.exit()` : sur un tube, la sortie standard
  // est asynchrone sous macOS et un rapport un peu long serait tronqué.
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    },
  );
}
