/**
 * Intentions de rappel (palier 2 de `docs/poids-du-manuscrit.md`, puis
 * « Au-delà du manuscrit » pour les notes de lecture).
 *
 * Deux détecteurs, et pour chacun deux listes qui fixent le contrat : les
 * questions qui DOIVENT rouvrir son corpus, et celles qui ne doivent surtout
 * pas — un possessif nu, un titre de chapitre, une question sur les sources,
 * un paragraphe collé, un impératif (« prends note »), les notes Zotero d'une
 * notice. Les listes se croisent : chaque détecteur est muet sur les positifs
 * de l'autre. Le reste vérifie les propriétés dont le code appelant dépend :
 * pureté, idempotence de la normalisation, `match` tiré du texte normalisé, et
 * des tables de motifs dont chaque entrée est documentée et se déclenche sur
 * son propre exemple.
 *
 * 2026-10-28 — « noté » / « noted » / « notiert » ont quitté les tables du
 * manuscrit pour celles des notes. Aucune question de rappel du manuscrit ne
 * reposait sur eux : `RECALL_QUESTIONS` est inchangée.
 */
import { describe, expect, it } from 'vitest';
import {
  DE_NOTES_RECALL_PATTERNS,
  DE_RECALL_PATTERNS,
  detectManuscriptIntent,
  detectReadingNotesIntent,
  EN_NOTES_RECALL_PATTERNS,
  EN_RECALL_PATTERNS,
  FR_NOTES_RECALL_PATTERNS,
  FR_RECALL_PATTERNS,
  type IntentLanguage,
  normaliseForIntent,
  NOTES_ANCHOR,
  NOTES_RECALL_PATTERNS,
  RECALL_PATTERNS,
  type RecallPattern,
} from '../manuscript-intent.js';

/** Questions de rappel explicites : le manuscrit doit revenir. */
const RECALL_QUESTIONS: readonly string[] = [
  'Do I already mention Lester anywhere?',
  'Check whether I already mentioned the harbour.',
  "See if I've covered the 1933 crisis.",
  // Français — exigées par le cahier des charges
  "qu'ai-je déjà écrit sur Danzig ?",
  'Qu’ai-je écrit à propos de Memel',
  'ai-je déjà traité ce point ?',
  "est-ce que j'ai déjà abordé la question du port ?",
  "ce que j'ai écrit sur la Société des Nations",
  'où ai-je parlé de Lester ?',
  'est-ce que je me répète ?',
  'je me répète sur ce point ?',
  'dans mon manuscrit, ai-je déjà cité Braudel ?',
  "ai-je déjà développé l'idée de la frontière ?",
  // Français — variantes de forme
  'qu ai-je déjà écrit sur Danzig ?',
  'QU’AI-JE DÉJÀ ÉCRIT SUR DANZIG ?',
  "n'ai-je pas déjà traité la question du port ?",
  "l'ai-je déjà dit quelque part ?",
  'avais-je déjà mentionné Lester ?',
  "qu'est-ce que j'ai dit de la crise de 1933 ?",
  "relis ce que j'ai dit de Lester",
  "retrouve les passages où j'ai traité de la frontière",
  "j'ai déjà traité ce point ?",
  'suis-je en train de me répéter ?',
  // Anglais — exigées
  'what have I already written about Danzig?',
  'what did I write about the League?',
  'have I already covered the 1933 crisis?',
  'did I already mention Lester anywhere?',
  'where did I discuss the harbour?',
  'am I repeating myself?',
  // Anglais — variantes
  "haven't I already covered the harbour?",
  "show me what I've written about the League",
  'check whether I already mentioned Lester',
  "I've already covered the 1933 crisis somewhere?",
  'do I mention Lester anywhere?',
  // Allemand — exigées
  'was habe ich schon über Danzig geschrieben?',
  'habe ich das Thema bereits behandelt?',
  'wo habe ich Lester erwähnt?',
  'wiederhole ich mich?',
  // Allemand — variantes
  'wo hatte ich Lester erwähnt?',
  'zeig mir, was ich über Danzig geschrieben habe',
  'ob ich Lester irgendwo erwähnt habe',
  'habe ich mich hier wiederholt?',
];

