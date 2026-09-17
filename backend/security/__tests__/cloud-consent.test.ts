import { describe, expect, it, vi } from 'vitest';
import {
  CloudConsentRegistry,
  classifyEmbeddingTarget,
  classifyProvider,
  cloudConsentRefusalMessage,
  confirmCloudUsage,
  decideCloudConsent,
  type ConsentPrompt,
} from '../cloud-consent.js';

function promptAnswering(response: number): ConsentPrompt & { calls: number } {
  const p = {
    calls: 0,
    showMessageBox: vi.fn(async () => {
      p.calls += 1;
      return { response };
    }),
  };
  return p as unknown as ConsentPrompt & { calls: number };
}

describe('classifyProvider', () => {
  it('classe les fournisseurs hébergés comme distants', () => {
    for (const [backend, label] of [
      ['claude', 'Anthropic Claude'],
      ['openai', 'OpenAI'],
      ['mistral', 'Mistral AI'],
      ['gemini', 'Google Gemini'],
    ] as const) {
      expect(classifyProvider({ backend })).toEqual({
        isCloud: true,
        providerName: label,
      });
    }
  });

  it('considère Ollama en loopback comme local', () => {
    for (const url of [
      'http://localhost:11434',
      'http://127.0.0.1:11434',
      'http://[::1]:11434',
    ]) {
      expect(classifyProvider({ backend: 'ollama', ollamaURL: url }).isCloud).toBe(false);
    }
  });

  it('considère un Ollama distant comme distant', () => {
    const c = classifyProvider({ backend: 'ollama', ollamaURL: 'http://gpu.lab.uni.lu:11434' });
    expect(c.isCloud).toBe(true);
    expect(c.providerName).toContain('gpu.lab.uni.lu');
  });

  it('suppose local sur une URL malformée, comme le renderer', () => {
    expect(classifyProvider({ backend: 'ollama', ollamaURL: 'pas une url' }).isCloud).toBe(false);
  });
});

describe('decideCloudConsent', () => {
  it('laisse passer un fournisseur local sans rien demander', async () => {
    const prompt = promptAnswering(1);
    const d = await decideCloudConsent(
      { backend: 'ollama', ollamaURL: 'http://127.0.0.1:11434' },
      prompt,
      new CloudConsentRegistry()
    );
    expect(d).toEqual({ allowed: true, reason: 'local' });
    expect(prompt.calls).toBe(0);
  });

  it('demande une fois puis mémorise pour la session', async () => {
    const registry = new CloudConsentRegistry();
    const prompt = promptAnswering(1);

    const first = await decideCloudConsent({ backend: 'openai' }, prompt, registry);
    expect(first).toEqual({ allowed: true, reason: 'granted-now' });
    expect(registry.isGranted()).toBe(true);

    const second = await decideCloudConsent({ backend: 'openai' }, prompt, registry);
    expect(second).toEqual({ allowed: true, reason: 'already-granted' });
    // Une seule question pour toute la session.
    expect(prompt.calls).toBe(1);
  });

  it('refuse quand l’utilisateur annule, et ne mémorise rien', async () => {
    const registry = new CloudConsentRegistry();
    const d = await decideCloudConsent({ backend: 'claude' }, promptAnswering(0), registry);
    expect(d).toEqual({
      allowed: false,
      reason: 'declined',
      providerName: 'Anthropic Claude',
    });
    expect(registry.isGranted()).toBe(false);
  });

  it('refuse sans interface (headless) plutôt que de supposer', async () => {
    const d = await decideCloudConsent({ backend: 'mistral' }, null, new CloudConsentRegistry());
    expect(d).toEqual({
      allowed: false,
      reason: 'no-interface',
      providerName: 'Mistral AI',
    });
  });

  it('laisse passer un chemin headless qui a accordé explicitement', async () => {
    const registry = new CloudConsentRegistry();
    registry.grant('OpenAI');
    const d = await decideCloudConsent({ backend: 'openai' }, null, registry);
    expect(d.allowed).toBe(true);
  });

  it('un consentement donné à un fournisseur n’ouvre pas les envois vers un autre', async () => {
    const registry = new CloudConsentRegistry();
    registry.grant('Mistral AI');
    const prompt = promptAnswering(0);
    const d = await decideCloudConsent({ backend: 'claude' }, prompt, registry);
    expect(d.allowed).toBe(false);
    expect(prompt.calls).toBe(1);
  });

  it('pose la question avec le texte de la surface qui envoie', async () => {
    const details: string[] = [];
    const prompt: ConsentPrompt = {
      showMessageBox: async (options) => {
        details.push(options.detail);
        return { response: 0 };
      },
    };
    for (const surface of ['chat', 'recipe', 'slides', 'similarity'] as const) {
      await decideCloudConsent({ backend: 'openai' }, prompt, new CloudConsentRegistry(), surface);
    }
    expect(details[0]).toContain('conversation');
    expect(details[1]).toContain('recette');
    expect(details[2]).toContain('diapositives');
    expect(details[3]).toContain('reclassement');
    // Aucun texte ne décrit une autre surface que la sienne.
    for (const d of details.slice(1)) expect(d).not.toContain('conversation');
    for (const d of details) expect(d).toContain('OpenAI');
  });

  it('redemande après révocation', async () => {
    const registry = new CloudConsentRegistry();
    registry.grant('OpenAI');
    registry.revoke();
    const prompt = promptAnswering(0);
    const d = await decideCloudConsent({ backend: 'openai' }, prompt, registry);
    expect(d.allowed).toBe(false);
    expect(prompt.calls).toBe(1);
  });
});

