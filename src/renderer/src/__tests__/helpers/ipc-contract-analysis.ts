/**
 * Analyse statique du contrat IPC (L09-2), pour `ipc-contract.test.ts`.
 *
 * Le renderer appelle le main par `window.electron.<espace>.<méthode>()`, que le preload relie à
 * un canal (`ipcRenderer.invoke('canal')`), que le main sert par `ipcMain.handle('canal', …)`.
 * `invoke` résout toujours, et ses réponses sont `any` : rien ne vérifiait qu'une propriété lue
 * par le renderer est une propriété que le handler renvoie, ni qu'un échec répondu est lu. La
 * barre d'état lisait `data.clients` d'une réponse `{ success, clients }` : ses indicateurs MCP et
 * Vault ne s'affichaient jamais.
 *
 * L'arbre syntaxique de TypeScript seul, sans vérificateur de types, pour rester à quelques
 * secondes. Ce que l'analyse ne sait pas suivre, elle le laisse ouvert plutôt que de le deviner :
 * elle peut manquer un défaut, elle ne doit pas en inventer.
 */
import ts from 'typescript';

export interface SourceText {
  /** Chemin relatif au dépôt, séparateur `/` : il entre tel quel dans les entrées. */
  path: string;
  text: string;
}

/** Ce qu'un handler peut répondre, autant que l'arbre le montre. */
export interface ResponseShape {
  keys: Set<string>;
  /** Une réponse au moins échappe à l'analyse : ses clés ne se vérifient pas. */
  open: boolean;
  /** Une réponse au moins peut porter `success: false`. */
  canFail: boolean;
}

export interface PreloadMethod {
  /** `fusion.mcp.list` pour `window.electron.fusion.mcp.list`. */
  path: string;
  /** Le canal de son unique `ipcRenderer.invoke`, sinon `null`. */
  channel: string | null;
  /** Rend la réponse de `invoke` telle quelle : ce que lit le renderer est ce que répond le main. */
  direct: boolean;
}

export interface Finding {
  /** L'entrée de la baseline : sans numéro de ligne, qui changerait à chaque PR. */
  entry: string;
  /** Où la voir : fichier et ligne. */
  where: string;
}

export interface ContractReport {
  handlers: Map<string, ResponseShape>;
  preload: Map<string, PreloadMethod>;
  /** Appels `window.electron…` du renderer rattachés à un handler. */
  resolvedCalls: number;
  /** Propriétés lues confrontées aux clés d'un handler (fermé) : ce que la règle 1 vérifie. */
  checkedReads: number;
  findings: Finding[];
}

/** Séparateur des champs d'une entrée. */
const SEP = ' › ';

/** `// ipc-ignore: raison`, sur la ligne de l'appel ou celle d'avant : un écart assumé. */
const IGNORE_RE = /\/\/\s*ipc-ignore:\s*\S/;

/** Les événements du DOM s'écrivent en minuscules ; un `CustomEvent` du projet, jamais. */
function isCustomEventName(name: string): boolean {
  return /[^a-z]/.test(name) && name !== 'DOMContentLoaded';
}

function parse(file: SourceText): ts.SourceFile {
  return ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function lineOf(node: ts.Node): number {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function where(node: ts.Node): string {
  return `${node.getSourceFile().fileName}:${lineOf(node)}`;
}

function ignored(node: ts.Node): boolean {
  const sf = node.getSourceFile();
  const line = lineOf(node) - 1;
  const lines = sf.text.split('\n');
  return IGNORE_RE.test(lines[line] ?? '') || IGNORE_RE.test(lines[line - 1] ?? '');
}

/** Ce qui ne change pas la valeur : parenthèses, `as`, `!`, `satisfies`. */
function isTransparent(node: ts.Node): node is ts.Expression & { expression: ts.Expression } {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

function unwrap(expr: ts.Expression, throughAwait: boolean): ts.Expression {
  let e = expr;
  while (isTransparent(e) || (throughAwait && ts.isAwaitExpression(e))) e = e.expression;
  return e;
}

function stringLiteral(expr: ts.Expression | undefined): string | null {
  if (!expr) return null;
  const e = unwrap(expr, false);
  return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : null;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return null;
  if (ts.isComputedPropertyName(name)) return stringLiteral(name.expression);
  return null;
}

/** `ipcRenderer.invoke(…)`, `ipcMain.handle(…)` : un appel de méthode sur un nom donné. */
function isMethodCall(node: ts.Node, object: string, methods: readonly string[]): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression, false);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === object &&
    methods.includes(callee.name.text)
  );
}