/** Un paragraphe collé par l'auteur : de la prose, pas une question. */
const PASTED_PROSE =
  'Nous avons montré que le port de Danzig fut, dès 1920, un enjeu de souveraineté ' +
  'entre la Ville libre et la Pologne. Les archives du Haut-Commissariat conservent ' +
  'la correspondance de Lester, dont nous avons tiré la chronologie de la crise de 1933. ' +
  'Nous avons enfin établi que la Société des Nations ne disposait, sur place, ' +
  "d'aucun moyen de coercition.";

/** Questions qui ne portent PAS sur ce que l'auteur a déjà écrit. */
const OTHER_QUESTIONS: readonly string[] = [
  // Revue 2026-10-28 : « do I » + verbe et « if I » + prétérit tiraient le
  // manuscrit dans des questions de méthode ou des hypothèses.
  'How do I cite an archival document in Chicago style?',
  'Where do I state my hypothesis in an article?',
  'What if I argued that the League was powerless in Danzig?',
  'Do I need to cite the archival reference?',
  'Habe ich richtig verstanden, dass Lester das Thema behandelt?',
  'Habe ich Zugang zu den Quellen, die Lester zitiert?',
  // Exigées par le cahier des charges
  'propose des angles pour mon chapitre sur Danzig',
  "dans mon article, je cite Braudel ; que dit-il de la longue durée ?",
  "qu'est-ce qui manque dans mon chapitre sur Danzig ?",
  "l'auteur a écrit que la Société des Nations…",
  'que dit Lester de la crise de 1933 ?',
  'résume ce que les sources disent du port',
  'give me ideas for my chapter on Danzig',
  'what does Lester say about 1933?',
  'what has been written about Danzig?',
  'summarise what the sources say',
  'welche Quellen behandeln Danzig?',
  'schreibe einen Absatz über Danzig',
  '',
  PASTED_PROSE,
  // Possessif nu, titre de chapitre, planification, compréhension
  'mon manuscrit',
  'Chapitre 3 — Danzig, le port et la Société des Nations',
  'reprends mon chapitre « Le port et la frontière » et propose un plan',
  'ai-je raison de penser que Lester a écrit à Genève ?',
  'où en suis-je dans mon chapitre ?',
  "j'ai montré au chapitre 2 que le port était un enjeu de souveraineté.",
  'should I write about Danzig?',
  'do I need to cite Braudel here?',
  'if I write about Danzig, which sources should I use?',
  'what sources do I have on Danzig?',
  'habe ich das richtig verstanden?',
  'welche Quellen habe ich zu Danzig?',
  'ich habe eine Frage zu Danzig',
  '   \n\t  ',
];

