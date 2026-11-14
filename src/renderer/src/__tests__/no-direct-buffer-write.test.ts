/**
 * Le document ouvert ne change que par la porte (`editorStore.replaceBuffer`).
 *
 * La renumérotation des notes et le renommage du chapitre ouvert écrivaient le texte par
 * `facade.setValue`, chacun avec ses propres gardes, ou dans le miroir du store par `setContent`
 * quand la vue n'était pas montée (L01-6). Ils passent désormais par `replaceBuffer({ kind: 'edit' })`,
 * qui vérifie que le document est toujours celui qu'ils visent et n'écrit que ce qui change. Ce
 * garde-fou empêche le retour d'une écriture directe :
 *
 * - `setValue`, `appendText` et `applyChanges` de la façade, appelés, passés ou extraits par
 *   déstructuration ou entre crochets ;
 * - `useEditorStore.setState` avec `content`, ou dont l'argument ne se lit pas (une variable, un
 *   objet étalé), et tout alias de `useEditorStore.setState` ou de `useEditorStore` lui-même.
 *
 * Seuls `editorStore.ts` (la porte) et `CodeMirrorEditor.tsx` (la vue, qui tient le miroir à jour)
 * y ont droit. Les tests sont hors du champ.
 *
 * Ce qu'il ne voit pas : un nom de méthode calculé (`facade['set' + 'Value']`) ; un `dispatch`
 * direct sur une vue CM6 retrouvée dans le DOM (`EditorView.findFromDOM`) ou par le crochet de
 * développement `__cliodeckProposals` ; un store passé sous un autre type à un fichier qui ne nomme
 * pas `useEditorStore` ; une écriture du fichier ouvert sur le disque par l'IPC
 * (`window.electron.editor.saveFile`), que rien ne distingue ici de celle d'un autre chapitre. Les
 * éditions à la sélection (`editSelection`, `replaceSelection`, `toggleInline`, `propose`) ne
 * remplacent pas le document : elles restent permises. Le dépôt natif de CM6 (un texte glissé d'une
 * autre application) n'en passe par aucune ; une carte de brouillon glissée, elle, ne fait qu'une
 * proposition (D9).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const SCANNED_DIRS = [path.join(ROOT, 'src/renderer/src'), path.join(ROOT, 'src/editor')];
const ALLOWED = new Set(
  ['src/renderer/src/stores/editorStore.ts', 'src/renderer/src/components/Editor/CodeMirrorEditor.tsx'].map((p) =>
    path.join(ROOT, p)
  )
);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(p, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Les commentaires parlent de ces fonctions sans les appeler. `://` (une URL) n'en ouvre pas. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** Le texte entre la parenthèse ouvrante à `open` et sa fermante. */
function argumentAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