function visitAll(root: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}

type FunctionNode = ts.FunctionLikeDeclaration;

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

// ---------------------------------------------------------------------------
// Portée : retrouver la déclaration d'un nom, sans vérificateur de types.
// ---------------------------------------------------------------------------

type Declaration =
  | ts.VariableDeclaration
  | ts.BindingElement
  | ts.ParameterDeclaration
  | ts.FunctionDeclaration;

function bindingNamed(name: ts.BindingName, wanted: string): ts.Identifier | null {
  if (ts.isIdentifier(name)) return name.text === wanted ? name : null;
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    const hit = bindingNamed(element.name, wanted);
    if (hit) return hit;
  }
  return null;
}

/** La déclaration qui porte `id` (la variable entière, ou l'élément d'une déstructuration). */
function declarationOf(id: ts.Identifier): Declaration | null {
  const parent = id.parent;
  if (ts.isBindingElement(parent) && parent.name === id) return parent;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === id) return parent;
  if (ts.isFunctionDeclaration(parent) && parent.name === id) return parent;
  return null;
}

function statementsOf(node: ts.Node): readonly ts.Statement[] | null {
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) return node.statements;
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
  return null;
}

/** La déclaration la plus proche de `name`, en remontant depuis `from`. */
function findDeclaration(name: string, from: ts.Node): Declaration | null {
  for (let node: ts.Node | undefined = from.parent; node; node = node.parent) {
    if (isFunctionNode(node)) {
      for (const parameter of node.parameters) {
        const hit = bindingNamed(parameter.name, name);
        if (hit) return declarationOf(hit);
      }
      if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name?.text === name) {
        return ts.isFunctionDeclaration(node) ? node : null;
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const hit = bindingNamed(node.variableDeclaration.name, name);
      if (hit) return declarationOf(hit);
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node)) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      for (const declaration of node.initializer.declarations) {
        const hit = bindingNamed(declaration.name, name);
        if (hit) return declarationOf(hit);
      }
    }
    const statements = statementsOf(node);
    if (!statements) continue;
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const hit = bindingNamed(declaration.name, name);
        if (hit) return declarationOf(hit);
      }
    }
  }
  return null;
}

/** Le bloc où vit une variable : là où chercher ses lectures. */
function scopeOf(declaration: Declaration): ts.Node {
  for (let node: ts.Node | undefined = declaration.parent; node; node = node.parent) {
    if (statementsOf(node) || isFunctionNode(node)) return node;
  }
  return declaration.getSourceFile();
}

/** La variable est-elle réaffectée quelque part dans sa portée ? */
function isReassigned(declaration: Declaration, name: string): boolean {
  let reassigned = false;
  visitAll(scopeOf(declaration), (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      node.left.text === name &&
      findDeclaration(name, node.left) === declaration
    ) {
      reassigned = true;
    }
  });
  return reassigned;
}

