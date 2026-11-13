/**
 * Localité d'un fournisseur au journal d'usage (S10-1-11).
 *
 * Le modèle embarqué (llama.cpp dans le processus de l'app, génération comme embeddings) ne quitte
 * jamais la machine. Il était compté « cloud » : `is_local = 0`, le libellé « cloud » des exports,
 * et un partage local/cloud faux précisément pour ceux qui n'ont pas Ollama (macOS 13).
 */
import { describe, expect, it } from 'vitest';
import { isLocalProvider } from '../is-local.js';

describe('isLocalProvider', () => {
  it('le modèle embarqué est local, génération (`embedded`) comme embeddings (`embedded-embedding`)', () => {
    expect(isLocalProvider('embedded')).toBe(true);
    expect(isLocalProvider('embedded-embedding')).toBe(true);
    // Le baseUrl d'Ollama transmis par le registre n'y change rien : il n'y a pas de serveur.
    expect(isLocalProvider('embedded', 'http://gpu.labo.example:11434', 'qwen3-4b')).toBe(true);
  });

  it('témoins : Ollama sur la machine, hébergé ou distant ; fournisseurs cloud', () => {
    expect(isLocalProvider('ollama')).toBe(true);
    expect(isLocalProvider('ollama', 'http://127.0.0.1:11434', 'llama3.2')).toBe(true);
    expect(isLocalProvider('ollama', 'http://127.0.0.1:11434', 'gpt-oss:120b-cloud')).toBe(false);
    expect(isLocalProvider('ollama', 'http://gpu.labo.example:11434', 'llama3.2')).toBe(false);
    expect(isLocalProvider('openai-compatible', 'http://localhost:8080/v1')).toBe(true);
    expect(isLocalProvider('openai-compatible')).toBe(false);
    expect(isLocalProvider('anthropic')).toBe(false);
    expect(isLocalProvider('mistral')).toBe(false);
  });
});