const FACADE_WRITERS = '(?:setValue|appendText|applyChanges)';
const RULES: Array<{ name: string; test: (source: string) => number[] }> = [
  {
    // Appel, référence passée plus loin (`.bind`, `.call`) ou chaînage optionnel.
    name: 'écriture par la façade',
    test: (source) => [...source.matchAll(new RegExp(`\\.\\s*${FACADE_WRITERS}\\b`, 'g'))].map((m) => m.index ?? 0),
  },
  {
    name: 'méthode de la façade entre crochets',
    test: (source) =>
      [...source.matchAll(new RegExp(`\\[\\s*['"\`]${FACADE_WRITERS}['"\`]\\s*\\]`, 'g'))].map((m) => m.index ?? 0),
  },
  {
    // `const { setValue } = facade`, ou un paramètre `({ setValue }: EditorFacade)`.
    name: 'méthode de la façade extraite par déstructuration',
    test: (source) =>
      [...source.matchAll(new RegExp(`\\{[^{}]*\\b${FACADE_WRITERS}\\b[^{}]*\\}\\s*[=:]`, 'g'))].map((m) => m.index ?? 0),
  },
  {
    name: 'miroir du store écrit directement',
    test: (source) =>
      [...source.matchAll(/useEditorStore\s*\.\s*setState\s*\(/g)]
        .filter((m) => {
          const arg = argumentAt(source, (m.index ?? 0) + m[0].length - 1);
          return /\bcontent\b|\.\.\./.test(arg) || !/^\s*[({]/.test(arg);
        })
        .map((m) => m.index ?? 0),
  },
  {
    // `const set = useEditorStore.setState`, `.call`, `.bind`, ou entre crochets.
    name: 'alias de useEditorStore.setState',
    test: (source) =>
      [
        ...source.matchAll(/useEditorStore\s*\.\s*setState\b(?!\s*\()/g),
        ...source.matchAll(/useEditorStore\s*\[\s*['"`]setState['"`]\s*\]/g),
        ...source.matchAll(/\{[^{}]*\bsetState\b[^{}]*\}\s*=\s*useEditorStore\b/g),
      ].map((m) => m.index ?? 0),
  },
  {
    // Le store lui-même confié à une variable ou à une fonction : son `setState` échapperait au reste.
    name: 'alias de useEditorStore',
    test: (source) => [
      ...[...source.matchAll(/(?<!typeof\s+)\buseEditorStore\b(?!\s*[.(<:]|\s+as\b)/g)]
        .map((m) => m.index ?? 0)
        .filter((at) => !inModuleList(source, at)),
      // Renommé à l'import (`as`) ou à la déstructuration (`useEditorStore: store`).
      ...[...source.matchAll(/\buseEditorStore\s*(?::|\bas\b)/g)].map((m) => m.index ?? 0),
    ],
  },
];

/**
 * Le nom dans une liste d'import ou d'export (`import { … }`, `export { … } from`), éventuellement sur
 * plusieurs lignes, ou dans un import dynamique (`const { … } = await import(…)`), sous son nom.
 */
function inModuleList(source: string, at: number): boolean {
  const open = source.lastIndexOf('{', at);
  if (open < 0 || source.slice(open, at).includes('}')) return false;
  const close = source.indexOf('}', at);
  if (close < 0) return false;
  return (
    /\b(?:import|export)\s*(?:type\s*)?$/.test(source.slice(0, open)) ||
    /^\s*=\s*await\s+import\s*\(/.test(source.slice(close + 1))
  );
}

function offenses(source: string, label: string): string[] {
  const code = withoutComments(source);
  const lineOf = (at: number) => code.slice(0, at).split('\n').length;
  return RULES.flatMap((rule) =>
    rule
      .test(code)
      .map((at) => `${label}:${lineOf(at)} ${rule.name} : ${code.split('\n')[lineOf(at) - 1].trim().slice(0, 100)}`)
  );
}

describe('le document ouvert ne change que par la porte', () => {
  it('aucune écriture directe hors de editorStore.ts et CodeMirrorEditor.tsx', () => {
    const files = SCANNED_DIRS.flatMap((d) => walk(d));
    expect(files.length).toBeGreaterThan(200);
    const found = files
      .filter((file) => !ALLOWED.has(file))
      .flatMap((file) => offenses(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file)));
    expect(found).toEqual([]);
  });

  it('témoin : la vue, qui tient le miroir à jour, serait vue sans son exemption', () => {
    const view = path.join(ROOT, 'src/renderer/src/components/Editor/CodeMirrorEditor.tsx');
    expect(offenses(fs.readFileSync(view, 'utf8'), 'vue').some((o) => o.includes('miroir du store'))).toBe(true);
  });

  it.each([
    ['appel', 'editorFacade.setValue(text);'],
    ['chaînage optionnel', 'useEditorStore.getState().editorFacade?.appendText(text);'],
    ['changements localisés', 'facade.applyChanges(changes);'],
    ['référence passée', 'const write = facade.setValue.bind(facade);'],
    ['crochets', "facade['setValue'](text);"],
    ['déstructuration', 'const { getValue, setValue } = facade;\nsetValue(x);'],
    ['déstructuration renommée', 'const { setValue: write } = editorFacade;'],
    ['paramètre déstructuré', 'const f = ({ appendText }: EditorFacade) => appendText(x);'],
    ['miroir', 'useEditorStore.setState({ content: text, isDirty: true });'],
    ['miroir, forme fonction', 'useEditorStore.setState((s) => ({ content: s.content + x }));'],
    ['miroir, objet étalé', 'useEditorStore.setState({ ...patch });'],
    ['miroir, argument illisible', 'useEditorStore.setState(patch);'],
    ['alias de setState', 'const set = useEditorStore.setState;\nset({ content: text });'],
    ['setState par call', 'useEditorStore.setState.call(null, { content: text });'],
    ['setState déstructuré', 'const { setState } = useEditorStore;'],
    ['setState entre crochets', "useEditorStore['setState']({ content: text });"],
    ['store confié à une variable', 'const store = useEditorStore;\nstore.setState({ content: text });'],
    ['store passé à une fonction', 'write(useEditorStore, text);'],
    ['store renommé à l’import dynamique', "const { useEditorStore: store } = await import('./editorStore');"],
    ['store renommé à l’import', "import { useEditorStore as store } from './editorStore';"],
  ])('voit une écriture détournée : %s', (_label, snippet) => {
    expect(offenses(snippet, 'extrait')).not.toEqual([]);
  });

  it.each([
    ['setter d’un useState', "const [value, setValue] = useState('');\nsetValue(next);"],
    ['autre champ du store', 'useEditorStore.setState({ lastSavedAt: Date.now() });'],
    ['la porte', "await useEditorStore.getState().replaceBuffer({ kind: 'edit', text }, 'rename-chapter');"],
    ['sélecteur et lecture', 'const filePath = useEditorStore((s) => s.filePath);\nuseEditorStore.getState().getLiveContent();'],
    ['import sur plusieurs lignes', "import {\n  openErrorKey,\n  useEditorStore,\n} from '../../stores/editorStore';"],
    ['réexport', "export { useEditorStore } from './editorStore';"],
    ['import dynamique', "const { useEditorStore, needsFlush } = await import('./editorStore');"],
    ['type', 'type S = ReturnType<typeof useEditorStore.getState>;'],
    ['commentaire', '// facade.setValue(text) écrasait tout\n/* useEditorStore.setState({ content }) */'],
    ['édition à la sélection', 'editorFacade.editSelection(insertAfterSelection(text));'],
  ])('laisse passer : %s', (_label, snippet) => {
    expect(offenses(snippet, 'extrait')).toEqual([]);
  });
});