function functionOf(declaration: Declaration | null): FunctionNode | null {
  if (!declaration) return null;
  if (ts.isFunctionDeclaration(declaration)) return declaration;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const init = unwrap(declaration.initializer, false);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Côté main : les clés que chaque handler peut répondre.
// ---------------------------------------------------------------------------

function emptyShape(): ResponseShape {
  return { keys: new Set(), open: false, canFail: false };
}

function openShape(): ResponseShape {
  return { keys: new Set(), open: true, canFail: false };
}

function merge(into: ResponseShape, from: ResponseShape): ResponseShape {
  for (const key of from.keys) into.keys.add(key);
  into.open ||= from.open;
  into.canFail ||= from.canFail;
  return into;
}

function withKeys(shape: ResponseShape, keys: readonly string[], canFail = false): ResponseShape {
  for (const key of keys) shape.keys.add(key);
  shape.canFail ||= canFail;
  return shape;
}

/** Les expressions rendues par une fonction, sans descendre dans ses fonctions internes. */
function returnedExpressions(fn: FunctionNode): Array<ts.Expression | undefined> {
  if (!fn.body) return [undefined];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: Array<ts.Expression | undefined> = [];
  const walk = (node: ts.Node): void => {
    if (isFunctionNode(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node)) out.push(node.expression);
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(fn.body, walk);
  return out;
}

class ResponseEvaluator {
  private readonly inProgress = new Set<ts.Node>();

  ofFunction(fn: FunctionNode): ResponseShape {
    // Une fonction qui se rappelle elle-même : la boucle se ferme sur « inconnu ».
    if (this.inProgress.has(fn)) return openShape();
    this.inProgress.add(fn);
    try {
      const shape = emptyShape();
      for (const expr of returnedExpressions(fn)) {
        if (expr) merge(shape, this.ofExpression(expr));
      }
      return shape;
    } finally {
      this.inProgress.delete(fn);
    }
  }

  ofExpression(expression: ts.Expression): ResponseShape {
    const e = unwrap(expression, true);
    if (ts.isObjectLiteralExpression(e)) return this.ofObject(e);
    if (ts.isConditionalExpression(e)) {
      return merge(this.ofExpression(e.whenTrue), this.ofExpression(e.whenFalse));
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      // `a && {…}` : à gauche, une valeur fausse, rien à étaler.
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.CommaToken) {
        return this.ofExpression(e.right);
      }
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        return merge(this.ofExpression(e.left), this.ofExpression(e.right));
      }
      return openShape();
    }
    if (ts.isCallExpression(e)) return this.ofCall(e);
    if (ts.isIdentifier(e)) return this.ofIdentifier(e);
    if (e.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(e)) return emptyShape();
    // Tableau, chaîne, nombre, appel de méthode d'un service… : pas une enveloppe lisible.
    return openShape();
  }

  private ofObject(object: ts.ObjectLiteralExpression): ResponseShape {
    const shape = emptyShape();
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        merge(shape, this.ofExpression(property.expression));
        continue;
      }
      const name = property.name ? propertyName(property.name) : null;
      if (name === null) {
        shape.open = true;
        continue;
      }
      shape.keys.add(name);
      if (name === 'success') {
        const value = ts.isPropertyAssignment(property) ? unwrap(property.initializer, false) : null;
        if (!value || value.kind !== ts.SyntaxKind.TrueKeyword) shape.canFail = true;
      }
    }
    return shape;
  }

  private ofCall(call: ts.CallExpression): ResponseShape {
    const callee = unwrap(call.expression, false);
    if (!ts.isIdentifier(callee)) return openShape();
    const [first] = call.arguments;
    // Les clés qu'écrivent les fonctions de `src/main/ipc/utils/error-handler.ts` : à tenir à
    // jour avec elles (une clé qu'`errorResponse` ajouterait se lirait ici comme absente).
    switch (callee.text) {
      case 'successResponse':
        return withKeys(first ? this.ofExpression(first) : emptyShape(), ['success']);
      case 'errorResponse':
        return withKeys(emptyShape(), ['success', 'error'], true);
      case 'outcomeResponse':
        return first ? this.ofOutcome(first) : openShape();
    }
    const fn = functionOf(findDeclaration(callee.text, callee));
    return fn ? this.ofFunction(fn) : openShape();
  }

  /** `outcomeResponse(ok(…))`, `partial(…)`, `failed(…)` : la forme étalée de l'Outcome. */
  private ofOutcome(arg: ts.Expression): ResponseShape {
    const failure = ['success', 'error', 'errorCode', 'errorParams'];
    const e = unwrap(arg, true);
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      const [value] = e.arguments;
      switch (e.expression.text) {
        case 'ok':
          return withKeys(value ? this.ofExpression(value) : openShape(), ['success']);
        case 'partial':
          return withKeys(value ? this.ofExpression(value) : openShape(), ['success', 'warnings']);
        case 'failed':
          return withKeys(emptyShape(), failure, true);
      }
    }
    return withKeys(openShape(), [...failure, 'warnings'], true);
  }

  /** Une variable : sa valeur initiale, plus les clés qu'on lui pose ensuite (`r.extra = …`). */
  private ofIdentifier(id: ts.Identifier): ResponseShape {
    if (id.text === 'undefined') return emptyShape();
    const declaration = findDeclaration(id.text, id);
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      return openShape();
    }
    if (isReassigned(declaration, id.text)) return openShape();
    const shape = this.ofExpression(declaration.initializer);
    visitAll(scopeOf(declaration), (node) => {
      if (!ts.isIdentifier(node) || node.text !== id.text || node === declaration.name) return;
      if (findDeclaration(id.text, node) !== declaration) return;
      const parent = node.parent;
      const assigned =
        ts.isBinaryExpression(parent.parent) &&
        parent.parent.left === parent &&
        parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node && assigned) {
        shape.keys.add(parent.name.text);
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node && assigned) {
        const key = stringLiteral(parent.argumentExpression);
        if (key === null) shape.open = true;
        else shape.keys.add(key);
      } else if (ts.isCallExpression(parent) && isMethodCall(parent, 'Object', ['assign'])) {
        shape.open = true;
      }
    });
    return shape;
  }
}

