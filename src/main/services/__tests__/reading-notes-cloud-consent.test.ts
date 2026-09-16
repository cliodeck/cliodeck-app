/**
 * Notes de lecture et fournisseur d'embeddings distant : la décision par
 * défaut du service, lue sur la configuration réelle (`llm` + `rag`).
 *
 * `docs/reading-notes.md` promet que, sans `rag.readingNotesCloudConsent`,
 * les notes ne partent jamais vers un fournisseur distant. L'indexation les
 * envoyait pourtant au fournisseur d'embeddings, fût-il en ligne.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { EmbeddingProvider } from '../../../../backend/core/llm/providers/base.js';

const h = vi.hoisted(() => ({
  llm: {} as Record<string, unknown>,
  rag: {} as Record<string, unknown>,
}));

vi.mock('../config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => h.llm,
    getRAGConfig: () => h.rag,
  },
}));

import { ReadingNotesIndexService } from '../reading-notes-index-service.js';

function embedderCountingCalls(): EmbeddingProvider & { calls: number } {
  const e = {
    calls: 0,
    async embed(texts: string[]): Promise<number[][]> {
      e.calls += 1;
      return texts.map(() => [0, 0, 0, 0]);
    },
  };
  return e as unknown as EmbeddingProvider & { calls: number };
}

async function indexWithDefaults(): Promise<{ withheldFrom?: string; calls: number }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-rn-consent-'));
  const service = new ReadingNotesIndexService();
  // Projet sans notes : on ne regarde que la décision prise avant toute lecture.
  service.configure(root);
  try {
    const embedder = embedderCountingCalls();
    const report = await service.index(embedder);
    return { withheldFrom: report.withheldFrom, calls: embedder.calls };
  } finally {
    service.clear();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('ReadingNotesIndexService — consentement lu sur la configuration', () => {
  beforeEach(() => {
    h.llm = { backend: 'ollama', ollamaURL: 'http://127.0.0.1:11434' };
    h.rag = {};
  });

  it('indexe avec un Ollama local, sans rien demander', async () => {
    expect((await indexWithDefaults()).withheldFrom).toBeUndefined();
  });

  it('garde les embeddings Ollama locaux d’un backend Claude : rien ne part', async () => {
    h.llm = { backend: 'claude', claudeAPIKey: 'sk-test', ollamaURL: 'http://127.0.0.1:11434' };
    expect((await indexWithDefaults()).withheldFrom).toBeUndefined();
  });

  it('s’abstient avec des embeddings cloud sans consentement', async () => {
    h.llm = { backend: 'openai', openaiAPIKey: 'sk-test', useCloudEmbeddings: true };
    const r = await indexWithDefaults();
    expect(r.withheldFrom).toBe('OpenAI');
    expect(r.calls).toBe(0);
  });

  it('s’abstient avec un Ollama distant sans consentement', async () => {
    h.llm = { backend: 'ollama', ollamaURL: 'http://gpu.labo.example:11434' };
    expect((await indexWithDefaults()).withheldFrom).toBe('Ollama (gpu.labo.example)');
  });

  it('indexe vers un service en ligne quand l’auteur y a consenti', async () => {
    h.llm = { backend: 'mistral', mistralAPIKey: 'sk-test', useCloudEmbeddings: true };
    h.rag = { readingNotesCloudConsent: true };
    expect((await indexWithDefaults()).withheldFrom).toBeUndefined();
  });
});
