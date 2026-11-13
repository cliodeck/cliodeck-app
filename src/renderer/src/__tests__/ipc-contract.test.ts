/**
 * Le contrat IPC, à cliquet (L09-2).
 *
 * `ipcRenderer.invoke` résout toujours, même quand le handler a échoué, et ses réponses sont
 * `any` : le typecheck ne voit ni une propriété lue qui n'existe pas, ni un échec jeté. Les Réglages
 * affichaient « Enregistré » sur un `{ success: false }` ; la barre d'état lisait `data.clients`
 * d'une réponse `{ success, clients }`, et ses indicateurs MCP et Vault ne s'affichaient jamais.
 *
 * Le test analyse l'arbre syntaxique de `src/main/ipc`, `src/preload/index.ts` et
 * `src/renderer/src` (`helpers/ipc-contract-analysis.ts`) et relève :
 *   1. une propriété lue sur la réponse d'un `window.electron.x.y()` et absente des clés que son
 *      handler peut répondre ;
 *   2. un `await window.electron.x.y()` en instruction seule, alors que le handler peut répondre
 *      `success: false` : l'échec est jeté sans être lu, `.catch(…)` chaîné ou non ;
 *   3. un `CustomEvent` émis sans écouteur, ou écouté sans émetteur ;
 *   4. un abonnement du preload (`ipcRenderer.on`) que le renderer ne peut pas défaire.
 *
 * L'existant est gelé dans `ipc-contract.baseline.json` : une entrée par ligne, triée, sans
 * numéro de ligne (`fichier › appel › propriété`). Le test échoue sur une entrée nouvelle, et sur
 * une entrée de la baseline qui ne se produit plus : une entrée corrigée en sort, et n'y revient
 * pas. Un écart assumé se marque `// ipc-ignore: raison` sur la ligne, ou celle d'avant.
 *
 * Ce que le test ne voit pas (il manque des défauts, il n'en invente pas) :
 *   - une réponse lue par une fonction d'aide (`unwrapIpc(r)`, `refusedAsProjectChanged(r)`),
 *     rendue à l'appelant, passée à `.then`, ou rangée dans un store : non suivie ;
 *   - un handler qui répond la valeur d'un service, d'une fonction importée ou d'une variable
 *     d'origine inconnue : ses clés restent ouvertes, aucune lecture n'y est vérifiée ;
 *   - une méthode du preload qui transforme la réponse (`.then`, plusieurs `invoke`) : sautée ;
 *   - un `await` jeté sur un handler dont aucun `success: false` n'est visible, et un appel non
 *     attendu (`window.electron.x.y();`, `void …`). Un `.catch(…)` ou un `.finally(…)` chaîné
 *     avant l'`await` est traversé : il ne lit pas l'échec répondu, le résultat reste jeté ;
 *   - un échec lu sur une seule branche (`if (r.success) { … }`, rien pour l'échec) : la réponse
 *     est lue, le test est content ;
 *   - les propriétés lues au-delà du premier niveau (`r.data.noteCount` : seul `data` compte) ;
 *   - un `CustomEvent` dont le nom est calculé ; un événement dont le nom n'a que des minuscules
 *     (`new Event('refresh')`, `addEventListener('refresh')`), pris pour un événement du DOM.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeIpcContract, type SourceText } from './helpers/ipc-contract-analysis';

const REPO = path.resolve(__dirname, '../../../..');
const BASELINE = path.join(__dirname, 'ipc-contract.baseline.json');

function source(rel: string): SourceText {
  return { path: rel, text: fs.readFileSync(path.join(REPO, rel), 'utf8') };
}

function walk(rel: string): SourceText[] {
  return fs.readdirSync(path.join(REPO, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(child);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [source(child)] : [];
  });
}

/** Les entrées, une par occurrence, triées : la même forme que la baseline. */
function entries(findings: Array<{ entry: string }>): string[] {
  return findings.map((f) => f.entry).sort();
}