function collectHandlers(main: SourceText[]): Map<string, ResponseShape> {
  const handlers = new Map<string, ResponseShape>();
  const evaluator = new ResponseEvaluator();
  for (const file of main) {
    visitAll(parse(file), (node) => {
      if (!isMethodCall(node, 'ipcMain', ['handle', 'handleOnce'])) return;
      const channel = stringLiteral(node.arguments[0]);
      const handler = node.arguments[1];
      if (channel === null || !handler) return;
      let shape: ResponseShape;
      const h = unwrap(handler, false);
      if (isFunctionNode(h)) {
        shape = evaluator.ofFunction(h);
      } else if (ts.isIdentifier(h)) {
        const fn = functionOf(findDeclaration(h.text, h));
        shape = fn ? evaluator.ofFunction(fn) : openShape();
      } else if (
        ts.isCallExpression(h) &&
        ts.isIdentifier(h.expression) &&
        h.expression.text === 'wrapIPCHandler' &&
        h.arguments[0]
      ) {
        // `{ success: true, ...résultat }`, ou `errorResponse` sur une exception.
        const inner = unwrap(h.arguments[0], false);
        const fn = isFunctionNode(inner)
          ? inner
          : ts.isIdentifier(inner)
            ? functionOf(findDeclaration(inner.text, inner))
            : null;
        shape = withKeys(fn ? evaluator.ofFunction(fn) : openShape(), ['success', 'error'], true);
      } else {
        shape = openShape();
      }
      const previous = handlers.get(channel);
      handlers.set(channel, previous ? merge(previous, shape) : shape);
    });
  }
  return handlers;
}

// ---------------------------------------------------------------------------
// Preload : le chemin `window.electron.…` de chaque méthode, et son canal.
// ---------------------------------------------------------------------------

function collectPreload(preload: SourceText, findings: Finding[]): Map<string, PreloadMethod> {
  const methods = new Map<string, PreloadMethod>();
  // `const api = { … }`, exposé par `contextBridge.exposeInMainWorld('electron', api)`.
  const apiObjects: ts.ObjectLiteralExpression[] = [];
  visitAll(parse(preload), (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== 'api') return;
    const value = node.initializer && unwrap(node.initializer, false);
    if (value && ts.isObjectLiteralExpression(value)) apiObjects.push(value);
  });
  const [api] = apiObjects;
  if (!api) return methods;

  const method = (path: string, fn: FunctionNode): void => {
    const invokes: ts.CallExpression[] = [];
    let subscribes = false;
    let unsubscribes = false;
    visitAll(fn, (node) => {
      if (isMethodCall(node, 'ipcRenderer', ['invoke'])) invokes.push(node);
      if (isMethodCall(node, 'ipcRenderer', ['on', 'once'])) subscribes = true;
      if (isMethodCall(node, 'ipcRenderer', ['removeListener', 'removeAllListeners', 'off'])) {
        unsubscribes = true;
      }
    });
    const channel = invokes.length === 1 ? stringLiteral(invokes[0].arguments[0]) : null;
    const returned = returnedExpressions(fn);
    const direct =
      channel !== null &&
      returned.length === 1 &&
      returned[0] !== undefined &&
      unwrap(returned[0], true) === invokes[0];
    methods.set(path, { path, channel, direct });
    // Un abonnement que le renderer ne peut pas défaire s'accumule à chaque montage.
    if (subscribes && !unsubscribes && !ignored(fn)) {
      findings.push({
        entry: [preload.path, path, 'abonnement sans désabonnement'].join(SEP),
        where: where(fn),
      });
    }
  };

  const walk = (object: ts.ObjectLiteralExpression, prefix: string): void => {
    for (const property of object.properties) {
      if (!property.name) continue;
      const name = propertyName(property.name);
      if (name === null) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      if (ts.isMethodDeclaration(property)) {
        method(path, property);
      } else if (ts.isPropertyAssignment(property)) {
        const value = unwrap(property.initializer, false);
        if (ts.isObjectLiteralExpression(value)) walk(value, path);
        else if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) method(path, value);
      }
    }
  };
  walk(api, '');
  return methods;
}