describe('confirmCloudUsage', () => {
  it('refuse par défaut : seul le second bouton vaut acceptation', async () => {
    expect(await confirmCloudUsage('OpenAI', promptAnswering(0))).toBe(false);
    expect(await confirmCloudUsage('OpenAI', promptAnswering(1))).toBe(true);
  });

  it('nomme le service dans le message et défausse sur Annuler', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const prompt: ConsentPrompt = {
      showMessageBox: async (options) => {
        seen.push(options as unknown as Record<string, unknown>);
        return { response: 0 };
      },
    };
    await confirmCloudUsage('Anthropic Claude', prompt);
    expect(seen[0].message).toContain('Anthropic Claude');
    expect(seen[0].cancelId).toBe(0);
    expect(seen[0].defaultId).toBe(0);
  });
});

describe('cloudConsentRefusalMessage', () => {
  it('distingue l’annulation de l’absence d’interface', () => {
    expect(
      cloudConsentRefusalMessage({ allowed: false, reason: 'declined', providerName: 'OpenAI' })
    ).toBe('Envoi vers OpenAI annulé.');
    expect(
      cloudConsentRefusalMessage({ allowed: false, reason: 'no-interface', providerName: 'OpenAI' })
    ).toContain('aucun consentement');
  });
});

describe('classifyEmbeddingTarget', () => {
  it('garde en local le modèle embarqué et Ollama en loopback', () => {
    expect(classifyEmbeddingTarget({ provider: 'embedded' }).isCloud).toBe(false);
    expect(
      classifyEmbeddingTarget({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' }).isCloud
    ).toBe(false);
    // Sans URL, le fournisseur Ollama vise la machine locale.
    expect(classifyEmbeddingTarget({ provider: 'ollama' }).isCloud).toBe(false);
  });

  it('classe un Ollama distant comme distant, en le nommant', () => {
    const c = classifyEmbeddingTarget({ provider: 'ollama', baseUrl: 'http://gpu.labo.example:11434' });
    expect(c).toEqual({ isCloud: true, providerName: 'Ollama (gpu.labo.example)' });
  });

  it('classe les embeddings des fournisseurs hébergés comme distants', () => {
    expect(
      classifyEmbeddingTarget({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
    ).toEqual({ isCloud: true, providerName: 'OpenAI' });
    expect(classifyEmbeddingTarget({ provider: 'mistral' }).isCloud).toBe(true);
    expect(classifyEmbeddingTarget({ provider: 'gemini' }).isCloud).toBe(true);
  });

  it('distingue un serveur compatible OpenAI local d’un distant', () => {
    expect(
      classifyEmbeddingTarget({ provider: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' }).isCloud
    ).toBe(false);
    expect(
      classifyEmbeddingTarget({ provider: 'openai-compatible', baseUrl: 'https://llm.example.org/v1' }).isCloud
    ).toBe(true);
  });

  it('ne suppose jamais local un fournisseur inconnu', () => {
    expect(classifyEmbeddingTarget({ provider: 'nouveau' }).isCloud).toBe(true);
  });
});
