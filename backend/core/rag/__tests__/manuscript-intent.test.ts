/**
 * Intention de rappel (palier 2 de `docs/poids-du-manuscrit.md`).
 *
 * Deux listes fixent le contrat : les questions qui DOIVENT rouvrir le
 * manuscrit, et celles qui ne doivent surtout pas — un possessif nu, un
 * titre de chapitre, une question sur les sources, un paragraphe collé. Le
 * reste vérifie les propriétés dont le code appelant dépend : pureté,
 * idempotence de la normalisation, `match` tiré du texte normalisé, et une
 * table de motifs dont chaque entrée est documentée et se déclenche sur son
 * propre exemple.
 */
import { describe, expect, it } from 'vitest';
import {
  DE_RECALL_PATTERNS,
  detectManuscriptIntent,
  EN_RECALL_PATTERNS,
  FR_RECALL_PATTERNS,
  normaliseForIntent,
  RECALL_PATTERNS,
} from '../manuscript-intent.js';

/** Questions de rappel explicites : le manuscrit doit revenir. */
const RECALL_QUESTIONS: readonly string[] = [
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

describe('normaliseForIntent', () => {
  it('replie casse, accents, apostrophes typographiques et blancs', () => {
    expect(normaliseForIntent('  Qu’ai-je   DÉJÀ\n écrit ?')).toBe("qu'ai-je deja ecrit ?");
    expect(normaliseForIntent('über Danzig')).toBe('uber danzig');
    expect(normaliseForIntent('groß œuvre')).toBe('gross oeuvre');
  });

  it('est idempotente', () => {
    for (const text of [...RECALL_QUESTIONS, ...OTHER_QUESTIONS]) {
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
    for (const text of [...RECALL_QUESTIONS, ...OTHER_QUESTIONS]) {
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
});

describe('les tables de motifs', () => {
  it('couvrent les trois langues, dans cet ordre', () => {
    expect(Object.keys(RECALL_PATTERNS)).toEqual(['fr', 'en', 'de']);
    expect(RECALL_PATTERNS.fr).toBe(FR_RECALL_PATTERNS);
    expect(RECALL_PATTERNS.en).toBe(EN_RECALL_PATTERNS);
    expect(RECALL_PATTERNS.de).toBe(DE_RECALL_PATTERNS);
  });

  const entries = Object.entries(RECALL_PATTERNS).flatMap(([language, table]) =>
    table.map((entry, index) => ({ language, index, ...entry }))
  );

  it.each(entries)('$language[$index] est documenté et sans drapeau g', ({ pattern, why, example }) => {
    expect(why.trim().length).toBeGreaterThan(0);
    expect(example.trim().length).toBeGreaterThan(0);
    expect(pattern.global).toBe(false);
  });

  it.each(entries)('$language[$index] se déclenche sur son propre exemple', ({ pattern, example }) => {
    const normalised = normaliseForIntent(example);
    expect(pattern.test(normalised)).toBe(true);
    const result = detectManuscriptIntent(example);
    expect(result.intent).toBe(true);
    expect(normalised).toContain(result.match);
  });

  it('aucun motif ne se déclenche sur les questions à laisser passer', () => {
    for (const text of OTHER_QUESTIONS) {
      const normalised = normaliseForIntent(text);
      for (const { pattern } of entries) {
        expect(pattern.test(normalised), `${pattern.source} sur « ${text} »`).toBe(false);
      }
    }
  });
});
