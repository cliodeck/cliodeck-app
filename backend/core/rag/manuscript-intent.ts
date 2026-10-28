/**
 * Intentions de rappel : l'utilisateur demande-t-il ce qu'IL a déjà écrit
 * dans SON manuscrit (palier 2 de `docs/poids-du-manuscrit.md`), ou ce qu'il
 * a consigné dans SES notes de lecture (« Au-delà du manuscrit ») ?
 *
 * Quand c'est le cas, la bande du corpus concerné s'élargit à `min(topK, 6)`
 * et ce corpus revient même dans l'espace Brainstorm, où il est absent par
 * défaut. Les détecteurs tournent côté main à chaque tour de chat : ils
 * doivent être purs, déterministes et bon marché — aucun modèle, aucune E/S.
 *
 * Deux détecteurs, deux familles de verbes. `detectManuscriptIntent` s'ancre
 * sur les verbes d'écriture (écrit / written / geschrieben…) ;
 * `detectReadingNotesIntent` sur les verbes de prise de notes (noté / noted /
 * notiert, « pris des notes ») et sur les constructions qui nomment les notes
 * de l'auteur (« mes notes (de lecture) », « my (reading) notes », « meine
 * Notizen »). Ils sont indépendants — mêmes briques, tables séparées — et ne
 * se déclenchent pas tous deux sur la même phrase : la PHRASE est l'unité
 * d'analyse, et le manuscrit se tait dans une phrase qui nomme les notes de
 * lecture (`NOTES_ANCHOR`) — « dans mes notes, ai-je cité Lester ? » porte sur
 * les notes, même avec un verbe d'écriture. Les notes de bas de page restent
 * le manuscrit : « mes notes de bas de page » n'est pas une ancre.
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
  /** Appliqué à chaque PHRASE du texte NORMALISÉ (voir `normaliseForIntent`). Sans drapeau `g`. */
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
  const collapsed = text
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(APOSTROPHES, "'")
    .replace(HYPHENS, '-')
    .replace(/\s+/g, ' ');
  return stripNonFinalPeriods(collapsed).trim();
}

/**
 * Points qui ne ferment pas une phrase : abréviations courantes des trois
 * langues (déjà sans accents), jetons d'une ou deux lettres (« p. », « t. »)
 * et nombres (« 19. Jahrhundert »). Laissés en place, ils coupaient « dans
 * mes notes, cf. p. 3, ai-je cité Lester ? » en fragments : le veto des
 * notes tombait dans l'un, le verbe dans l'autre, et les fenêtres `[^.?!]*`
 * des motifs s'arrêtaient au premier. Retirés à la normalisation, phrases et
 * fenêtres les traversent — au prix, rare, de deux phrases fondues quand
 * l'une finit par un nombre : la fusion n'ajoute qu'un veto, jamais un
 * rappel.
 */
const NON_FINAL_ABBREVIATIONS = new Set([
  'cf', 'pp', 'vol', 'vols', 'eds', 'chap', 'fol', 'art', 'ibid', 'cit', 'loc', 'sqq', 'env',
  'trad', 'dir', 'mss', 'fasc', 'hrsg', 'vgl', 'bzw', 'usw', 'ebd', 'etc', 'infra', 'supra',
]);

