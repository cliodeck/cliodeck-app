/**
 * Intention de rappel : l'utilisateur demande-t-il ce qu'IL a déjà écrit
 * dans SON manuscrit ? (palier 2 de `docs/poids-du-manuscrit.md`)
 *
 * Quand c'est le cas, la bande du manuscrit s'élargit à `min(topK, 6)` et
 * le manuscrit revient même dans l'espace Brainstorm, où il est absent par
 * défaut. Le détecteur tourne côté main à chaque tour de chat : il doit être
 * pur, déterministe et bon marché — aucun modèle, aucune E/S.
 *
 * Trois règles issues de la revue contradictoire du document :
 *
 *   - **On s'ancre sur un VERBE DE RAPPEL À LA PREMIÈRE PERSONNE** — « qu'ai-je
 *     écrit », « have I covered », « habe ich erwähnt » — jamais sur un
 *     possessif nu (« des angles pour mon chapitre sur Danzig » est une
 *     question sur les sources) ni sur un titre de chapitre.
 *   - **Le texte est normalisé avant la comparaison** : minuscules, accents
 *     retirés (NFD), apostrophes typographiques ramenées à l'apostrophe
 *     droite, blancs repliés. « qu ai-je », « qu'ai-je » et « Qu’ai-je »
 *     se lisent donc pareil.
 *   - **Dans le doute, non.** Un raté retombe sur le comportement par défaut ;
 *     un faux positif recrée la plainte d'origine (le manuscrit qui noie les
 *     sources). Les formes déclaratives ne sont donc acceptées qu'avec un
 *     marqueur de rappel (« déjà », « already ») ET un point d'interrogation
 *     dans la même phrase ; le « nous » académique est laissé de côté.
 *
 * Les tables sont exportées pour que le test les énumère : chaque motif
 * porte sa raison d'être et un exemple qui doit le déclencher.
 */

/** Résultat du détecteur ; `match` n'est présent que si `intent` est vrai. */
export interface ManuscriptIntentResult {
  intent: boolean;
  /** Fragment du texte normalisé qui a déclenché l'intention (pour le journal). */
  match?: string;
}

/** Un motif de rappel, avec sa justification et un exemple qui le déclenche. */
export interface RecallPattern {
  /** Appliqué au texte NORMALISÉ (voir `normaliseForIntent`). Sans drapeau `g`. */
  pattern: RegExp;
  /** Pourquoi ce motif existe — ce qu'il reconnaît, et ce qu'il laisse passer. */
  why: string;
  /** Une question réelle qui doit le déclencher ; le test le vérifie. */
  example: string;
}

