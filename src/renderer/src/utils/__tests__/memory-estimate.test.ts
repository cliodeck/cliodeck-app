import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KV_BYTES_PER_TOKEN,
  estimateModelMemory,
  formatGiB,
  USABLE_MEMORY_RATIO,
} from '../memory-estimate';

const GiB = 1024 ** 3;

describe('estimateModelMemory', () => {
  const mac24 = 24 * GiB;
  const qwen35 = 22.2 * GiB;

  it('reproduit le piège du 2026-09-08 : un modèle de 22 Go sur 24 Go déborde déjà seul', () => {
    const e = estimateModelMemory({ modelBytes: qwen35, numCtx: 262_144, totalMemoryBytes: mac24 });
    expect(e?.level).toBe('model');
    expect(e?.budgetBytes).toBeCloseTo(mac24 * USABLE_MEMORY_RATIO, -6);
  });

  it('signale la fenêtre quand c’est elle qui fait déborder', () => {
    const model8b = 4.9 * GiB;
    const ok = estimateModelMemory({ modelBytes: model8b, numCtx: 32_768, totalMemoryBytes: mac24 });
    expect(ok?.level).toBe('ok');
    // 128 KiB/jeton par défaut : 262 144 jetons = 32 Go.
    const big = estimateModelMemory({ modelBytes: model8b, numCtx: 262_144, totalMemoryBytes: mac24 });
    expect(big?.level).toBe('context');
    expect(big?.contextBytes).toBe(262_144 * DEFAULT_KV_BYTES_PER_TOKEN);
  });

  it('utilise le coût par jeton du modèle quand Ollama le donne', () => {
    const e = estimateModelMemory({
      modelBytes: 4.9 * GiB,
      numCtx: 262_144,
      kvBytesPerToken: 20 * 1024,
      totalMemoryBytes: mac24,
    });
    expect(e?.contextBytes).toBe(262_144 * 20 * 1024);
    expect(e?.level).toBe('ok');
  });

  it('renvoie null sans taille de modèle, sans mémoire, ou sans fenêtre', () => {
    expect(estimateModelMemory({ numCtx: 4096, totalMemoryBytes: mac24 })).toBeNull();
    expect(estimateModelMemory({ modelBytes: GiB, numCtx: 4096 })).toBeNull();
    expect(estimateModelMemory({ modelBytes: GiB, numCtx: 0, totalMemoryBytes: mac24 })).toBeNull();
  });

  it('formate en gibioctets à une décimale', () => {
    expect(formatGiB(22.2 * GiB)).toBe('22.2');
    expect(formatGiB(24 * GiB)).toBe('24.0');
  });
});