/**
 * Le texte de la baseline tel que le test le compare. Les fins de ligne n'y comptent pas : un
 * clone Windows (`core.autocrlf=true`, le réglage par défaut de Git pour Windows) l'extrait en
 * CRLF sans que le contrat ait bougé.
 */
function baselineText(raw: string): string {
  return raw.replace(/\r\n/g, '\n');
}

/** `a` privé de `b`, occurrence par occurrence (une entrée peut revenir plusieurs fois). */
function minus(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const entry of b) left.set(entry, (left.get(entry) ?? 0) + 1);
  return a.filter((entry) => {
    const n = left.get(entry) ?? 0;
    if (n === 0) return true;
    left.set(entry, n - 1);
    return false;
  });
}

// ---------------------------------------------------------------------------
// Chaque règle, sur un exemple écrit pour elle.
// ---------------------------------------------------------------------------

const MAIN: SourceText = {
  path: 'src/main/ipc/handlers/demo-handlers.ts',
  text: `
    function noProject() {
      return { success: false, error: 'no_project' };
    }
    async function readRefusal() {
      if (await configReadable()) return null;
      return errorResponse('config illisible');
    }
    export function registerDemoHandlers() {
      ipcMain.handle('demo:list', async () => {
        const refusal = await readRefusal();
        if (refusal) return refusal;
        return successResponse({ clients: [] });
      });
      ipcMain.handle('demo:status', async () => {
        const root = getRoot();
        if (!root) return noProject();
        return successResponse({ indexed: true, vaultPath: root });
      });
      ipcMain.handle('demo:save', async (_e, value) => {
        try {
          await write(value);
          return outcomeResponse(partial({ saved: 1 }, []));
        } catch (e) {
          return errorResponse(e);
        }
      });
      ipcMain.handle('demo:touch', async () => {
        const response = { success: true, touched: 1 };
        if (late()) response.late = true;
        return response;
      });
      ipcMain.handle('demo:service', async () => service.read());
    }
  `,
};

const PRELOAD: SourceText = {
  path: 'src/preload/index.ts',
  text: `
    const api = {
      demo: {
        list: () => ipcRenderer.invoke('demo:list'),
        status: () => ipcRenderer.invoke('demo:status') as Promise<unknown>,
        save: (value: string) => ipcRenderer.invoke('demo:save', value),
        touch: () => ipcRenderer.invoke('demo:touch'),
        service: () => ipcRenderer.invoke('demo:service'),
        onEvent: (cb: () => void) => {
          const listener = () => cb();
          ipcRenderer.on('demo:event', listener);
          return () => ipcRenderer.removeListener('demo:event', listener);
        },
      },
    };
  `,
};

function analyze(rendererText: string, preload: SourceText = PRELOAD) {
  return analyzeIpcContract({
    main: [MAIN],
    preload,
    renderer: [{ path: 'src/renderer/src/Demo.tsx', text: rendererText }],
  });
}