/** Questions de rappel des notes de lecture : la bande des notes doit se lever. */
const NOTES_RECALL_QUESTIONS: readonly string[] = [
  // Revue 2026-10-28 : les points d'abréviation et de nombre ne ferment pas une phrase.
  'Dans mes notes de lecture, cf. p. 3, ai-je cité Lester ?',
  'Was habe ich zum 19. Jahrhundert notiert?',
  // Français — exigées par le cahier des charges
  "qu'ai-je noté sur Braudel ?",
  'Qu’avais-je noté à propos de la Méditerranée ?',
  'dans mes notes de lecture, est-ce que je parle de Lester ?',
  'que disent mes notes sur Braudel ?',
  'ai-je pris des notes sur cet article ?',
  "qu'est-ce que j'ai noté sur la crise de 1933 ?",
  // Français — variantes de forme
  'QU’AI-JE NOTÉ SUR BRAUDEL ?',
  'qu ai-je noté sur Braudel ?',
  'où ai-je noté la date du traité ?',
  "n'ai-je pas déjà noté cette référence ?",
  "ce que j'ai noté sur Braudel",
  "j'ai déjà pris des notes sur cet article ?",
  'ai-je pris note de cet article ?',
  "est-ce que j'ai déjà consigné cette référence ?",
  'que contiennent mes fiches de lecture sur Braudel ?',
  'mes notes de lecture parlent-elles de Lester ?',
  'ai-je cité Lester dans mes notes ?',
  'y a-t-il quelque chose sur Lester dans mes notes ?',
  "qu'y a-t-il dans mes notes sur Braudel ?",
  // Le lieu l'emporte sur le verbe : une question d'écriture posée « dans mes notes » porte sur les notes.
  "dans mes notes, qu'ai-je écrit sur Braudel ?",
  // Anglais — exigées
  'where in my notes do I mention Lester?',
  'what did I note about Braudel?',
  'what do my notes say about the League?',
  'in my reading notes, did I mention Lester?',
  'did I take notes on this article?',
  'what have I noted on Danzig?',
  // Anglais — variantes
  'have I taken notes on this article?',
  'do I have any notes on this article?',
  "show me everything I've noted about the League",
  'check whether I already took notes on this article',
  "see if I've jotted down anything on Danzig",
  "I've already taken notes on this article somewhere?",
  'is there anything in my notes about Braudel?',
  "what's in my notes about Danzig?",
  'did I mention Lester in my notes?',
  'have I cited Braudel in my reading notes?',
  'what did I jot down about the League?',
  'where did I note the date of the treaty?',
  'what do my reading notes say about Lester?',
  'did I make a note of this reference?',
  // Allemand — exigées
  'was habe ich zu Braudel notiert?',
  'was steht in meinen Notizen zu Danzig?',
  'habe ich mir zu diesem Aufsatz Notizen gemacht?',
  // Allemand — variantes
  'wo habe ich das notiert?',
  'zeig mir, was ich zu Braudel notiert habe',
  'ob ich mir zu Lester Notizen gemacht habe',
  'was habe ich mir dazu aufgeschrieben?',
  'habe ich Lester in meinen Notizen erwähnt?',
  'gibt es in meinen Notizen etwas zu Lester?',
  'was sagen meine Notizen zu Braudel?',
  'was steht in meinen Exzerpten zu Danzig?',
  'hatte ich diesen Aufsatz exzerpiert?',
];

/**
 * Ni les notes ni le manuscrit : « note » sans première personne, impératifs,
 * requêtes (« take notes for me »), notes Zotero d'une notice, questions de
 * méthode ou de rangement sur ses propres notes.
 */
const NOTES_OTHER_QUESTIONS: readonly string[] = [
  // Revue 2026-10-28 : « do I » + verbe quelconque devant « in my notes » n'est pas un rappel.
  'Where do I put this in my notes?',
  'Where do I find the quotation in my notes?',
  // Exigées par le cahier des charges
  'note that Braudel wrote in 1949',
  'a noted historian of the Mediterranean',
  'prends note de cette référence',
  'what did Braudel note about the Mediterranean?',
  'résume les notes Zotero de cette notice',
  'take notes on this article for me',
  'notez que la Société des Nations…',
  '',
  PASTED_PROSE,
  // Variantes : incise de précaution, méthode, rangement, accès
  "si j'ai bien noté, Braudel date la crise de 1933",
  'range mes notes de lecture par auteur',
  'est-ce que je peux chercher dans mes notes ?',
  'how do I search in my notes?',
  'is there a way to export my notes?',
  'put this reference in my notes',
  'wie suche ich in meinen Notizen?',
  'Habe ich Zugang zu meinen Notizen?',
];

/**
 * Les notes de bas de page sont le manuscrit, pas les notes de lecture : le
 * détecteur des notes se tait, celui du manuscrit est libre d'y répondre.
 */
const FOOTNOTE_QUESTIONS: readonly string[] = [
  'dans mes notes de bas de page, ai-je cité Lester ?',
  'have I cited Lester in my footnotes?',
  'habe ich Lester in meinen Fußnoten erwähnt?',
];