export type IntentLanguage = 'fr' | 'en' | 'de';

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/** Apostrophes typographiques et accents isolés que les claviers produisent. */
const APOSTROPHES = /[‘’‛ʼ´`]/g;
/** Traits d'union typographiques (U+2010, U+2011) et tiret demi-cadratin. */
const HYPHENS = /[‐‑–]/g;
/** Marques diacritiques combinantes, une fois le texte décomposé (NFD). */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Ramène un texte à la forme sur laquelle les motifs sont écrits. Idempotente.
 */
export function normaliseForIntent(text: string): string {
  return text
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(APOSTROPHES, "'")
    .replace(HYPHENS, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Briques communes                                                            */
/* -------------------------------------------------------------------------- */

/** Élision facultative : « qu'ai-je », « qu ai-je » ou « quai-je ». */
const EL = "['\\s]?";

function rx(source: string): RegExp {
  return new RegExp(source);
}

/* -------------------------------------------------------------------------- */
/* Français                                                                    */
/* -------------------------------------------------------------------------- */

/** Participes passés des verbes de rappel ; l'accord (e, s, es) est admis. */
const FR_PP =
  '(?:ecrit|redige|dit|traite|aborde|mentionne|evoque|cite|parle|developpe|' +
  'note|montre|demontre|explique|analyse|souligne|discute|avance|affirme|' +
  'soutenu|couvert|defini|decrit|presente|formule|argumente|examine|etudie|' +
  'propose|signale|rappele|precise)(?:e|s|es)?\\b';
/** Adverbes qui peuvent s'intercaler entre l'auxiliaire et le participe. */
const FR_ADV = '(?:(?:deja|aussi|bien|vraiment|precedemment|auparavant|effectivement|moi-meme) )*';
/** « j'ai », « je n'ai », « je l'ai », « je ne l'ai », « j'en ai », « j'y ai ». */
const FR_J_AI = `(?:j${EL}ai|je (?:n${EL}|ne )?(?:l${EL}|en |y )?ai|j${EL}(?:en|y) ai)`;

export const FR_RECALL_PATTERNS: readonly RecallPattern[] = [
  {
    pattern: rx(`\\b(?:ai|avais)[-\\s]je (?:pas )?${FR_ADV}${FR_PP}`),
    why:
      "Inversion interrogative à la première personne : « qu'ai-je écrit », « où ai-je parlé », " +
      "« l'ai-je déjà dit », « n'ai-je pas déjà traité ». La question qui précède (qu', où, quand) " +
      'ne compte pas : « ai-je raison » ne déclenche rien, le participe manque.',
    example: "Qu'ai-je déjà écrit sur Danzig ?",
  },
  {
    pattern: rx(`\\best-ce que ${FR_J_AI} (?:pas )?${FR_ADV}${FR_PP}`),
    why:
      "Périphrase interrogative : « est-ce que j'ai déjà abordé », « qu'est-ce que j'ai dit de », " +
      "« est-ce que je l'ai mentionné ». « est-ce qui manque dans mon chapitre » n'a pas d'auxiliaire.",
    example: "Est-ce que j'ai déjà abordé la question du port ?",
  },
  {
    pattern: rx(`\\b(?:ce que|ou) ${FR_J_AI} (?:pas )?${FR_ADV}${FR_PP}`),
    why:
      "Relative nominale ou locative : « ce que j'ai écrit sur », « relis ce que j'ai dit de », " +
      "« les passages où j'ai traité ». « ce que les sources disent » n'est pas à la première personne ; " +
      "« où je cite Braudel » (présent) est laissé de côté : c'est souvent une simple localisation.",
    example: "Ce que j'ai écrit sur la Société des Nations",
  },
  {
    pattern: rx(`\\b${FR_J_AI} (?:pas )?deja ${FR_PP}[^.?!]*\\?`),
    why:
      "Déclarative interrogative : « j'ai déjà traité ce point ? ». Acceptée seulement avec « déjà » " +
      "ET un point d'interrogation dans la même phrase : « j'ai montré que… » dans un paragraphe collé " +
      'reste de la prose.',
    example: "J'ai déjà traité ce point ?",
  },
  {
    pattern: rx(`\\b(?:est-ce que )?je (?:ne )?me repete\\b|\\b(?:suis-je|je suis) en train de me repeter\\b`),
    why:
      '« est-ce que je me répète », « je me répète sur ce point ? », « suis-je en train de me répéter » : ' +
      "la répétition se vérifie dans le manuscrit, pas dans les sources.",
    example: 'Est-ce que je me répète ?',
  },
];

/* -------------------------------------------------------------------------- */
/* Anglais                                                                     */
/* -------------------------------------------------------------------------- */

/** Formes passées (prétérit, participe) des verbes de rappel. */
const EN_PAST =
  '(?:written|wrote|said|covered|mentioned|discussed|argued|addressed|dealt with|' +
  'talked about|noted|claimed|cited|developed|treated|described|shown|showed|' +
  'explained|stated|touched on|brought up|raised|examined|analysed|analyzed|' +
  'defined|introduced|established|put forward)\\b';
/** Formes de base, après « did I » / « do I ». */
const EN_BASE =
  '(?:write|say|cover|mention|discuss|argue|address|deal with|talk about|note|' +
  'claim|cite|develop|treat|describe|show|explain|state|touch on|bring up|raise|' +
  'examine|analyse|analyze|define|introduce|establish|put forward)\\b';
/** Adverbes admis entre le sujet et le verbe. */
const EN_ADV = '(?:(?:already|previously|ever|actually|even|also|somewhere|anywhere|explicitly|really) )*';

export const EN_RECALL_PATTERNS: readonly RecallPattern[] = [
  {
    pattern: rx(`\\b(?:have|had|did|do)(?:n't)? i ${EN_ADV}(?:${EN_PAST}|${EN_BASE})`),
    why:
      'Inversion with a first-person auxiliary: « what have I written », « did I mention », ' +
      '« where did I discuss », « haven\'t I already covered ». « do I need to cite » fails on the verb; ' +
      '« what has been written » has no first person.',
    example: 'What have I already written about Danzig?',
  },
  {
    pattern: rx(
      `\\b(?:what|where|whether|if|everything|anything|all|something) (?:that )?i(?:'ve| have|'d| had)? ${EN_ADV}${EN_PAST}`
    ),
    why:
      'Nominal or locative relative, past forms only: « what I\'ve written about », « check whether I ' +
      'already mentioned », « the passages where I discussed ». « if I write about » (base form) is a plan, ' +
      'not a recall, and is left out.',
    example: "Show me what I've written about the League.",
  },
  {
    pattern: rx(`\\bi(?:'ve| have|'d| had) (?:already|previously) ${EN_PAST}[^.?!]*\\?`),
    why:
      'Declarative question: « I\'ve already covered this somewhere? ». Needs the recall adverb AND a ' +
      'question mark in the same sentence, so pasted prose stays prose.',
    example: "I've already covered the 1933 crisis somewhere?",
  },
  {
    pattern: rx(`\\bam i (?:just )?repeating myself\\b|\\bdo i repeat myself\\b|\\bhave i repeated myself\\b|\\bam i being repetitive\\b`),
    why: 'Repetition is checked against the manuscript, not the sources.',
    example: 'Am I repeating myself?',
  },
];

