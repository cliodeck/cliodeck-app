/**
 * Ce que les Réglages écrivent, et ce qu'ils laissent en place.
 *
 * Le panneau lit ses quatre sections à l'ouverture. Les renvoyer entières annulait ce que les
 * autres sections de la même fenêtre avaient écrit entre-temps (langue du prompt, fournisseur
 * d'embeddings, modèle supprimé) : seuls les champs modifiés partent désormais, posés sur la
 * section relue juste avant l'écriture.
 */
import { DEFAULT_CONFIG, type LLMConfig as StoredLLMConfig } from '@backend/types/config';
import type { RAGQueryParams } from '../../stores/ragQueryStore';
import type { LLMConfig, RAGConfig } from './ConfigPanel';
import type { EditorConfig } from './EditorConfigSection';
import type { ZoteroConfig } from './ZoteroConfigSection';

export interface SettingsSections {
  rag: RAGConfig;
  llm: LLMConfig;
  editor: EditorConfig;
  zotero: ZoteroConfig;
}
export type SectionName = keyof SettingsSections;
export const SECTION_NAMES: readonly SectionName[] = ['rag', 'llm', 'editor', 'zotero'];

/**
 * Sections écrites mais non appliquées au projet ouvert : le prochain Enregistrer retente, même sans
 * rien à écrire. Hors du montage : la modale démonte le panneau à la fermeture, et les services,
 * eux, restent à l'arrêt. Une relance de trop après un changement de projet est sans conséquence.
 */
export const notApplied = new Set<SectionName>();

/** Une seule source pour ce que le formulaire montre tant que le disque ne dit rien. */
export const FORM_DEFAULTS: SettingsSections = {
  rag: {
    // Champs que le formulaire exige et que DEFAULT_CONFIG ne renseigne pas.
    summaryGeneration: 'extractive',
    summaryMaxLength: 750,
    useGraphContext: false,
    graphSimilarityThreshold: 0.7,
    additionalGraphDocs: 3,
    explorationSimilarityThreshold: 0.7,
    includeSummaries: true,
    enableTopicModeling: false,
    enableContextCompression: true,
    indexManuscript: true,
    indexReadingNotes: true,
    readingNotesCloudConsent: false,
    ...DEFAULT_CONFIG.rag,
  },
  llm: DEFAULT_CONFIG.llm,
  editor: { ...DEFAULT_CONFIG.editor, fontFamily: 'system' },
  zotero: { mode: 'api', userId: '', apiKey: '', autoSync: false, dataDirectory: '' },
};

/** La section telle que le formulaire la montre. Sur le disque, `undefined` n'existe pas (JSON). */
export function withFormDefaults<S extends SectionName>(section: S, saved: unknown): SettingsSections[S] {
  const present = Object.entries((saved ?? {}) as object).filter(([, value]) => value !== undefined);
  return { ...FORM_DEFAULTS[section], ...Object.fromEntries(present) };
}

/**
 * Deux objets égaux ne sont pas un changement, quel que soit l'ordre de leurs clés, et un `NaN`
 * ne passe pas pour un changement à chaque Enregistrer.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) =>
    sameValue(left[key], right[key])
  );
}

const LLM_API_KEY_FIELDS = ['claudeAPIKey', 'openaiAPIKey', 'mistralAPIKey', 'geminiAPIKey'] as const;
const API_KEY_FIELDS = new Set<string>([...LLM_API_KEY_FIELDS, 'apiKey']);

/**
 * Les champs de `next` qui diffèrent de `before`. Une clé absente de `next` n'est pas touchée : le
 * diff n'efface jamais ce que le formulaire ne connaît pas. Une clé à `undefined` s'efface.
 */
export function diffSection(before: object, next: object): Record<string, unknown> {
  const old = before as Record<string, unknown>;
  const diff: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (sameValue(old[key], value)) continue;
    // Un champ de clé vide des deux côtés : `getLLMConfig` omet une clé illisible, qui existe
    // encore. Saisir puis effacer n'est pas demander sa suppression (`''` = effacer).
    if (API_KEY_FIELDS.has(key) && !old[key] && !value) continue;
    diff[key] = value;
  }
  return diff;
}

/**
 * Ce que le panneau du chat reprend d'une section `rag` écrite, et seulement ce qui vient de changer :
 * son curseur de sources et son prompt personnalisé restent des réglages de session. Un `topK` vidé
 * (NaN) ne le suit pas : il passerait le `??` du main.
 */
export function chatParamsFromRagDiff(diff: Record<string, unknown>): Partial<RAGQueryParams> {
  const params: Partial<RAGQueryParams> = {};
  if (typeof diff.topK === 'number' && diff.topK > 0) params.topK = diff.topK;
  if ('useCustomSystemPrompt' in diff) params.useCustomSystemPrompt = diff.useCustomSystemPrompt === true;
  if ('customSystemPrompt' in diff) params.customSystemPrompt = diff.customSystemPrompt as string | undefined;
  return params;
}