describe('contrat IPC : chaque règle', () => {
  it('une propriété lue que le handler ne répond pas, même par une fonction du fichier', () => {
    const report = analyze(`
      async function refresh() {
        const mcp = await window.electron.demo.list();
        if (mcp.success && mcp.data?.clients) setClients(mcp.data.clients);
        const vault = await window.electron.demo.status();
        if (vault.success) setVault({ count: vault.noteCount, path: vault.vaultPath });
      }
    `);

    expect(entries(report.findings)).toEqual([
      'src/renderer/src/Demo.tsx › demo.list › .data',
      'src/renderer/src/Demo.tsx › demo.list › .data',
      'src/renderer/src/Demo.tsx › demo.status › .noteCount',
    ]);
  });

  it('suit les alias, la déstructuration et Promise.all', () => {
    const report = analyze(`
      const demo = window.electron.demo;
      async function a() {
        const { clients, total } = await demo.list();
        const [status, saved] = await Promise.all([
          window.electron.demo.status(),
          window.electron.demo.save('x'),
        ]);
        return [clients, total, status.indexed, status.count, saved.saved];
      }
    `);

    expect(entries(report.findings)).toEqual([
      'src/renderer/src/Demo.tsx › demo.list › .total',
      'src/renderer/src/Demo.tsx › demo.status › .count',
    ]);
  });

  it('un échec possible jeté sans lire success, sauf ipc-ignore', () => {
    const report = analyze(`
      async function go() {
        await window.electron.demo.save('x');
        await window.electron.demo.touch();
        // ipc-ignore: l'échec se relit juste après
        await window.electron.demo.save('y');
        await window.electron.demo.service();
      }
    `);

    // `touch` ne répond jamais d'échec ; `service` répond ce que répond un service : non vu.
    expect(entries(report.findings)).toEqual(['src/renderer/src/Demo.tsx › demo.save › résultat jeté']);
  });

  it('un .catch ou un .finally ne lit pas success : le résultat reste jeté, ses lectures comptent', () => {
    // `invoke` résout `{ success: false }` : le `.catch` ne s'exécute jamais sur un échec répondu.
    const report = analyze(`
      async function go() {
        await window.electron.demo.save('a').catch(() => undefined);
        await window.electron.demo.save('b').finally(() => done());
        await (window.electron.demo.save('c') as Promise<unknown>).catch(console.error).finally(done);
        const r = await window.electron.demo.status().catch(() => null);
        const [listed] = await Promise.all([window.electron.demo.list().catch(() => null)]);
        // .then change la valeur : la réponse passe au rappel, qui n'est pas suivi.
        await window.electron.demo.save('d').then((res) => check(res));
        return [r?.noteCount, listed?.data];
      }
    `);

    expect(entries(report.findings)).toEqual([
      'src/renderer/src/Demo.tsx › demo.list › .data',
      'src/renderer/src/Demo.tsx › demo.save › résultat jeté',
      'src/renderer/src/Demo.tsx › demo.save › résultat jeté',
      'src/renderer/src/Demo.tsx › demo.save › résultat jeté',
      'src/renderer/src/Demo.tsx › demo.status › .noteCount',
    ]);
  });

  it("une clé posée après coup compte ; un handler aux clés ouvertes ne se vérifie pas", () => {
    const report = analyze(`
      async function go() {
        const r = await window.electron.demo.touch();
        if (r.late) warn(r.touched);
        const s = await window.electron.demo.service();
        return s.anything;
      }
    `);

    expect(report.findings).toEqual([]);
  });

  it("error n'est lisible que d'un handler qui le répond", () => {
    const report = analyze(`
      async function go() {
        const saved = await window.electron.demo.save('x');
        if (!saved.success) throw new Error(saved.error);
        const r = await window.electron.demo.touch();
        if (!r.success) throw new Error(r.error);
      }
    `);

    expect(entries(report.findings)).toEqual(['src/renderer/src/Demo.tsx › demo.touch › .error']);
  });

  it('un CustomEvent émis sans écouteur, ou écouté sans émetteur ; les événements du DOM à part', () => {
    const report = analyze(`
      window.dispatchEvent(new CustomEvent('show-settings-modal'));
      window.dispatchEvent(new CustomEvent('indexing-end'));
      window.addEventListener('show-settings-modal', open);
      window.addEventListener('switch-panel', go);
      window.addEventListener('keydown', key);
    `);

    expect(entries(report.findings)).toEqual([
      'CustomEvent › indexing-end › émis sans écouteur',
      'CustomEvent › switch-panel › écouté sans émetteur',
    ]);
  });

  it('un abonnement du preload sans désabonnement', () => {
    const leaking: SourceText = {
      path: PRELOAD.path,
      text: PRELOAD.text.replace(
        'onEvent: (cb: () => void) => {',
        "onLeak: (cb: () => void) => { ipcRenderer.on('demo:leak', () => cb()); },\n        onEvent: (cb: () => void) => {"
      ),
    };

    expect(entries(analyze('', PRELOAD).findings)).toEqual([]);
    expect(entries(analyze('', leaking).findings)).toEqual([
      'src/preload/index.ts › demo.onLeak › abonnement sans désabonnement',
    ]);
  });
});