/* -------------------------------------------------------------------------- */
/* Allemand                                                                    */
/* -------------------------------------------------------------------------- */

/** Participes passés des verbes de rappel (umlauts déjà retirés). */
const DE_PP =
  '(?:geschrieben|gesagt|behandelt|erwahnt|angesprochen|besprochen|diskutiert|' +
  'zitiert|dargelegt|ausgefuhrt|entwickelt|beschrieben|gezeigt|erklart|erlautert|' +
  'festgehalten|argumentiert|thematisiert|notiert|formuliert|untersucht|' +
  'analysiert|erortert|angefuhrt|wiederholt)\\b';
/**
 * En allemand l'objet se glisse entre l'auxiliaire et le participe (« habe ich
 * das Thema bereits behandelt »). On tolère une fenêtre courte, sans
 * ponctuation de phrase, plutôt qu'une liste d'adverbes.
 */
const DE_GAP = '[^.?!;:]{0,60}?';

export const DE_RECALL_PATTERNS: readonly RecallPattern[] = [
  {
    pattern: rx(`\\bha(?:be|tte) ich\\b${DE_GAP}\\b${DE_PP}`),
    why:
      'Inversion mit Auxiliar in der ersten Person: « was habe ich über Danzig geschrieben », ' +
      '« habe ich das Thema bereits behandelt », « wo hatte ich Lester erwähnt ». ' +
      '« habe ich das richtig verstanden » scheitert am Partizip; « welche Quellen behandeln » hat kein « habe ich ».',
    example: 'Was habe ich schon über Danzig geschrieben?',
  },
  {
    pattern: rx(`\\b(?:was|wo|ob|wie) ich\\b${DE_GAP}\\b${DE_PP} ha(?:be|tte)\\b`),
    why:
      'Nebensatz mit Auxiliar am Ende: « was ich über Danzig geschrieben habe », « ob ich Lester ' +
      'irgendwo erwähnt habe ». Das Präsens (« was ich über Danzig schreibe ») bleibt außen vor.',
    example: 'Zeig mir, was ich über Danzig geschrieben habe.',
  },
  {
    pattern: rx(`\\bwiederhole ich mich\\b|\\bob ich mich (?:hier |da |nicht |schon |bereits )*wiederhole\\b`),
    why: 'Wiederholung prüft man am Manuskript, nicht an den Quellen.',
    example: 'Wiederhole ich mich?',
  },
];

/* -------------------------------------------------------------------------- */
/* Détecteur                                                                   */
/* -------------------------------------------------------------------------- */

/** Toutes les tables, par langue ; l'ordre est celui de la recherche. */
export const RECALL_PATTERNS: Readonly<Record<IntentLanguage, readonly RecallPattern[]>> = {
  fr: FR_RECALL_PATTERNS,
  en: EN_RECALL_PATTERNS,
  de: DE_RECALL_PATTERNS,
};

/**
 * L'utilisateur demande-t-il ce qu'il a déjà écrit dans son manuscrit ?
 *
 * Pur, déterministe, sans E/S. Renvoie le premier fragment reconnu dans le
 * texte normalisé — c'est ce que le journal enregistre.
 */
export function detectManuscriptIntent(text: string): ManuscriptIntentResult {
  const normalised = normaliseForIntent(text);
  if (normalised.length === 0) {
    return { intent: false };
  }
  for (const table of Object.values(RECALL_PATTERNS)) {
    for (const { pattern } of table) {
      const found = pattern.exec(normalised);
      if (found !== null && found[0].length > 0) {
        return { intent: true, match: found[0] };
      }
    }
  }
  return { intent: false };
}