/**
 * Chaque motif une fois. L'écriture passe par un fichier temporaire au nom aléatoire
 * (`cliodeck-config.json.tmp-<hex>`), qui faisait de chaque section un motif différent.
 */
export function distinctReasons(reasons: readonly string[]): string {
  return [...new Set(reasons.map((reason) => reason.replace(/\.tmp-[0-9a-f]+/g, '')))].join(' ; ');
}

/** Ce que le main dit des champs de clés : le masque, ou rien. Pour relire après une révocation. */
export function apiKeyFields(saved: {
  llm: Partial<LLMConfig> | null | undefined;
  zotero: Partial<ZoteroConfig> | null | undefined;
}): { llm: Partial<LLMConfig>; zotero: Pick<ZoteroConfig, 'apiKey'> } {
  const llm: Partial<LLMConfig> = {};
  for (const field of LLM_API_KEY_FIELDS) llm[field] = saved.llm?.[field];
  return { llm, zotero: { apiKey: saved.zotero?.apiKey ?? '' } };
}

/**
 * Réinitialiser (décision de l'auteur, Q7) laisse en place le modèle et le fournisseur
 * d'embeddings, la langue du prompt, les clés d'API et la section Zotero ; tout le reste revient
 * aux valeurs par défaut.
 *
 * Tout ce qui décide de l'index reste, même sans s'appeler « embeddings » : changer l'un de ces
 * champs mettrait les requêtes et l'index dans deux espaces vectoriels, sans erreur (`cosine()`
 * compare sur la longueur minimale). Le `Record` force à trancher pour tout nouveau champ, et
 * `settings-persist.test.ts` vérifie la liste contre le vrai adaptateur.
 */
const LLM_ON_RESET: Record<keyof StoredLLMConfig, 'keep' | 'default'> = {
  backend: 'default', // sauf quand il calcule aussi les embeddings : voir `backendComputesEmbeddings`
  ollamaURL: 'keep', // le serveur qui calcule les embeddings
  ollamaEmbeddingModel: 'keep',
  ollamaEmbeddingNumCtx: 'keep', // la fenêtre tronque le texte embarqué, donc change les vecteurs
  useCloudEmbeddings: 'keep',
  embeddingProvider: 'keep',
  embeddedEmbeddingModelId: 'keep',
  embeddedEmbeddingModelPath: 'keep',
  claudeAPIKey: 'keep',
  openaiAPIKey: 'keep',
  mistralAPIKey: 'keep',
  geminiAPIKey: 'keep',
  // Un fichier présent sur le disque, pas une préférence : la section « Modèle embarqué » le
  // montrerait toujours « téléchargé », sans bouton pour le raccrocher. Avec `auto`, le défaut,
  // il sert de repli quand Ollama ne répond pas (macOS 13, où Ollama ne s'installe pas).
  embeddedModelId: 'keep',
  embeddedModelPath: 'keep',
  ollamaChatModel: 'default',
  ollamaNumCtx: 'default',
  ollamaThink: 'default',
  claudeModel: 'default',
  openaiModel: 'default',
  mistralModel: 'default',
  geminiModel: 'default',
  generationProvider: 'default',
};

/** Même règle que `clioDeckConfigToRegistryConfig` : Anthropic n'a pas d'embeddings. */
function backendComputesEmbeddings(llm: Partial<StoredLLMConfig>): boolean {
  return llm.useCloudEmbeddings === true && ['gemini', 'openai', 'mistral'].includes(llm.backend ?? '');
}

function resetSection(
  fresh: object,
  defaults: object,
  kept: (key: string) => boolean
): Record<string, unknown> {
  const values = defaults as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(fresh), ...Object.keys(defaults)])) {
    if (!kept(key)) next[key] = values[key];
  }
  return next;
}

/**
 * Les valeurs qu'écrit Réinitialiser, à partir du disque (pas de l'instantané : une autre section
 * a pu écrire depuis l'ouverture). Un champ sans valeur par défaut est présent à `undefined`, donc
 * effacé. L'éditeur n'a que des champs à défaut : ce que personne ne connaît sur le disque y reste.
 * Zotero n'y figure pas : rien ne s'écrit, rien ne se relance.
 */
export function resetValues(fresh: {
  rag: object | null | undefined;
  llm: Partial<StoredLLMConfig> | null | undefined;
}): { rag: Record<string, unknown>; llm: Record<string, unknown>; editor: EditorConfig } {
  const llm = fresh.llm ?? {};
  return {
    rag: resetSection(fresh.rag ?? {}, DEFAULT_CONFIG.rag, (key) => key === 'systemPromptLanguage'),
    llm: resetSection(
      llm,
      DEFAULT_CONFIG.llm,
      (key) =>
        LLM_ON_RESET[key as keyof StoredLLMConfig] === 'keep' ||
        (key === 'backend' && backendComputesEmbeddings(llm))
    ),
    editor: FORM_DEFAULTS.editor,
  };
}