describe('forme de la baseline', () => {
  it('ne dépend pas des fins de ligne du clone (CRLF sous Windows)', () => {
    const lf = `${JSON.stringify(['a › b › .c', 'd › e › résultat jeté'], null, 2)}\n`;

    expect(baselineText(lf)).toBe(lf);
    expect(baselineText(lf.replace(/\n/g, '\r\n'))).toBe(lf);
  });
});

// ---------------------------------------------------------------------------
// Le dépôt, contre la baseline.
// ---------------------------------------------------------------------------

describe('contrat IPC du dépôt (cliquet)', () => {
  const started = performance.now();
  const report = analyzeIpcContract({
    main: walk('src/main/ipc'),
    preload: source('src/preload/index.ts'),
    renderer: walk('src/renderer/src'),
  });
  const elapsed = performance.now() - started;
  const found = entries(report.findings);
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as string[];

  it("trouve un nombre plausible de handlers, de méthodes et d'appels (garde-fou du test lui-même)", () => {
    // Si l'analyse cassait, le test deviendrait vert en ne vérifiant rien.
    expect(report.handlers.size).toBeGreaterThan(150);
    expect([...report.preload.values()].filter((m) => m.channel).length).toBeGreaterThan(150);
    expect(report.resolvedCalls).toBeGreaterThan(150);
    expect(report.checkedReads).toBeGreaterThan(200);
    expect([...report.handlers.values()].filter((h) => !h.open).length).toBeGreaterThan(50);
    expect(elapsed).toBeLessThan(20_000);
  });

  it('la baseline est triée, une entrée par ligne', () => {
    // Triée : deux PR qui retirent chacune leurs entrées ne se disputent pas les mêmes lignes.
    expect(baseline, 'ipc-contract.baseline.json : triez les entrées (ordre de Array.prototype.sort)').toEqual(
      [...baseline].sort()
    );
    expect(baselineText(fs.readFileSync(BASELINE, 'utf8'))).toBe(`${JSON.stringify(baseline, null, 2)}\n`);
  });

  it("aucun écart nouveau au contrat (lecture hors contrat, échec jeté, événement orphelin)", () => {
    const added = minus(found, baseline);
    const pending = [...report.findings];
    const located = added.map((entry) => {
      const finding = pending.splice(pending.findIndex((f) => f.entry === entry), 1)[0];
      return `  ${entry}    (${finding?.where ?? '?'})`;
    });

    expect(
      added,
      `Écart nouveau au contrat IPC :\n${located.join('\n')}\n\n` +
        'Lisez une clé que le handler répond ; lisez success (unwrapIpc, src/renderer/src/utils/ipc-outcome.ts) ' +
        "avant d'utiliser la réponse ; donnez un écouteur à l'événement, ou retirez-le. Un écart assumé : " +
        "`// ipc-ignore: raison` sur la ligne. N'ajoutez pas l'entrée à ipc-contract.baseline.json : elle gèle " +
        "l'existant, elle ne s'allonge pas."
    ).toEqual([]);
  });

  it('aucune entrée de la baseline qui ne se produise plus (cliquet)', () => {
    const gone = minus(baseline, found);

    expect(
      gone,
      `Ces entrées de ipc-contract.baseline.json ne se produisent plus :\n${gone.map((e) => `  ${e}`).join('\n')}\n\n` +
        "Retirez-les de la baseline (une ligne par occurrence) : l'écart est corrigé, il ne doit pas revenir."
    ).toEqual([]);
  });
});
