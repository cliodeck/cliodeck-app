/**
 * Schémas des canaux fusion / slides / citations / sources (item 18).
 * Ces handlers passaient auparavant par des vérifications à la main, parfois
 * absentes : `chat:start` castait `messages` sans regarder sa forme, et
 * `slides:*` n'avait aucune validation.
 */
import { describe, expect, it } from 'vitest';
import {
  CitationFormatSchema,
  CitationPreviewSchema,
  FusionChatStartSchema,
  FusionMcpServerPatchSchema,
  FusionVaultIndexSchema,
  SlidesGenerateSchema,
  SlidesPreviewSchema,
  SourceOpenNoteSchema,
  SourceOpenPdfSchema,
  validate,
} from '../validation.js';

describe('FusionChatStartSchema', () => {
  it('accepte un tour de chat normal', () => {
    const parsed = validate(FusionChatStartSchema, {
      messages: [{ role: 'user', content: 'Bonjour' }],
      opts: {
        model: 'qwen3:8b',
        temperature: 0.7,
        retrievalOptions: { sourceType: 'primary', topK: 5 },
        systemPrompt: { modeId: 'primary-source-analyst' },
        enabledTools: ['zotero__search_zotero'],
      },
    });
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.opts?.retrievalOptions?.topK).toBe(5);
  });

  it('refuse des messages qui ne sont pas un tableau', () => {
    expect(() => validate(FusionChatStartSchema, { messages: 'coucou' })).toThrow(
      /Validation failed/
    );
  });

  it('refuse un message sans rôle valide — le cast masquait ce cas', () => {
    expect(() =>
      validate(FusionChatStartSchema, { messages: [{ role: 'pirate', content: 'x' }] })
    ).toThrow(/role/);
  });

  it('refuse un message dont le contenu n’est pas une chaîne', () => {
    expect(() =>
      validate(FusionChatStartSchema, { messages: [{ role: 'user', content: { a: 1 } }] })
    ).toThrow(/content/);
  });

  it('refuse un sourceType inconnu et un topK hors bornes', () => {
    expect(() =>
      validate(FusionChatStartSchema, {
        messages: [{ role: 'user', content: 'x' }],
        opts: { retrievalOptions: { sourceType: 'partout' } },
      })
    ).toThrow(/sourceType/);
    expect(() =>
      validate(FusionChatStartSchema, {
        messages: [{ role: 'user', content: 'x' }],
        opts: { retrievalOptions: { topK: 9999 } },
      })
    ).toThrow(/topK/);
  });

  it('refuse une liste de messages vide', () => {
    expect(() => validate(FusionChatStartSchema, { messages: [] })).toThrow(/empty/);
  });
});

describe('Slides', () => {
  it('accepte une génération bien formée', () => {
    const p = validate(SlidesGenerateSchema, { text: 'Un document', language: 'fr' });
    expect(p.language).toBe('fr');
  });

  it('refuse un texte vide ou une langue manquante', () => {
    expect(() => validate(SlidesGenerateSchema, { text: '', language: 'fr' })).toThrow();
    expect(() => validate(SlidesGenerateSchema, { text: 'x' })).toThrow(/language/);
  });

  it('accepte un aperçu avec index de slide, refuse un index négatif', () => {
    expect(validate(SlidesPreviewSchema, { content: '# A', activeSlideIndex: 2 }).activeSlideIndex).toBe(2);
    expect(() => validate(SlidesPreviewSchema, { content: '# A', activeSlideIndex: -1 })).toThrow();
  });
});

describe('Citations', () => {
  it('accepte des items CSL et un style', () => {
    const p = validate(CitationFormatSchema, {
      items: [{ id: 'lester1932', type: 'book' }],
      styleId: 'chicago-note-bibliography',
    });
    expect(p.items).toHaveLength(1);
  });

  it('refuse des items qui ne sont pas des objets', () => {
    expect(() => validate(CitationFormatSchema, { items: ['pas-un-objet'], styleId: 'x' })).toThrow();
  });

  it('refuse un bibKey vide', () => {
    expect(() => validate(CitationPreviewSchema, { bibKey: '', styleId: 'x' })).toThrow(/bibKey/);
  });
});

describe('Sources et vault', () => {
  it('refuse un documentId vide au lieu de le coercer', () => {
    expect(() => validate(SourceOpenPdfSchema, { documentId: '' })).toThrow(/documentId/);
    expect(() => validate(SourceOpenPdfSchema, { documentId: 42 })).toThrow();
  });

  it('refuse un numéro de ligne non entier', () => {
    expect(() =>
      validate(SourceOpenNoteSchema, { relativePath: 'note.md', lineNumber: 1.5 })
    ).toThrow();
  });

  it('accepte des options de vault absentes', () => {
    expect(validate(FusionVaultIndexSchema, undefined)).toBeUndefined();
    expect(validate(FusionVaultIndexSchema, { force: true })?.force).toBe(true);
  });

  it('refuse un patch de serveur MCP mal typé', () => {
    expect(() => validate(FusionMcpServerPatchSchema, { enabled: 'oui' })).toThrow(/enabled/);
    expect(validate(FusionMcpServerPatchSchema, { enabled: false }).enabled).toBe(false);
  });
});