const ALL_TEXTS: readonly string[] = [
  ...RECALL_QUESTIONS,
  ...OTHER_QUESTIONS,
  ...NOTES_RECALL_QUESTIONS,
  ...NOTES_OTHER_QUESTIONS,
  ...FOOTNOTE_QUESTIONS,
];

type Detector = (text: string) => ReturnType<typeof detectManuscriptIntent>;

function tableEntries(tables: Readonly<Record<IntentLanguage, readonly RecallPattern[]>>) {
  return Object.entries(tables).flatMap(([language, table]) =>
    table.map((entry, index) => ({ language, index, ...entry }))
  );
}

describe('normaliseForIntent', () => {
  it('replie casse, accents, apostrophes typographiques et blancs', () => {
    expect(normaliseForIntent('  Qu’ai-je   DÉJÀ\n écrit ?')).toBe("qu'ai-je deja ecrit ?");
    expect(normaliseForIntent('über Danzig')).toBe('uber danzig');
    expect(normaliseForIntent('groß œuvre')).toBe('gross oeuvre');
  });

  it('est idempotente', () => {
    for (const text of ALL_TEXTS) {
      const once = normaliseForIntent(text);
      expect(normaliseForIntent(once)).toBe(once);
    }
  });
});

describe('detectManuscriptIntent', () => {
  it.each(RECALL_QUESTIONS)('reconnaît une question de rappel : %s', (text) => {
    expect(detectManuscriptIntent(text).intent).toBe(true);
  });

  it.each(OTHER_QUESTIONS)('laisse passer une question sur les sources : %j', (text) => {
    expect(detectManuscriptIntent(text)).toEqual({ intent: false });
  });

  it("n'ajoute pas de clé `match` quand l'intention est absente", () => {
    expect('match' in detectManuscriptIntent('que dit Lester ?')).toBe(false);
    expect(detectManuscriptIntent('')).toEqual({ intent: false });
  });

  it('renvoie un fragment non vide du texte normalisé', () => {
    for (const text of RECALL_QUESTIONS) {
      const result = detectManuscriptIntent(text);
      expect(result.intent).toBe(true);
      expect(result.match).toBeTypeOf('string');
      expect(result.match?.length).toBeGreaterThan(0);
      expect(normaliseForIntent(text)).toContain(result.match);
    }
  });

  it('donne le même résultat sur un texte déjà normalisé', () => {
    for (const text of ALL_TEXTS) {
      expect(detectManuscriptIntent(normaliseForIntent(text))).toEqual(
        detectManuscriptIntent(text)
      );
    }
  });

  it('est déterministe : deux appels successifs, même réponse', () => {
    // Un drapeau `g` oublié ferait alterner le résultat via `lastIndex`.
    for (const text of RECALL_QUESTIONS) {
      const first = detectManuscriptIntent(text);
      const second = detectManuscriptIntent(text);
      expect(second).toEqual(first);
    }
  });

  it('ne se laisse pas prendre par un rappel noyé dans une autre phrase', () => {
    // Le point final coupe la fenêtre de la déclarative interrogative.
    expect(
      detectManuscriptIntent("J'ai déjà montré que le port était un enjeu. Que dit Lester ?").intent
    ).toBe(false);
    expect(
      detectManuscriptIntent("I've already shown that the port mattered. What does Lester say?").intent
    ).toBe(false);
  });

  it.each(NOTES_OTHER_QUESTIONS)('laisse passer une question qui n’est à personne : %j', (text) => {
    expect(detectManuscriptIntent(text)).toEqual({ intent: false });
  });

  it.each(FOOTNOTE_QUESTIONS)('les notes de bas de page sont le manuscrit : %s', (text) => {
    expect(detectManuscriptIntent(text).intent).toBe(true);
  });
});

