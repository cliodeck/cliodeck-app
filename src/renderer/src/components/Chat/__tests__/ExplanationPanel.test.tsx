// @vitest-environment jsdom
/**
 * ExplanationPanel — collapse/expand + renders search stats & timing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ExplanationPanel } from '../ExplanationPanel';
import type { RAGExplanation } from '../../../stores/chatStore';

const fixture: RAGExplanation = {
  search: {
    totalResults: 12,
    searchDurationMs: 87,
    cacheHit: true,
    sourceType: 'secondary',
    documents: [
      { title: 'Test doc', chunkCount: 3, similarity: 0.82 },
    ],
  },
  llm: {
    provider: 'openai',
    model: 'gpt-4o',
    contextWindow: 128000,
    temperature: 0.2,
    promptSize: 5100,
  },
  timing: {
    searchMs: 87,
    generationMs: 650,
    totalMs: 737,
  },
} as unknown as RAGExplanation;

describe('ExplanationPanel', () => {
  afterEach(() => cleanup());

  it('shows a retrieval warning while the details are collapsed', () => {
    render(<ExplanationPanel explanation={{ ...fixture, search: { ...fixture.search, retrievalStatus: 'partial' } }} />);
    expect(screen.getByRole('status').textContent).toContain('échoué');
    expect(screen.queryByTestId('explanation-content')).not.toBeInTheDocument();
  });

  it('marque l’avertissement d’une icône lucide et de sa gravité (retouches #212)', () => {
    for (const status of ['empty', 'partial', 'failed'] as const) {
      const { container } = render(
        <ExplanationPanel explanation={{ ...fixture, search: { ...fixture.search, retrievalStatus: status } }} />
      );
      const warning = container.querySelector('.retrieval-warning');
      expect(warning?.querySelector('svg.lucide-triangle-alert, svg.lucide-alert-triangle')).not.toBeNull();
      expect(warning?.getAttribute('data-status')).toBe(status);
      cleanup();
    }
  });

  it('style l’avertissement avec les jetons du thème, sans couleur en dur (retouches #212)', () => {
    const css = fs.readFileSync(path.join(__dirname, '../MessageBubble.css'), 'utf8');
    const rules = [...css.matchAll(/\.retrieval-warning[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.join('\n')).toContain('var(--color-danger)');
    for (const body of rules) {
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });

  it('is collapsed by default and expands on toggle click', () => {
    render(<ExplanationPanel explanation={fixture} />);
    expect(screen.queryByTestId('explanation-content')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button');
    fireEvent.click(toggle);
    expect(screen.getByTestId('explanation-content')).toBeInTheDocument();
  });

  it('renders search stats (totalResults, duration) and timing', () => {
    render(<ExplanationPanel explanation={fixture} />);
    fireEvent.click(screen.getByRole('button'));
    const content = screen.getByTestId('explanation-content');
    expect(content.textContent).toContain('12');
    expect(content.textContent).toContain('87ms');
    expect(content.textContent).toContain('650ms');
    expect(content.textContent).toContain('737ms');
    // Provider / model surfaced.
    expect(content.textContent).toContain('openai');
    expect(content.textContent).toContain('gpt-4o');
  });

  it('collapses back when toggled again', () => {
    render(<ExplanationPanel explanation={fixture} />);
    const toggle = screen.getByRole('button');
    fireEvent.click(toggle);
    expect(screen.getByTestId('explanation-content')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('explanation-content')).not.toBeInTheDocument();
  });

  // Les explications persistées avant l'ajout de `corpora` / `contextChars`
  // (historiques anciens) gardent l'ancienne ligne « Type de sources ».
  it('sans corpora garde la ligne « Type de sources » et aucune ligne de contexte', () => {
    render(<ExplanationPanel explanation={fixture} />);
    fireEvent.click(screen.getByRole('button'));
    const content = screen.getByTestId('explanation-content');
    expect(content.textContent).toContain('Type de sources:');
    expect(content.textContent).toContain('Bibliographie (PDFs)');
    expect(screen.queryByTestId('explanation-corpora')).not.toBeInTheDocument();
    expect(screen.queryByTestId('explanation-context-chars')).not.toBeInTheDocument();
  });

  it('compte chaque corpus, marque ceux non interrogés et donne la part du manuscrit', () => {
    const withCorpora = {
      ...fixture,
      search: {
        ...fixture.search,
        corpora: [
          { source: 'secondary', attempted: true, ok: true, hitCount: 9, selectedCount: 5 },
          { source: 'primary', attempted: true, ok: true, hitCount: 2, selectedCount: 2 },
          { source: 'vault', attempted: false, ok: false, hitCount: 0, selectedCount: 0 },
          { source: 'manuscript', attempted: true, ok: true, hitCount: 7, selectedCount: 3 },
          { source: 'readingNotes', attempted: true, ok: true, hitCount: 0, selectedCount: 0 },
        ],
        contextChars: { total: 12_400, sources: 7_900, manuscript: 4_500, readingNotes: 0 },
      },
    } as unknown as RAGExplanation;
    render(<ExplanationPanel explanation={withCorpora} />);
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByTestId('explanation-corpus-secondary').textContent).toBe('Bibliographie 5');
    expect(screen.getByTestId('explanation-corpus-primary').textContent).toBe('Archives 2');
    expect(screen.getByTestId('explanation-corpus-vault').textContent).toBe(
      'Notes (vault) non interrogé'
    );
    expect(screen.getByTestId('explanation-corpus-manuscript').textContent).toBe('Manuscrit 3');
    // Un corpus à zéro reste listé : l'absence se lit, elle ne se devine pas.
    expect(screen.getByTestId('explanation-corpus-readingNotes').textContent).toBe(
      'Notes de lecture 0'
    );
    // L'ordre : les sources, puis le texte de l'auteur.
    expect(screen.getByTestId('explanation-corpora').textContent).toMatch(
      /Bibliographie 5 · Archives 2 · Notes \(vault\) non interrogé · Manuscrit 3 · Notes de lecture 0/
    );
    expect(screen.getByTestId('explanation-content').textContent).not.toContain('Type de sources');

    const context = screen.getByTestId('explanation-context-chars').textContent;
    expect(context).toContain('12.4k caractères');
    expect(context).toContain('dont manuscrit 4.5k (36 %)');
  });

  it('tait la part du manuscrit quand il ne pèse rien, et liste un corpus absent comme non interrogé', () => {
    const noManuscript = {
      ...fixture,
      search: {
        ...fixture.search,
        corpora: [{ source: 'secondary', attempted: true, ok: true, hitCount: 4, selectedCount: 4 }],
        contextChars: { total: 6_000, sources: 6_000, manuscript: 0, readingNotes: 0 },
      },
    } as unknown as RAGExplanation;
    render(<ExplanationPanel explanation={noManuscript} />);
    fireEvent.click(screen.getByRole('button'));
    const context = screen.getByTestId('explanation-context-chars').textContent;
    expect(context).toContain('6.0k caractères');
    expect(context).not.toContain('dont manuscrit');
    expect(screen.getByTestId('explanation-corpus-manuscript').textContent).toBe(
      'Manuscrit non interrogé'
    );
  });

  // L08-4 : le modèle embarqué ne lit pas plus d'extraits que sa fenêtre n'en tient. Le plafond se
  // dit quand il a réduit le nombre demandé ; sans lui, rien.
  it('dit le plafond d’extraits imposé par la fenêtre du modèle, et seulement quand il y en a un', () => {
    const capped = {
      ...fixture,
      search: { ...fixture.search, extractsCap: 4 },
      llm: { ...fixture.llm, contextWindow: 4096 },
    } as unknown as RAGExplanation;
    render(<ExplanationPanel explanation={capped} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('explanation-extracts-cap').textContent).toBe(
      "Plafond d'extraits: 4 (fenêtre de contexte du modèle)"
    );
    expect(screen.getByTestId('explanation-content').textContent).toContain('4096 tokens');
    cleanup();

    render(<ExplanationPanel explanation={fixture} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('explanation-extracts-cap')).not.toBeInTheDocument();
  });

  // Revue de L08-4 : des extraits trouvés, aucun lu (les indications du projet prennent toute la
  // fenêtre). Le panneau des sources est vide : sans avertissement, l'historien conclurait que la
  // recherche n'a rien trouvé.
  it('aucun extrait lu sur ceux trouvés : un avertissement visible sans déplier le panneau', () => {
    const unread = {
      ...fixture,
      search: { ...fixture.search, extractsCap: 0, totalResults: 4 },
    } as unknown as RAGExplanation;
    const { container } = render(<ExplanationPanel explanation={unread} />);
    const warning = container.querySelector('.retrieval-warning');
    expect(warning?.getAttribute('data-status')).toBe('unread');
    expect(screen.getByRole('status').textContent).toBe(
      'Des extraits ont été trouvés, mais aucun ne tient dans la fenêtre de contexte du modèle avec les consignes : la réponse ne s’appuie sur aucun d’eux. Des consignes de projet plus courtes leur feraient place.'
    );
    expect(warning?.querySelector('svg.lucide-triangle-alert, svg.lucide-alert-triangle')).not.toBeNull();
    cleanup();

    // Un plafond qui laisse des extraits n'a rien à signaler hors du panneau.
    render(<ExplanationPanel explanation={{ ...fixture, search: { ...fixture.search, extractsCap: 2 } } as unknown as RAGExplanation} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
