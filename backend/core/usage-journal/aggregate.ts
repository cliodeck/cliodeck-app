/**
 * Journal d'usage IA — agrégation (pure, sans I/O).
 *
 * Transforme une liste d'`inference_events` (+ liaisons session↔décision) en une
 * synthèse lisible : ventilation par provider / mode / corpus, local vs cloud,
 * sessions détectées, et **violations** (sessions substantielles non annotées).
 * Les sessions viennent des `session_id` déjà persistés à l'écriture (le découpage
 * heuristique vit dans le service) — ici on regroupe, on ne redécoupe pas.
 */

import type {
  InferenceEvent,
  ProposalAdjudication,
  SessionDecisionLink,
} from './types.js';

export interface ProviderBreakdown {
  provider: string;
  isLocal: boolean;
  events: number;
  totalTokens: number;
}

export interface ModeBreakdown {
  mode: string;
  events: number;
  totalTokens: number;
}

export interface CorpusBreakdown {
  corpus: string;
  events: number;
  chunks: number;
  totalTokens: number;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  endedAt: string;
  workspace: string;
  events: number;
  totalTokens: number;
  modes: string[];
  providers: string[];
  covered: boolean;
  substantial: boolean;
}

export interface UsageSummary {
  from: string;
  to: string;
  totalEvents: number;
  totalTokens: number;
  localTokens: number;
  cloudTokens: number;
  byProvider: ProviderBreakdown[];
  byMode: ModeBreakdown[];
  byCorpus: CorpusBreakdown[];
  sessions: SessionSummary[];
  /** Sessions substantielles non rattachées à une décision (le journal montre ses trous). */
  violations: SessionSummary[];
}

export interface SummarizeOptions {
  from: string;
  to: string;
  /** Une session est « substantielle » au-delà de ces seuils (OU logique). */
  substantialEvents?: number;
  substantialTokens?: number;
}

const DEFAULT_SUBSTANTIAL_EVENTS = 3;
const DEFAULT_SUBSTANTIAL_TOKENS = 1000;

/** Tokens comptés pour un événement (total explicite sinon somme prompt+réponse). */
export function eventTokens(e: InferenceEvent): number {
  if (typeof e.totalTokens === 'number') return e.totalTokens;
  return (e.promptTokens ?? 0) + (e.completionTokens ?? 0);
}

function bump<T extends { events: number; totalTokens: number }>(
  map: Map<string, T>,
  key: string,
  make: () => T,
  tokens: number
): T {
  let row = map.get(key);
  if (!row) {
    row = make();
    map.set(key, row);
  }
  row.events += 1;
  row.totalTokens += tokens;
  return row;
}