describe('detectReadingNotesIntent', () => {
  it.each(NOTES_RECALL_QUESTIONS)('reconnaît une question sur ses notes : %s', (text) => {
    expect(detectReadingNotesIntent(text).intent).toBe(true);
  });

  it.each([...NOTES_OTHER_QUESTIONS, ...OTHER_QUESTIONS, ...FOOTNOTE_QUESTIONS])(
    'laisse passer tout le reste : %j',
    (text) => {
      expect(detectReadingNotesIntent(text)).toEqual({ intent: false });
    }
  );

  it("n'ajoute pas de clé `match` quand l'intention est absente", () => {
    expect('match' in detectReadingNotesIntent('que dit Lester ?')).toBe(false);
    expect(detectReadingNotesIntent('')).toEqual({ intent: false });
    expect(detectReadingNotesIntent('   \n\t  ')).toEqual({ intent: false });
  });

  it('renvoie un fragment non vide du texte normalisé', () => {
    for (const text of NOTES_RECALL_QUESTIONS) {
      const result = detectReadingNotesIntent(text);
      expect(result.intent).toBe(true);
      expect(result.match).toBeTypeOf('string');
      expect(result.match?.length).toBeGreaterThan(0);
      expect(normaliseForIntent(text)).toContain(result.match);
    }
  });

  it('donne le même résultat sur un texte déjà normalisé', () => {
    for (const text of ALL_TEXTS) {
      expect(detectReadingNotesIntent(normaliseForIntent(text))).toEqual(
        detectReadingNotesIntent(text)
      );
    }
  });

  it('est déterministe : deux appels successifs, même réponse', () => {
    for (const text of NOTES_RECALL_QUESTIONS) {
      const first = detectReadingNotesIntent(text);
      const second = detectReadingNotesIntent(text);
      expect(second).toEqual(first);
    }
  });

  it('ne se laisse pas prendre par un rappel noyé dans une autre phrase', () => {
    expect(
      detectReadingNotesIntent("J'ai déjà pris des notes sur cet article. Que dit Lester ?").intent
    ).toBe(false);
    expect(
      detectReadingNotesIntent("I've already taken notes on this. What does Lester say?").intent
    ).toBe(false);
  });
});

describe('les deux détecteurs ne se déclenchent pas sur la même phrase', () => {
  it.each(NOTES_RECALL_QUESTIONS)('le manuscrit se tait sur une question de notes : %s', (text) => {
    expect(detectManuscriptIntent(text)).toEqual({ intent: false });
  });

  it.each(RECALL_QUESTIONS)('les notes se taisent sur une question de manuscrit : %s', (text) => {
    expect(detectReadingNotesIntent(text)).toEqual({ intent: false });
  });

  it.each([
    "qu'ai-je noté sur Braudel ?",
    'what have I noted on Danzig?',
    'was habe ich zu Braudel notiert?',
  ])('« noté / noted / notiert » appartient aux notes, plus au manuscrit : %s', (text) => {
    expect(detectManuscriptIntent(text)).toEqual({ intent: false });
    expect(detectReadingNotesIntent(text).intent).toBe(true);
  });

  it('la garde du manuscrit joue à la phrase, pas au message', () => {
    // Phrase 1 nomme les notes : elle revient aux notes, même avec « did I mention ».
    // Phrase 2 est une question de manuscrit ordinaire : elle garde sa réponse.
    const text = 'In my notes, did I mention Lester? And have I already covered him in the chapter?';
    expect(detectReadingNotesIntent(text).intent).toBe(true);
    expect(detectManuscriptIntent(text)).toEqual({ intent: true, match: 'have i already covered' });
  });

  it('un verbe d’écriture posé « dans mes notes » revient aux notes', () => {
    for (const text of [
      "dans mes notes, qu'ai-je écrit sur Braudel ?",
      'have I cited Braudel in my reading notes?',
      'habe ich Lester in meinen Notizen erwähnt?',
    ]) {
      expect(detectReadingNotesIntent(text).intent, text).toBe(true);
      expect(detectManuscriptIntent(text), text).toEqual({ intent: false });
    }
  });
});

