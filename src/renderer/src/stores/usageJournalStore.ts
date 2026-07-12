import { create } from 'zustand';

/**
 * Store du **journal d'usage IA** — distinct du `journalStore` (journal de
 * recherche). Ne fait que lire le résumé du jour et enregistrer des décisions via
 * l'IPC `usage:*` ; toute la capture vit côté main. Voir `docs/journal-usage-ia.md`.
 */

export type Verdict = 'worth_it' | 'not_worth_it' | 'unsure' | 'pending';

export interface UsageSessionSummary {
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
  chunks: number;
  totalTokens: number;
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
  sessions: UsageSessionSummary[];
  violations: UsageSessionSummary[];
}

export interface UsageDecision {
  id: string;
  date: string;
  workspace: string;
  task: string;
  alternative: string;
  justification: string;
  verdict: Verdict;
  verdictNote?: string;
}

export interface TodayView {
  summary: UsageSummary;
  decisions: UsageDecision[];
}

export interface SaveDecisionInput {
  id?: string;
  task: string;
  alternative: string;
  justification: string;
  verdict: Verdict;
  verdictNote?: string;
  sessionIds: string[];
}

interface IpcResult {
  success: boolean;
  today?: TodayView | null;
  error?: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface UsageJournalState {
  today: TodayView | null;
  loading: boolean;
  saving: boolean;
  error: string | null;

  /** Nombre de sessions substantielles du jour non couvertes par une décision. */
  uncoveredCount: () => number;

  loadToday: () => Promise<void>;
  saveDecision: (input: SaveDecisionInput) => Promise<boolean>;
  setMode: (mode: string) => Promise<void>;
}

export const useUsageJournalStore = create<UsageJournalState>((set, get) => ({
  today: null,
  loading: false,
  saving: false,
  error: null,

  uncoveredCount: () => get().today?.summary.violations.length ?? 0,

  loadToday: async () => {
    set({ loading: true, error: null });
    try {
      const res = (await window.electron.usage.getToday()) as IpcResult;
      if (!res.success || !res.today) {
        set({ today: null, loading: false, error: res.error ?? null });
        return;
      }
      set({ today: res.today, loading: false });
    } catch (e) {
      set({ loading: false, error: errMsg(e) });
    }
  },

  saveDecision: async (input) => {
    set({ saving: true, error: null });
    try {
      const res = (await window.electron.usage.saveDecision(input)) as IpcResult;
      if (!res.success || !res.today) {
        set({ saving: false, error: res.error ?? 'Échec de l’enregistrement' });
        return false;
      }
      set({ today: res.today, saving: false });
      return true;
    } catch (e) {
      set({ saving: false, error: errMsg(e) });
      return false;
    }
  },

  setMode: async (mode) => {
    try {
      await window.electron.usage.setMode(mode);
    } catch {
      // best-effort : le journal ne doit jamais gêner la navigation.
    }
  },
}));