// ---------------------------------------------------------------------------
// Renderer : chaque appel, et ce qu'il fait de la réponse.
// ---------------------------------------------------------------------------

/**
 * Le chemin `window.electron.<…>` d'une expression, alias compris
 * (`const fusion = window.electron.fusion`, `const { hints } = window.electron.fusion`).
 */
function electronPath(expression: ts.Expression, seen = new Set<ts.Node>()): string[] | null {
  const e = unwrap(expression, false);
  if (ts.isPropertyAccessExpression(e)) {
    if (ts.isIdentifier(e.expression) && e.expression.text === 'window' && e.name.text === 'electron') {
      return [];
    }
    const base = electronPath(e.expression, seen);
    return base ? [...base, e.name.text] : null;
  }
  if (ts.isElementAccessExpression(e)) {
    const key = stringLiteral(e.argumentExpression);
    const base = key === null ? null : electronPath(e.expression, seen);
    return base && key !== null ? [...base, key] : null;
  }
  if (!ts.isIdentifier(e)) return null;
  const declaration = findDeclaration(e.text, e);
  if (!declaration || seen.has(declaration)) return null;
  seen.add(declaration);
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return electronPath(declaration.initializer, seen);
  }
  if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
    const variable = declaration.parent.parent;
    if (!ts.isVariableDeclaration(variable) || !variable.initializer || declaration.dotDotDotToken) {
      return null;
    }
    const key = declaration.propertyName
      ? propertyName(declaration.propertyName)
      : ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : null;
    const base = key === null ? null : electronPath(variable.initializer, seen);
    return base && key !== null ? [...base, key] : null;
  }
  return null;
}

/** Une propriété lue sur la réponse, et où. */
interface Read {
  property: string;
  node: ts.Node;
}

/** Les propriétés lues sur une variable, dans sa portée ; `null` si on la perd de vue. */
function readsOf(declaration: ts.VariableDeclaration | ts.BindingElement, name: string): Read[] | null {
  if (isReassigned(declaration, name)) return null;
  const reads: Read[] = [];
  let lost = false;
  visitAll(scopeOf(declaration), (node) => {
    if (!ts.isIdentifier(node) || node.text !== name || node === declaration.name) return;
    if (findDeclaration(name, node) !== declaration) return;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      reads.push({ property: parent.name.text, node: parent.name });
    } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      const key = stringLiteral(parent.argumentExpression);
      if (key === null) lost = true;
      else reads.push({ property: key, node: parent.argumentExpression });
    } else if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === node &&
      ts.isObjectBindingPattern(parent.name)
    ) {
      const destructured = destructuredReads(parent.name);
      if (destructured === null) lost = true;
      else reads.push(...destructured);
    }
  });
  return lost ? null : reads;
}

/** `const { a, b: c } = …` : les clés lues (`a`, `b`) ; `null` avec un reste (`...autres`). */
function destructuredReads(pattern: ts.ObjectBindingPattern): Read[] | null {
  const reads: Read[] = [];
  for (const element of pattern.elements) {
    if (element.dotDotDotToken) return null;
    const key = element.propertyName ?? element.name;
    const property = ts.isIdentifier(key) ? key.text : ts.isStringLiteral(key) ? key.text : null;
    if (property === null) return null;
    reads.push({ property, node: key });
  }
  return reads;
}

interface RendererCall {
  call: ts.CallExpression;
  method: PreloadMethod;
  handler: ResponseShape;
}

/**
 * Ce que l'appelant fait de la réponse. `await` en instruction seule : jetée. `const r = await` ou
 * `const { a } = await` : les propriétés lues. `Promise.all([…])` déstructuré : chacune.
 * Le reste (`.then`, réponse passée à une fonction, rendue) n'est pas suivi.
 */