function stripNonFinalPeriods(text: string): string {
  return text.replace(/(^|\s)([([«"']*)([^\s.]+)\.(?=\s|$)/g, (whole, lead: string, open: string, token: string) => {
    const nonFinal =
      /^\d+$/.test(token) || token.length <= 2 || NON_FINAL_ABBREVIATIONS.has(token);
    return nonFinal ? `${lead}${open}${token}` : whole;
  });
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

/**
 * Participes passés des verbes de rappel ; l'accord (e, s, es) est admis.
 * « noté » n'y est pas : c'est un verbe de prise de notes (`FR_NOTE_PP`).
 */
const FR_PP =
  '(?:ecrit|redige|dit|traite|aborde|mentionne|evoque|cite|parle|developpe|' +
  'montre|demontre|explique|analyse|souligne|discute|avance|affirme|' +
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

/**
 * Formes passées (prétérit, participe) des verbes de rappel. « noted » n'y
 * est pas : c'est un verbe de prise de notes (`EN_NOTE_PAST`).
 */
const EN_PAST =
  '(?:written|wrote|said|covered|mentioned|discussed|argued|addressed|dealt with|' +
  'talked about|claimed|cited|developed|treated|described|shown|showed|' +
  'explained|stated|touched on|brought up|raised|examined|analysed|analyzed|' +
  'defined|introduced|established|put forward)\\b';
/** Formes de base, après « did I » / « do I » ; « note » est aux notes (`EN_NOTE_BASE`). */
const EN_BASE =
  '(?:write|say|cover|mention|discuss|argue|address|deal with|talk about|' +
  'claim|cite|develop|treat|describe|show|explain|state|touch on|bring up|raise|' +
  'examine|analyse|analyze|define|introduce|establish|put forward)\\b';
/** Adverbes admis entre le sujet et le verbe. */
const EN_ADV = '(?:(?:already|previously|ever|actually|even|also|somewhere|anywhere|explicitly|really) )*';

/** Adverbes qui font d'une question au présent une question de rappel. */
const EN_RECALL_ADV = '(?:already|previously|ever|somewhere|anywhere)';

export const EN_RECALL_PATTERNS: readonly RecallPattern[] = [
  {
    pattern: rx(`\\b(?:have|had|did)(?:n't)? i ${EN_ADV}(?:${EN_PAST}|${EN_BASE})`),
    why:
      'Inversion with a first-person PAST auxiliary: « what have I written », « did I mention », ' +
      '« where did I discuss », « haven\'t I already covered ». The present « do I » is deliberately ' +
      'absent here: « how do I cite », « where do I state my hypothesis » are how-to questions.',
    example: 'What have I already written about Danzig?',
  },
  {
    pattern: rx(
      `\\bdo(?:n't)? i (?:${EN_RECALL_ADV} (?:${EN_BASE}|${EN_PAST})|${EN_BASE}[^.?!]*\\b(?:already|somewhere|anywhere|previously|yet)\\b)`
    ),
    why:
      'The present auxiliary only with a recall adverb in the same clause, before or after the verb: ' +
      '« do I already mention Lester », « do I mention Lester anywhere ». Without it, « how do I cite », ' +
      '« where do I state my hypothesis » ask for advice, and « do I need to cite » fails on the verb.',
    example: 'Do I mention Lester anywhere?',
  },
  {
    pattern: rx(
      `\\b(?:what|where|everything|anything|all|something) (?:that )?i(?:'ve| have|'d| had)? ${EN_ADV}${EN_PAST}`
    ),
    why:
      'Nominal or locative relative, past forms only: « what I\'ve written about », « the passages ' +
      'where I discussed ». « if I write about » (base form) is a plan, and « what if I argued » ' +
      'is a hypothesis — neither starts with « what I » / « where I ».',
    example: "Show me what I've written about the League.",
  },
  {
    pattern: rx(
      `\\b(?:whether|if) i(?:(?:'ve| have|'d| had) ${EN_ADV}|(?: ${EN_RECALL_ADV})+ )${EN_PAST}`
    ),
    why:
      'Conditional or indirect: « check whether I\'ve covered », « see if I already mentioned ». ' +
      'Needs the perfect or a recall adverb: « what if I argued that… » is a hypothesis, not a recall.',
    example: 'Check whether I already mentioned the harbour.',
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

/**
 * Participes passés des verbes de rappel (umlauts déjà retirés). « notiert »
 * n'y est pas : c'est un verbe de prise de notes (`DE_NOTE_PP`).
 */
const DE_PP =
  '(?:geschrieben|gesagt|behandelt|erwahnt|angesprochen|besprochen|diskutiert|' +
  'zitiert|dargelegt|ausgefuhrt|entwickelt|beschrieben|gezeigt|erklart|erlautert|' +
  'festgehalten|argumentiert|thematisiert|formuliert|untersucht|' +
  'analysiert|erortert|angefuhrt|wiederholt)\\b';
/**
 * En allemand l'objet se glisse entre l'auxiliaire et le participe (« habe ich
 * das Thema bereits behandelt »). On tolère une fenêtre courte, sans
 * ponctuation de phrase NI virgule : une virgule ouvre une subordonnée, et
 * « habe ich richtig verstanden, dass Lester das Thema behandelt » n'est pas
 * une question de rappel même si « behandelt » clôt la phrase.
 */
const DE_GAP = '[^.?!;:,]{0,60}?';
/** Le participe clôt la proposition : rien d'autre qu'une ponctuation ou la fin. */
const DE_CLAUSE_END = '(?=\\s*(?:[?.!,;:]|$))';

export const DE_RECALL_PATTERNS: readonly RecallPattern[] = [
  {
    pattern: rx(`\\bha(?:be|tte) ich\\b${DE_GAP}\\b${DE_PP}${DE_CLAUSE_END}`),
    why:
      'Inversion mit Auxiliar in der ersten Person, Partizip am Satzende, keine Nebensatz-Kommas dazwischen: ' +
      '« was habe ich über Danzig geschrieben », « habe ich das Thema bereits behandelt », ' +
      '« wo hatte ich Lester erwähnt ». « Habe ich Zugang zu den Quellen, die Lester zitiert » ' +
      'scheitert am Komma; « welche Quellen behandeln » hat kein « habe ich ».',
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
/* Notes de lecture — ancres                                                   */
/* -------------------------------------------------------------------------- */

/**
 * « Mes notes (de lecture) », « mes fiches (de lecture) », « ma note de lecture
 * sur… ». Les notes de bas de page et de fin sont le manuscrit, pas les notes
 * de lecture : elles sont écartées par anticipation négative. Le singulier
 * « ma note » seul est ambigu (note de bas de page, note de service) et exige
 * « de lecture ».
 */
const FR_NOTES =
  '(?:mes (?:notes(?! (?:de bas de page|de fin|infrapaginales|en bas de page)\\b)(?: de lecture)?|' +
  'fiches(?: de lecture)?)|ma (?:note|fiche) de lecture)\\b';
/** « my notes », « my reading notes », « my reading note ». « my footnotes » is another word. */
const EN_NOTES = '(?:my (?:reading )?notes|my reading note)\\b';
/**
 * « meine / meinen / meiner (Lese)Notizen », « meine Exzerpte ». « Fußnoten »
 * und « Anmerkungen » (im Deutschen meist die Fußnoten) bleiben draußen.
 */
const DE_NOTES = '(?:meine[nr]? (?:(?:lese)?notizen|exzerpten?))\\b';

/**
 * Ce qui désigne les notes de lecture de l'auteur, toutes langues confondues.
 * Brique des motifs de notes — et garde du détecteur de manuscrit, qui se tait
 * dans une phrase où elle apparaît : « dans mes notes, ai-je cité Lester ? »
 * est une question sur les notes, pas sur le manuscrit.
 */
export const NOTES_ANCHOR: RegExp = rx(`\\b(?:${FR_NOTES}|${EN_NOTES}|${DE_NOTES})`);

/* -------------------------------------------------------------------------- */
/* Notes de lecture — français                                                 */
/* -------------------------------------------------------------------------- */

/** Participes des verbes de prise de notes ; l'accord (e, s, es) est admis. */
const FR_NOTE_PP = '(?:note|consigne)(?:e|s|es)?\\b';
/** « pris des notes », « pris note de », « pris en note ». */
const FR_PRIS_NOTES = 'pris (?:des |quelques |mes |en )?notes?\\b';
const FR_NOTE_V = `(?:${FR_NOTE_PP}|${FR_PRIS_NOTES})`;
/** Présent de la première personne : « je parle de », « je cite », « j'évoque », « je n'en parle ». */
const FR_JE_PRESENT =
  `(?:je (?:n${EL}|ne )?|j${EL})(?:en |y )?` +
  '(?:parle|cite|mentionne|evoque|aborde|traite|dis|discute|signale|note|releve)s?\\b';
/** Une interrogation à la première personne : inversion ou périphrase. */
const FR_Q = `(?:(?:ai|avais)[-\\s]je|est-ce que (?:${FR_J_AI}|${FR_JE_PRESENT}))`;

export const FR_NOTES_RECALL_PATTERNS: readonly RecallPattern[] = [
  {
    pattern: rx(`\\b(?:ai|avais)[-\\s]je (?:pas )?${FR_ADV}${FR_NOTE_V}`),
    why:
      "Inversion interrogative avec un verbe de prise de notes : « qu'ai-je noté sur », « où avais-je noté », " +
      "« ai-je pris des notes sur », « n'ai-je pas déjà pris note de ». « qu'ai-je écrit » est au manuscrit ; " +
      "« ai-je raison » n'a pas de verbe.",
    example: "Qu'ai-je noté sur Braudel ?",
  },
  {
    pattern: rx(`\\b(?:est-ce que|ce que|ou) ${FR_J_AI} (?:pas )?${FR_ADV}${FR_NOTE_V}`),
    why:
      "Périphrase et relative : « qu'est-ce que j'ai noté sur », « ce que j'ai consigné », « la fiche où j'ai " +
      "noté ». Pas de « si » : « si j'ai bien noté, Braudel… » est une incise de précaution, pas un rappel.",
    example: "Qu'est-ce que j'ai noté sur la crise de 1933 ?",
  },
  {
    pattern: rx(`\\b${FR_J_AI} (?:pas )?deja ${FR_NOTE_V}[^.?!]*\\?`),
    why:
      "Déclarative interrogative : « j'ai déjà pris des notes sur cet article ? ». « déjà » ET un point " +
      "d'interrogation dans la même phrase, comme pour le manuscrit.",
    example: "J'ai déjà pris des notes sur cet article ?",
  },
  {
    pattern: rx(
      `\\b(?:disent|contiennent|mentionnent|racontent) ${FR_NOTES}|` +
        `\\b${FR_NOTES} (?:disent|contiennent|mentionnent|parlent|evoquent|racontent)\\b`
    ),
    why:
      'Les notes comme sujet : « que disent mes notes sur », « que contiennent mes fiches de lecture », ' +
      "« mes notes parlent-elles de ». « range mes notes » n'a pas de verbe de contenu.",
    example: 'Que disent mes notes sur Braudel ?',
  },
  {
    pattern: rx(
      `\\b(?:dans|parmi|d${EL}apres|selon) ${FR_NOTES}[^.?!]*\\b${FR_Q}|` +
        `\\b${FR_Q}\\b[^.?!]*\\b(?:dans|parmi) ${FR_NOTES}|` +
        `\\b(?:qu${EL})?y a[-\\s]t[-\\s]il\\b[^.?!]*\\b(?:dans|parmi) ${FR_NOTES}`
    ),
    why:
      "Les notes comme lieu d'une question à la première personne, dans la même phrase et dans les deux ordres : " +
      '« dans mes notes de lecture, est-ce que je parle de », « ai-je cité Lester dans mes notes », ' +
      "« y a-t-il quelque chose dans mes notes sur ». Le verbe peut être d'écriture : le lieu l'emporte. " +
      "« est-ce que je peux chercher dans mes notes » n'a pas de verbe de rappel ; « dans mes notes de bas " +
      "de page » n'est pas une ancre.",
    example: 'Dans mes notes de lecture, est-ce que je parle de Lester ?',
  },
];

/* -------------------------------------------------------------------------- */
/* Notes de lecture — anglais                                                  */
/* -------------------------------------------------------------------------- */

/** The notes as an object: « notes », « any notes », « a note », « reading notes ». */
const EN_NOTES_NP = '(?:(?:any|some|a few|a|my|detailed) )?(?:reading )?notes?\\b';
/** Base forms, after « did I » / « have I ». */
const EN_NOTE_BASE = `(?:note(?: down)?|jot(?: down)?|(?:take|make|keep) (?:down )?${EN_NOTES_NP})\\b`;
/** Past forms (preterite, participle). */
const EN_NOTE_PAST = `(?:noted(?: down)?|jotted(?: down)?|(?:taken|took|made|kept) (?:down )?${EN_NOTES_NP})\\b`;
/** A first-person auxiliary that is not a how-to: « did I », « have I », never « how do I ». */
/**
 * A first-person question about the notes as a place. The PAST auxiliaries
 * take any verb (« have I cited Braudel in my notes »); the present « do I »
 * only a recall verb — « where do I put this in my notes » and « where do I
 * find X in my notes » are how-to questions, not recalls.
 */
const EN_AUX_I =
  `(?<!\\bhow )(?:(?:did|have|had)(?:n't)? i\\b|do(?:n't)? i ${EN_ADV}(?:${EN_BASE}|${EN_PAST}|${EN_NOTE_BASE}|${EN_NOTE_PAST}))`;

export const EN_NOTES_RECALL_PATTERNS: readonly RecallPattern[] = [
  {
    pattern: rx(`\\b(?:have|had|did)(?:n't)? i ${EN_ADV}(?:${EN_NOTE_PAST}|${EN_NOTE_BASE})`),
    why:
      'Inversion with a first-person past auxiliary and a note-taking verb: « what did I note about », ' +
      '« have I taken notes on », « did I make a note of », « what have I jotted down ». « did I write » ' +
      'belongs to the manuscript; « what did Braudel note » has no « I ».',
    example: 'What did I note about Braudel?',
  },
  {
    pattern: rx(`\\bdo(?:n't)? i ${EN_ADV}(?:have|keep) (?:any |some )?(?:reading )?notes\\b`),
    why:
      'The present only with the notes as possession: « do I have any notes on this article », ' +
      '« do I already keep notes on ». « do I need to cite » fails on the verb.',
    example: 'Do I have any notes on this article?',
  },
  {
    pattern: rx(
      `\\b(?:what|where|everything|anything|all|something) (?:that )?i(?:'ve| have|'d| had)? ${EN_ADV}${EN_NOTE_PAST}`
    ),
    why:
      'Nominal or locative relative, past forms only: « everything I\'ve noted about », « what I jotted ' +
      'down on ». « what I note here is » (present, declarative) stays out.',
    example: "Show me everything I've noted about the League.",
  },
  {
    pattern: rx(
      `\\b(?:whether|if) i(?:(?:'ve| have|'d| had) ${EN_ADV}|(?: ${EN_RECALL_ADV})+ )${EN_NOTE_PAST}`
    ),
    why:
      'Conditional or indirect: « check whether I already took notes on », « see if I\'ve jotted down ». ' +
      'Needs the perfect or a recall adverb: « if I take notes » is a plan.',
    example: 'Check whether I already took notes on this article.',
  },
  {
    pattern: rx(`\\bi(?:'ve| have|'d| had) (?:already|previously) ${EN_NOTE_PAST}[^.?!]*\\?`),
    why:
      'Declarative question: « I\'ve already taken notes on this somewhere? ». Needs the recall adverb AND ' +
      'a question mark in the same sentence, so pasted prose stays prose.',
    example: "I've already taken notes on this article somewhere?",
  },
  {
    pattern: rx(
      `\\b${EN_NOTES} (?:say|said|mention|contain|cover|record|include|tell)\\b|` +
        `\\bwhat(?:'s| is| was) in ${EN_NOTES}|` +
        `\\b(?:is|was) there (?:anything|something|nothing|any (?:note|mention)|a note)\\b[^.?!]*\\bin ${EN_NOTES}`
    ),
    why:
      'The notes as subject or container: « what do my notes say about », « what\'s in my notes about », ' +
      '« is there anything in my notes about ». « is there a way to export my notes » asks for a feature.',
    example: 'What do my notes say about the League?',
  },
  {
    pattern: rx(`\\b(?:in|from|according to|among) ${EN_NOTES}[^.?!]*\\b${EN_AUX_I}|\\b${EN_AUX_I}[^.?!]*\\bin ${EN_NOTES}`),
    why:
      'The notes as the place of a first-person question, same sentence, either order: « where in my notes ' +
      'do I mention Lester », « in my reading notes, did I mention », « have I cited Braudel in my notes ». ' +
      'The verb may be a writing verb: the place wins. « how do I search in my notes » is a how-to and is ' +
      'excluded by the « how » guard; « put this in my notes » has no first-person auxiliary.',
    example: 'Where in my notes do I mention Lester?',
  },
];

/* -------------------------------------------------------------------------- */
/* Notes de lecture — allemand                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Partizipien der Notizverben. « aufgeschrieben » gehört hierher, nicht zum
 * Manuskript: `\bgeschrieben\b` greift darin nicht (kein Wortrand nach « auf »).
 */
const DE_NOTE_PP =
  '(?:notiert|exzerpiert|aufgeschrieben|(?:notizen|exzerpte|eine notiz) (?:gemacht|angefertigt|angelegt))\\b';

export const DE_NOTES_RECALL_PATTERNS: readonly RecallPattern[] = [
  {
    pattern: rx(`\\bha(?:be|tte) ich\\b${DE_GAP}\\b${DE_NOTE_PP}${DE_CLAUSE_END}`),
    why:
      'Inversion mit Auxiliar in der ersten Person, Notizverb am Satzende: « was habe ich zu Braudel notiert », ' +
      '« habe ich mir zu diesem Aufsatz Notizen gemacht », « was hatte ich mir dazu aufgeschrieben ». ' +
      '« was habe ich über Danzig geschrieben » ist das Manuskript.',
    example: 'Was habe ich zu Braudel notiert?',
  },
  {
    pattern: rx(`\\b(?:was|wo|ob|wie) ich\\b${DE_GAP}\\b${DE_NOTE_PP} ha(?:be|tte)\\b`),
    why:
      'Nebensatz mit Auxiliar am Ende: « was ich zu Braudel notiert habe », « ob ich mir zu Lester Notizen ' +
      'gemacht habe ».',
    example: 'Zeig mir, was ich zu Braudel notiert habe.',
  },
  {
    pattern: rx(
      `\\bsteht in ${DE_NOTES}|\\b(?:sagen|besagen|enthalten|erwahnen) ${DE_NOTES}|` +
        `\\b${DE_NOTES} (?:sagen|besagen|enthalten|erwahnen)\\b|\\bgibt es\\b[^.?!]*\\bin ${DE_NOTES}`
    ),
    why:
      'Die Notizen als Subjekt oder Behälter: « was steht in meinen Notizen zu », « was sagen meine Notizen », ' +
      '« gibt es in meinen Notizen etwas zu ». « wie suche ich in meinen Notizen » fragt nach der Bedienung.',
    example: 'Was steht in meinen Notizen zu Danzig?',
  },
  {
    pattern: rx(`\\bin ${DE_NOTES}[^.?!]*\\bha(?:be|tte) ich\\b|\\bha(?:be|tte) ich\\b[^.?!]*\\bin ${DE_NOTES}`),
    why:
      'Die Notizen als Ort einer Frage in der ersten Person, gleicher Satz, beide Reihenfolgen: « habe ich ' +
      'Lester in meinen Notizen erwähnt ». Das Verb darf ein Schreibverb sein: der Ort gewinnt. « Habe ich ' +
      'Zugang zu meinen Notizen » hat kein « in ».',
    example: 'Habe ich Lester in meinen Notizen erwähnt?',
  },
];

/* -------------------------------------------------------------------------- */
/* Détecteurs                                                                  */
/* -------------------------------------------------------------------------- */

/** Toutes les tables du manuscrit, par langue ; l'ordre est celui de la recherche. */
export const RECALL_PATTERNS: Readonly<Record<IntentLanguage, readonly RecallPattern[]>> = {
  fr: FR_RECALL_PATTERNS,
  en: EN_RECALL_PATTERNS,
  de: DE_RECALL_PATTERNS,
};

/** Toutes les tables des notes de lecture, par langue ; même ordre. */
export const NOTES_RECALL_PATTERNS: Readonly<Record<IntentLanguage, readonly RecallPattern[]>> = {
  fr: FR_NOTES_RECALL_PATTERNS,
  en: EN_NOTES_RECALL_PATTERNS,
  de: DE_NOTES_RECALL_PATTERNS,
};

/**
 * Les phrases du texte normalisé, ponctuation forte comprise — c'est l'unité
 * sur laquelle les motifs s'appliquent et sur laquelle la garde du manuscrit
 * joue. Un point final coupe donc toujours une fenêtre, comme avant.
 */
/**
 * Les phrases du texte normalisé. Les points d'abréviation et de nombre ont
 * déjà disparu à la normalisation (`stripNonFinalPeriods`) : ici un point
 * ferme toujours une phrase.
 */
function sentencesOf(normalised: string): string[] {
  return normalised.match(/[^.?!]+[.?!]*/g) ?? [];
}

/**
 * Première phrase qu'un motif reconnaît, hors celles que `veto` écarte.
 * Renvoie le fragment reconnu — c'est ce que le journal enregistre.
 */
function detectRecall(
  normalised: string,
  tables: Readonly<Record<IntentLanguage, readonly RecallPattern[]>>,
  veto?: RegExp
): ManuscriptIntentResult {
  for (const sentence of sentencesOf(normalised)) {
    if (veto !== undefined && veto.test(sentence)) {
      continue;
    }
    for (const table of Object.values(tables)) {
      for (const { pattern } of table) {
        const found = pattern.exec(sentence);
        if (found !== null && found[0].length > 0) {
          return { intent: true, match: found[0] };
        }
      }
    }
  }
  return { intent: false };
}

/**
 * L'utilisateur demande-t-il ce qu'il a déjà écrit dans son manuscrit ?
 *
 * Pur, déterministe, sans E/S. Se tait dans une phrase qui nomme les notes de
 * lecture de l'auteur (`NOTES_ANCHOR`) : celle-là revient aux notes.
 */
export function detectManuscriptIntent(text: string): ManuscriptIntentResult {
  return detectRecall(normaliseForIntent(text), RECALL_PATTERNS, NOTES_ANCHOR);
}

/**
 * L'utilisateur demande-t-il ce qu'il a consigné dans ses notes de lecture ?
 *
 * Pur, déterministe, sans E/S. Même contrat que `detectManuscriptIntent` ;
 * les deux ne se déclenchent pas sur la même phrase.
 */
export function detectReadingNotesIntent(text: string): ManuscriptIntentResult {
  return detectRecall(normaliseForIntent(text), NOTES_RECALL_PATTERNS);
}
