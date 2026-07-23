import { describe, expect, it, vi } from 'vitest';
import {
  CloudConsentRegistry,
  classifyProvider,
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