describe('NOTES_ANCHOR', () => {
  it('est sans drapeau g', () => {
    expect(NOTES_ANCHOR.global).toBe(false);
  });

  it.each([
    'dans mes notes',
    'mes notes de lecture',
    'mes fiches de lecture',
    'ma note de lecture sur Braudel',
    'in my notes',
    'my reading notes',
    'my reading note on Braudel',
    'in meinen Notizen',
    'meine Lesenotizen',
    'meine Exzerpte',
  ])('désigne les notes de lecture de l’auteur : %s', (text) => {
    expect(NOTES_ANCHOR.test(normaliseForIntent(text))).toBe(true);
  });

  it.each([
    'mes notes de bas de page',
    'mes notes de fin',
    'mes notes infrapaginales',
    'ma note',
    'les notes Zotero',
    'my footnotes',
    'my endnotes',
    'his notes',
    'meine Fußnoten',
    'meine Anmerkungen',
    'seine Notizen',
  ])('ne désigne pas les notes de lecture : %s', (text) => {
    expect(NOTES_ANCHOR.test(normaliseForIntent(text))).toBe(false);
  });
});

describe.each<{
  name: string;
  tables: Readonly<Record<IntentLanguage, readonly RecallPattern[]>>;
  perLanguage: readonly (readonly RecallPattern[])[];
  detect: Detector;
  /** Aucun motif de ces tables ne doit s'y déclencher, même isolément. */
  negatives: readonly string[];
}>([
  {
    name: 'manuscrit',
    tables: RECALL_PATTERNS,
    perLanguage: [FR_RECALL_PATTERNS, EN_RECALL_PATTERNS, DE_RECALL_PATTERNS],
    detect: detectManuscriptIntent,
    // Les positifs des notes n'y sont pas : « in my reading notes, did I mention Lester? »
    // contient bien « did I mention », c'est la garde `NOTES_ANCHOR` du détecteur qui
    // rend la phrase aux notes, pas les motifs. Le croisement est testé au niveau du détecteur.
    negatives: [...OTHER_QUESTIONS, ...NOTES_OTHER_QUESTIONS],
  },
  {
    name: 'notes de lecture',
    tables: NOTES_RECALL_PATTERNS,
    perLanguage: [FR_NOTES_RECALL_PATTERNS, EN_NOTES_RECALL_PATTERNS, DE_NOTES_RECALL_PATTERNS],
    detect: detectReadingNotesIntent,
    negatives: [...OTHER_QUESTIONS, ...NOTES_OTHER_QUESTIONS, ...FOOTNOTE_QUESTIONS, ...RECALL_QUESTIONS],
  },
])('les tables de motifs — $name', ({ tables, perLanguage, detect, negatives }) => {
  it('couvrent les trois langues, dans cet ordre', () => {
    expect(Object.keys(tables)).toEqual(['fr', 'en', 'de']);
    expect(tables.fr).toBe(perLanguage[0]);
    expect(tables.en).toBe(perLanguage[1]);
    expect(tables.de).toBe(perLanguage[2]);
  });

  const entries = tableEntries(tables);

  it.each(entries)('$language[$index] est documenté et sans drapeau g', ({ pattern, why, example }) => {
    expect(why.trim().length).toBeGreaterThan(0);
    expect(example.trim().length).toBeGreaterThan(0);
    expect(pattern.global).toBe(false);
  });

  it.each(entries)('$language[$index] se déclenche sur son propre exemple', ({ pattern, example }) => {
    const normalised = normaliseForIntent(example);
    expect(pattern.test(normalised)).toBe(true);
    const result = detect(example);
    expect(result.intent).toBe(true);
    expect(normalised).toContain(result.match);
  });

  it('aucun motif ne se déclenche sur les questions à laisser passer', () => {
    for (const text of negatives) {
      const normalised = normaliseForIntent(text);
      for (const { pattern } of entries) {
        expect(pattern.test(normalised), `${pattern.source} sur « ${text} »`).toBe(false);
      }
    }
  });
});
