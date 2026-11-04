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

const { SecureStorage, SENSITIVE_KEYS, isMaskedKey, isSensitiveKey, maskAPIKey } = await import(
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

describe('isMaskedKey', () => {
  it('reconnaît tout ce que maskAPIKey produit', () => {
    for (const key of [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'sk-proj-abcdefghijklmnopqrstuvwxyz',
      'AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'P9NiZqmistral32caracteresABCDEFG',
      'court',
      '123456789012',
      'a.b.c.d.e.f.g.h.i.j',
      // Une clé collée avec son saut de ligne : le masque le garde.
      'sk-une-cle-collee-avec-saut\n',
      '\nsk-une-cle-collee-apres-saut',
    ]) {
      expect(isMaskedKey(maskAPIKey(key)), JSON.stringify(key)).toBe(true);
    }
  });

  it('ne prend pour un masque aucune forme réelle de clé', () => {
    for (const key of [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'sk-proj-abcdefghijklmnopqrstuvwxyz',
      'sk-abcdefghijklmnop',
      'AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'P9NiZqmistral32caracteresABCDEFG',
      'P9NiZqZoteroKey24Caracte',
      // 12 caractères ou moins : leur masque est `****`, eux n'en sont pas un.
      '123456789012',
      'abcdefghijk',
      'abc',
      'a',
      '*****',
      '***',
      // Des points, mais pas à la place d'un masque.
      'aaaa.bbbb.cccc',
      'abc...wxyz',
      'abcd...wxy',
      'abcde...wxyz',
      'abcd....wxyz',
      // Une clé plus longue qui contient un masque.
      'sk-a...wXyZ-suite',
    ]) {
      expect(isMaskedKey(key), key).toBe(false);
    }
  });

  it('une valeur vide ou d’un autre type n’est pas un masque : vider garde son sens', () => {
    expect(isMaskedKey('')).toBe(false);
    expect(isMaskedKey(undefined)).toBe(false);
    expect(isMaskedKey(null)).toBe(false);
    expect(isMaskedKey(1234)).toBe(false);
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

describe('SecureStorage — un masque n’est jamais une clé', () => {
  it('une clé de SENSITIVE_KEYS ne le stocke pas, et garde sa valeur', async () => {
    const s = await freshStorage(true);
    s.setKey('llm.claudeAPIKey', 'sk-la-vraie-cle-longue');
    s.setKey('llm.claudeAPIKey', 'sk-a...wXyZ');
    s.setKey('llm.claudeAPIKey', '****');
    expect(s.getKey('llm.claudeAPIKey')).toBe('sk-la-vraie-cle-longue');

    s.setKey('mcp.europeana.apiKey', 'abcd...wxyz');
    expect(s.hasKey('mcp.europeana.apiKey')).toBe(false);
  });

  it('vider efface toujours ; un secret d’environnement MCP garde la forme qu’il veut', async () => {
    const s = await freshStorage(true);
    s.setKey('llm.claudeAPIKey', 'sk-la-vraie-cle-longue');
    s.setKey('llm.claudeAPIKey', '');
    expect(s.hasKey('llm.claudeAPIKey')).toBe(false);

    s.setKey('mcp.env.client.TOKEN', 'abcd...wxyz');
    expect(s.getKey('mcp.env.client.TOKEN')).toBe('abcd...wxyz');
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

describe('clé indéchiffrable avec le trousseau courant', () => {
  /** Un chiffré Chromium (préfixe `v10`) que notre déchiffreur factice ne connaît pas. */
  const foreignCiphertext = Buffer.concat([Buffer.from('v10', 'latin1'), Buffer.alloc(16, 7)]).toString('base64');

  it('est traitée comme absente, listée, et n’avertit qu’une fois', async () => {
    const s = await freshStorage(true);
    stores[0]['llm.openaiAPIKey'] = foreignCiphertext;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(s.getKey('llm.openaiAPIKey')).toBe('');
    expect(s.getKey('llm.openaiAPIKey')).toBe('');
    expect(s.unreadableKeys()).toEqual(['llm.openaiAPIKey']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/trousseau/);
    warn.mockRestore();
  });

  it('sort de la liste dès qu’on la ressaisit ou qu’on la supprime', async () => {
    const s = await freshStorage(true);
    stores[0]['llm.openaiAPIKey'] = foreignCiphertext;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    s.getKey('llm.openaiAPIKey');
    s.setKey('llm.openaiAPIKey', 'sk-nouvelle-cle-valide-0123456789');
    expect(s.unreadableKeys()).toEqual([]);
    expect(s.getKey('llm.openaiAPIKey')).toBe('sk-nouvelle-cle-valide-0123456789');
    stores[0]['llm.mistralAPIKey'] = foreignCiphertext;
    s.getKey('llm.mistralAPIKey');
    s.deleteKey('llm.mistralAPIKey');
    expect(s.unreadableKeys()).toEqual([]);
    vi.restoreAllMocks();
  });

  it('une valeur en clair reste lue, et se retrouve rechiffrée', async () => {
    const s = await freshStorage(true);
    stores[0]['llm.claudeAPIKey'] = 'sk-ant-en-clair-depuis-avant-le-chiffrement';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(s.getKey('llm.claudeAPIKey')).toBe('sk-ant-en-clair-depuis-avant-le-chiffrement');
    expect(s.unreadableKeys()).toEqual([]);
    // Rechiffrée par notre chiffreur factice : `enc:` + valeur, en base64.
    expect(Buffer.from(stores[0]['llm.claudeAPIKey'] ?? '', 'base64').toString('utf8')).toBe(
      'enc:sk-ant-en-clair-depuis-avant-le-chiffrement'
    );
    // Deuxième lecture : déchiffrement normal, plus d'avertissement.
    expect(s.getKey('llm.claudeAPIKey')).toBe('sk-ant-en-clair-depuis-avant-le-chiffrement');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('repli en clair visible (dette n° 16)', () => {
  const chromiumCiphertext = Buffer.concat([Buffer.from('v10', 'latin1'), Buffer.alloc(16, 3)]).toString('base64');

  it('ne liste aucune clé en clair tant que le trousseau répond', async () => {
    const s = await freshStorage(true);
    s.setKey('llm.openaiAPIKey', 'sk-chiffree-0123456789');
    expect(s.plaintextKeys()).toEqual([]);
  });

  it('liste les clés stockées en clair quand le trousseau manque, y compris hors SENSITIVE_KEYS', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = await freshStorage(false);
    s.setKey('zotero.apiKey', 'zot-clair');
    s.setKey('llm.mistralAPIKey', 'ms-clair');
    s.setKey('mcp.client.github.GITHUB_TOKEN', 'ghp-clair');
    expect(s.plaintextKeys()).toEqual(['llm.mistralAPIKey', 'mcp.client.github.GITHUB_TOKEN', 'zotero.apiKey']);
    vi.restoreAllMocks();
  });

  it('sans trousseau, un chiffré n’est jamais renvoyé comme clé d’API', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = await freshStorage(false);
    // Écrit lors d'un lancement où le trousseau répondait.
    stores[0]['llm.claudeAPIKey'] = chromiumCiphertext;
    stores[0]['zotero.apiKey'] = 'zot-clair';

    expect(s.getKey('llm.claudeAPIKey')).toBe('');
    expect(s.unreadableKeys()).toEqual(['llm.claudeAPIKey']);
    // Illisible, donc pas « en clair » : seules les vraies valeurs en clair sont listées.
    expect(s.plaintextKeys()).toEqual(['zotero.apiKey']);
    expect(warn.mock.calls.some((c) => /aucun trousseau/.test(String(c[0])))).toBe(true);
    warn.mockRestore();
  });
});

describe('un masque déjà stocké (S17-1-29, sur une version antérieure)', () => {
  /** Tel que `setKey` l'écrivait avant la règle : chiffré comme une vraie clé. */
  const storedMask = (mask: string) => safeStorageState.encrypt(mask).toString('base64');

  it('n’est pas rendu comme une clé : il partirait comme jeton vers le fournisseur', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = await freshStorage(true);
    stores[0]['llm.openaiAPIKey'] = storedMask('sk-u...ngue');
    stores[0]['zotero.apiKey'] = storedMask('****');

    expect(s.getKey('llm.openaiAPIKey')).toBe('');
    expect(s.getKey('zotero.apiKey')).toBe('');
    // Le champ ne se remontre plus en `****` : `maskAPIKey('')` rend une chaîne vide.
    expect(maskAPIKey(s.getKey('llm.openaiAPIKey'))).toBe('');
    warn.mockRestore();
  });

  it('se liste avec les clés illisibles, avec un seul avertissement par clé, et se supprime', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = await freshStorage(true);
    stores[0]['llm.openaiAPIKey'] = storedMask('sk-u...ngue');

    s.getKey('llm.openaiAPIKey');
    s.getKey('llm.openaiAPIKey');
    expect(s.unreadableKeys()).toEqual(['llm.openaiAPIKey']);
    expect(warn).toHaveBeenCalledTimes(1);

    s.setKey('llm.openaiAPIKey', '');
    expect(s.unreadableKeys()).toEqual([]);
    expect(stores[0]['llm.openaiAPIKey']).toBeUndefined();
    warn.mockRestore();
  });

  it('une vraie clé saisie ensuite le remplace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = await freshStorage(true);
    stores[0]['llm.openaiAPIKey'] = storedMask('sk-u...ngue');
    s.getKey('llm.openaiAPIKey');

    s.setKey('llm.openaiAPIKey', 'sk-nouvelle-cle-valide-0123456789');

    expect(s.getKey('llm.openaiAPIKey')).toBe('sk-nouvelle-cle-valide-0123456789');
    expect(s.unreadableKeys()).toEqual([]);
    warn.mockRestore();
  });

  it('vaut aussi quand le trousseau manque et que la valeur est en clair', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = await freshStorage(false);
    stores[0]['llm.claudeAPIKey'] = 'sk-a...wXyZ';

    expect(s.getKey('llm.claudeAPIKey')).toBe('');
    expect(s.unreadableKeys()).toEqual(['llm.claudeAPIKey']);
    expect(s.plaintextKeys()).toEqual([]);
    warn.mockRestore();
  });

  it('un secret d’environnement MCP garde la forme qu’il veut : la règle ne vise que SENSITIVE_KEYS', async () => {
    const s = await freshStorage(true);
    stores[0]['mcp.client.demo.TOKEN'] = storedMask('abcd...wxyz');

    expect(s.getKey('mcp.client.demo.TOKEN')).toBe('abcd...wxyz');
    expect(s.unreadableKeys()).toEqual([]);
  });

  it('une révocation efface aussi la liste : plus rien n’est stocké, donc plus rien d’illisible', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = await freshStorage(true);
    stores[0]['llm.openaiAPIKey'] = storedMask('sk-u...ngue');
    s.getKey('llm.openaiAPIKey');

    s.revokeAll();

    expect(s.unreadableKeys()).toEqual([]);
    warn.mockRestore();
  });
});
