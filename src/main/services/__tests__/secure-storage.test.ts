/**
 * Tests de `secure-storage` — le module qui garde les clés d'API n'en avait
 * aucun (item 19 de l'audit). On couvre les deux modes de stockage, y compris
 * le **repli en clair** documenté par l'ADR 0006, et le masquage sur lequel
 * repose la règle « le renderer ne reçoit jamais une clé ».
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock Electron safeStorage -----------------------------------------
const safeStorageState = {
  available: true,
  /** Chiffrement factice mais réversible : préfixe + inversion. */
  encrypt: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
  decrypt: (b: Buffer) => {
    const raw = b.toString('utf8');
    if (!raw.startsWith('enc:')) throw new Error('not encrypted by us');
    return raw.slice(4);
  },
};

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => safeStorageState.available,
    encryptString: (s: string) => safeStorageState.encrypt(s),
    decryptString: (b: Buffer) => safeStorageState.decrypt(b),
  },
}));

// --- Mock electron-store (import dynamique dans init()) -----------------
const stores: Array<Record<string, string | undefined>> = [];

vi.mock('electron-store', () => {
  class FakeStore {
    store: Record<string, string | undefined> = {};
    constructor() {
      stores.push(this.store);
    }
    get(key: string) {
      return this.store[key];
    }
    set(key: string, value: string | undefined) {
      this.store[key] = value;
    }
    delete(key: string) {
      delete this.store[key];
    }
    has(key: string) {
      return Object.prototype.hasOwnProperty.call(this.store, key);
    }
  }
  return { default: FakeStore };
});

const { SecureStorage, SENSITIVE_KEYS, isSensitiveKey, maskAPIKey } = await import(
  '../secure-storage.js'
);

async function freshStorage(encryptionAvailable: boolean) {
  safeStorageState.available = encryptionAvailable;
  const s = new SecureStorage();
  await s.init();
  return s;
}

beforeEach(() => {
  stores.length = 0;
  safeStorageState.available = true;
});

describe('maskAPIKey', () => {
  it('ne révèle rien d’une clé courte', () => {
    expect(maskAPIKey('court')).toBe('****');
    expect(maskAPIKey('123456789012')).toBe('****');
  });

  it('montre les 4 premiers et 4 derniers caractères d’une clé longue', () => {
    expect(maskAPIKey('sk-abcdefghijklmnop')).toBe('sk-a...mnop');
  });

  it('rend une chaîne vide pour une clé absente', () => {
    expect(maskAPIKey(undefined)).toBe('');
    expect(maskAPIKey('')).toBe('');
  });

  it('n’est pas réversible : le masque ne contient pas le cœur de la clé', () => {
    const key = 'sk-SECRETMILIEU-1234';
    expect(maskAPIKey(key)).not.toContain('SECRETMILIEU');
  });
});

describe('SENSITIVE_KEYS', () => {
  it('couvre les quatre fournisseurs LLM, Zotero et Europeana', () => {
    expect([...SENSITIVE_KEYS]).toEqual([
      'llm.claudeAPIKey',
      'llm.openaiAPIKey',
      'llm.mistralAPIKey',
      'llm.geminiAPIKey',
      'zotero.apiKey',
      'mcp.europeana.apiKey',
    ]);
  });

  it('isSensitiveKey reconnaît les clés listées et rien d’autre', () => {
    expect(isSensitiveKey('llm.claudeAPIKey')).toBe(true);
    expect(isSensitiveKey('zotero.apiKey')).toBe(true);
    expect(isSensitiveKey('llm.ollamaChatModel')).toBe(false);
    expect(isSensitiveKey('editor.fontSize')).toBe(false);
  });
});

describe('SecureStorage — chiffrement disponible', () => {
  it('chiffre à l’écriture : la valeur brute n’est jamais dans le store', async () => {
    const s = await freshStorage(true);
    s.setKey('llm.openaiAPIKey', 'sk-tres-secret');

    const persisted = stores[0]['llm.openaiAPIKey'];
    expect(persisted).toBeDefined();
    expect(persisted).not.toContain('sk-tres-secret');
    // Base64 d'un buffer chiffré.
    expect(Buffer.from(persisted!, 'base64').toString('utf8')).toBe('enc:sk-tres-secret');
  });

  it('déchiffre à la lecture', async () => {
    const s = await freshStorage(true);
    s.setKey('zotero.apiKey', 'zot-123');
    expect(s.getKey('zotero.apiKey')).toBe('zot-123');
    expect(s.isEncrypted()).toBe(true);
  });

  it('retombe sur la valeur brute quand le déchiffrement échoue', async () => {
    // Cas réel : clé écrite en clair avant qu'un trousseau ne soit installé.
    const s = await freshStorage(true);
    stores[0]['llm.geminiAPIKey'] = Buffer.from('en-clair-historique', 'utf8').toString(
      'base64'
    );
    expect(s.getKey('llm.geminiAPIKey')).toBe(
      Buffer.from('en-clair-historique', 'utf8').toString('base64')
    );
  });
});

describe('SecureStorage — repli en clair (ADR 0006)', () => {
  it('stocke en clair quand le trousseau système est indisponible', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await freshStorage(false);

    expect(s.isEncrypted()).toBe(false);
    // L'utilisateur doit être averti : c'est la limitation connue de l'ADR.
    expect(warn).toHaveBeenCalled();

    s.setKey('llm.mistralAPIKey', 'ms-clair');
    expect(stores[0]['llm.mistralAPIKey']).toBe('ms-clair');
    expect(s.getKey('llm.mistralAPIKey')).toBe('ms-clair');
    warn.mockRestore();
  });
});

describe('SecureStorage — cycle de vie des clés', () => {
  it('traite une valeur vide comme une suppression', async () => {
    const s = await freshStorage(true);
    s.setKey('llm.claudeAPIKey', 'sk-x');
    expect(s.hasKey('llm.claudeAPIKey')).toBe(true);

    s.setKey('llm.claudeAPIKey', '');
    expect(s.hasKey('llm.claudeAPIKey')).toBe(false);
    expect(s.getKey('llm.claudeAPIKey')).toBe('');
  });

  it('rend une chaîne vide pour une clé absente', async () => {
    const s = await freshStorage(true);
    expect(s.getKey('llm.openaiAPIKey')).toBe('');
  });

  it('deleteKey retire la clé', async () => {
    const s = await freshStorage(true);
    s.setKey('zotero.apiKey', 'z');
    s.deleteKey('zotero.apiKey');
    expect(s.hasKey('zotero.apiKey')).toBe(false);
  });

  it('revokeAll efface tout et rend le compte (ADR 0006)', async () => {
    const s = await freshStorage(true);
    s.setKey('llm.claudeAPIKey', 'a');
    s.setKey('llm.openaiAPIKey', 'b');
    s.setKey('zotero.apiKey', 'c');

    expect(s.revokeAll()).toBe(3);
    expect(s.getKey('llm.claudeAPIKey')).toBe('');
    expect(Object.keys(stores[0])).toHaveLength(0);
  });

  it('refuse de travailler avant init()', () => {
    const s = new SecureStorage();
    expect(() => s.getKey('llm.claudeAPIKey')).toThrow(/not initialized/i);
  });
});