function followResponse(call: ts.CallExpression): { discarded: boolean; reads: Read[] | null } {
  let top: ts.Expression = call;
  let awaited = false;
  for (;;) {
    const parent: ts.Node = top.parent;
    if (isTransparent(parent)) top = parent;
    else if (ts.isAwaitExpression(parent)) {
      awaited = true;
      top = parent;
    } else break;
  }
  const parent = top.parent;
  if (awaited && ts.isExpressionStatement(parent)) return { discarded: true, reads: [] };
  if (awaited && ts.isPropertyAccessExpression(parent) && parent.expression === top) {
    return { discarded: false, reads: [{ property: parent.name.text, node: parent.name }] };
  }
  if (awaited && ts.isVariableDeclaration(parent) && parent.initializer === top) {
    if (ts.isIdentifier(parent.name)) return { discarded: false, reads: readsOf(parent, parent.name.text) };
    if (ts.isObjectBindingPattern(parent.name)) {
      return { discarded: false, reads: destructuredReads(parent.name) };
    }
    return { discarded: false, reads: null };
  }
  // `const [a, b] = await Promise.all([appel, appel])`
  if (!awaited && ts.isArrayLiteralExpression(parent)) {
    const all = parent.parent;
    if (
      ts.isCallExpression(all) &&
      isMethodCall(all, 'Promise', ['all']) &&
      all.arguments[0] === parent
    ) {
      let outer: ts.Node = all;
      while (isTransparent(outer.parent) || ts.isAwaitExpression(outer.parent)) outer = outer.parent;
      const declaration = outer.parent;
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer === outer &&
        ts.isArrayBindingPattern(declaration.name)
      ) {
        const element = declaration.name.elements[parent.elements.indexOf(top)];
        if (!element || ts.isOmittedExpression(element)) return { discarded: false, reads: [] };
        if (ts.isIdentifier(element.name)) {
          return { discarded: false, reads: readsOf(element, element.name.text) };
        }
        if (ts.isObjectBindingPattern(element.name)) {
          return { discarded: false, reads: destructuredReads(element.name) };
        }
      }
    }
  }
  return { discarded: false, reads: null };
}

function collectCalls(
  file: ts.SourceFile,
  preload: Map<string, PreloadMethod>,
  handlers: Map<string, ResponseShape>
): RendererCall[] {
  const calls: RendererCall[] = [];
  visitAll(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const path = electronPath(node.expression);
    if (!path || path.length === 0) return;
    const method = preload.get(path.join('.'));
    if (!method || !method.channel || !method.direct) return;
    const handler = handlers.get(method.channel);
    if (!handler) return;
    calls.push({ call: node, method, handler });
  });
  return calls;
}

// ---------------------------------------------------------------------------
// L'analyse entière.
// ---------------------------------------------------------------------------

export function analyzeIpcContract(input: {
  main: SourceText[];
  preload: SourceText;
  renderer: SourceText[];
}): ContractReport {
  const findings: Finding[] = [];
  const handlers = collectHandlers(input.main);
  const preload = collectPreload(input.preload, findings);
  let resolvedCalls = 0;
  let checkedReads = 0;
  const emitted = new Map<string, ts.Node>();
  const listened = new Map<string, ts.Node>();

  for (const source of input.renderer) {
    if (!/window\.electron|CustomEvent|addEventListener/.test(source.text)) continue;
    const file = parse(source);

    for (const { call, method, handler } of collectCalls(file, preload, handlers)) {
      resolvedCalls += 1;
      if (ignored(call)) continue;
      const { discarded, reads } = followResponse(call);
      if (discarded && handler.canFail) {
        findings.push({ entry: [source.path, method.path, 'résultat jeté'].join(SEP), where: where(call) });
      }
      if (!reads || handler.open) continue;
      for (const { property, node } of reads) {
        checkedReads += 1;
        if (handler.keys.has(property) || ignored(node)) continue;
        findings.push({ entry: [source.path, method.path, `.${property}`].join(SEP), where: where(node) });
      }
    }

    visitAll(file, (node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const kind = node.expression.text;
        const name = stringLiteral(node.arguments?.[0]);
        if (name !== null && (kind === 'CustomEvent' || (kind === 'Event' && isCustomEventName(name)))) {
          if (!emitted.has(name)) emitted.set(name, node);
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(unwrap(node.expression, false)) &&
        (unwrap(node.expression, false) as ts.PropertyAccessExpression).name.text === 'addEventListener'
      ) {
        const name = stringLiteral(node.arguments[0]);
        if (name !== null && !listened.has(name)) listened.set(name, node);
      }
    });
  }

  for (const [name, node] of emitted) {
    if (!listened.has(name) && !ignored(node)) {
      findings.push({ entry: ['CustomEvent', name, 'émis sans écouteur'].join(SEP), where: where(node) });
    }
  }
  for (const [name, node] of listened) {
    if (isCustomEventName(name) && !emitted.has(name) && !ignored(node)) {
      findings.push({ entry: ['CustomEvent', name, 'écouté sans émetteur'].join(SEP), where: where(node) });
    }
  }

  return { handlers, preload, resolvedCalls, checkedReads, findings };
}