export function summarize(
  events: InferenceEvent[],
  links: SessionDecisionLink[],
  opts: SummarizeOptions
): UsageSummary {
  const substantialEvents = opts.substantialEvents ?? DEFAULT_SUBSTANTIAL_EVENTS;
  const substantialTokens = opts.substantialTokens ?? DEFAULT_SUBSTANTIAL_TOKENS;

  const coveredSessions = new Set(links.map((l) => l.sessionId));

  const byProvider = new Map<string, ProviderBreakdown>();
  const byMode = new Map<string, ModeBreakdown>();
  const byCorpus = new Map<string, CorpusBreakdown>();
  const sessionMap = new Map<
    string,
    SessionSummary & { modeSet: Set<string>; providerSet: Set<string> }
  >();

  let totalTokens = 0;
  let localTokens = 0;
  let cloudTokens = 0;

  for (const e of events) {
    const tokens = eventTokens(e);
    totalTokens += tokens;
    if (e.isLocal) localTokens += tokens;
    else cloudTokens += tokens;

    bump(
      byProvider,
      e.provider,
      () => ({ provider: e.provider, isLocal: e.isLocal, events: 0, totalTokens: 0 }),
      tokens
    );
    bump(byMode, e.mode, () => ({ mode: e.mode, events: 0, totalTokens: 0 }), tokens);

    if (e.corpus) {
      const row = bump(
        byCorpus,
        e.corpus,
        () => ({ corpus: e.corpus as string, events: 0, chunks: 0, totalTokens: 0 }),
        tokens
      );
      row.chunks += e.chunkCount ?? 0;
    }

    let s = sessionMap.get(e.sessionId);
    if (!s) {
      s = {
        id: e.sessionId,
        startedAt: e.at,
        endedAt: e.at,
        workspace: e.workspace,
        events: 0,
        totalTokens: 0,
        modes: [],
        providers: [],
        covered: coveredSessions.has(e.sessionId),
        substantial: false,
        modeSet: new Set<string>(),
        providerSet: new Set<string>(),
      };
      sessionMap.set(e.sessionId, s);
    }
    s.events += 1;
    s.totalTokens += tokens;
    if (e.at < s.startedAt) s.startedAt = e.at;
    if (e.at > s.endedAt) s.endedAt = e.at;
    s.modeSet.add(e.mode);
    s.providerSet.add(e.provider);
  }

  const sessions: SessionSummary[] = [...sessionMap.values()]
    .map((s) => {
      const substantial =
        s.events >= substantialEvents || s.totalTokens >= substantialTokens;
      return {
        id: s.id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        workspace: s.workspace,
        events: s.events,
        totalTokens: s.totalTokens,
        modes: [...s.modeSet].sort(),
        providers: [...s.providerSet].sort(),
        covered: s.covered,
        substantial,
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const sortByTokens = <T extends { totalTokens: number }>(rows: T[]): T[] =>
    rows.sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    from: opts.from,
    to: opts.to,
    totalEvents: events.length,
    totalTokens,
    localTokens,
    cloudTokens,
    byProvider: sortByTokens([...byProvider.values()]),
    byMode: sortByTokens([...byMode.values()]),
    byCorpus: sortByTokens([...byCorpus.values()]),
    sessions,
    violations: sessions.filter((s) => s.substantial && !s.covered),
  };
}

// ============================================================================
// Adjudications de propositions (plan CM6, Phase 4)
// ============================================================================

/**
 * Ventilation des adjudications pour une clé (catégorie ou modèle).
 * Le taux d'acceptation ne porte que sur les adjudications *jugées*
 * (accepted / rejected / modified) : les `invalidated` (édition humaine) et
 * `expired` (fermeture du document) sont des fins de vie sans jugement,
 * comptées à part et exclues du dénominateur.
 */
export interface AdjudicationBreakdown {
  key: string;
  accepted: number;
  rejected: number;
  modified: number;
  invalidated: number;
  expired: number;
  /** accepted / (accepted + rejected + modified), null si aucune adjudication jugée. */
  acceptanceRate: number | null;
}

export interface AdjudicationSummary {
  from: string;
  to: string;
  total: number;
  byCategory: AdjudicationBreakdown[];
  byModel: AdjudicationBreakdown[];
  overall: AdjudicationBreakdown;
}

function emptyBreakdown(key: string): AdjudicationBreakdown {
  return {
    key,
    accepted: 0,
    rejected: 0,
    modified: 0,
    invalidated: 0,
    expired: 0,
    acceptanceRate: null,
  };
}

function countInto(b: AdjudicationBreakdown, decision: ProposalAdjudication['decision']): void {
  b[decision] += 1;
}

function finalize(b: AdjudicationBreakdown): AdjudicationBreakdown {
  const judged = b.accepted + b.rejected + b.modified;
  b.acceptanceRate = judged > 0 ? b.accepted / judged : null;
  return b;
}

/** Agrège une liste d'adjudications en taux par catégorie / modèle / global. */
export function summarizeAdjudications(
  adjudications: ProposalAdjudication[],
  range: { from: string; to: string }
): AdjudicationSummary {
  const byCategory = new Map<string, AdjudicationBreakdown>();
  const byModel = new Map<string, AdjudicationBreakdown>();
  const overall = emptyBreakdown('overall');

  for (const a of adjudications) {
    let cat = byCategory.get(a.category);
    if (!cat) {
      cat = emptyBreakdown(a.category);
      byCategory.set(a.category, cat);
    }
    let model = byModel.get(a.model);
    if (!model) {
      model = emptyBreakdown(a.model);
      byModel.set(a.model, model);
    }
    countInto(cat, a.decision);
    countInto(model, a.decision);
    countInto(overall, a.decision);
  }

  const sortByVolume = (rows: AdjudicationBreakdown[]): AdjudicationBreakdown[] =>
    rows
      .map(finalize)
      .sort(
        (x, y) =>
          y.accepted + y.rejected + y.modified - (x.accepted + x.rejected + x.modified) ||
          x.key.localeCompare(y.key)
      );

  return {
    from: range.from,
    to: range.to,
    total: adjudications.length,
    byCategory: sortByVolume([...byCategory.values()]),
    byModel: sortByVolume([...byModel.values()]),
    overall: finalize(overall),
  };
}
