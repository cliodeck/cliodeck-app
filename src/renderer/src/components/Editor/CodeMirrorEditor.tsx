import React, { useEffect, useRef } from 'react';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  HighlightStyle,
  bracketMatching,
  syntaxHighlighting,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { createDocState, readDocText, toDocLineBreaks, toDocText } from '@/editor/cm/fidelity';
import { restoreEditorState, serializeEditorState } from '@/editor/cm/state-cache';
import {
  liveRender,
  liveRenderRefresh,
  type ResolvedCitation,
} from '@/editor/cm/live-render';
import { scholarly, type CitationCandidate } from '@/editor/cm/scholarly';
import { scholarlyMarkdown } from '@/editor/lezer-extensions';
import { changeOrigin, changeOriginGuard } from '@/editor/cm/change-origin';
import { editSelection, toggleInlineMark } from '@/editor/cm/inline-formatting';
import {
  proposals,
  type Proposal,
  type ProposalsInstance,
} from '@/editor/proposals';
import type { EditorFacade } from '@/editor/facade';
import { editorStateKey, editorStates } from './editor-state-memory';
import { recordAdjudication } from './proposals-ipc';
import { normalizeInsertPayload } from './insert-payload';
import { useEditorStore, type EditorSettings } from '../../stores/editorStore';

import { useProjectStore } from '../../stores/projectStore';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from 'react-i18next';
import './CodeMirrorEditor.css';

/**
 * Wrapper React minimal autour de CodeMirror 6 (plan CM6, Phase 1).
 *
 * Règles d'architecture (décision cadre + risque n°2 du plan) :
 * - l'état vit dans CM6, jamais dans React : aucun `value` contrôlé, aucun
 *   re-render déclenché par la frappe ;
 * - la synchronisation vers le store est debouncée (SYNC_DEBOUNCE_MS) ; la
 *   sauvegarde lit l'éditeur directement via la façade (`getLiveContent`) ;
 * - les remplacements externes du document arrivent par recréation de l'état
 *   (signal `documentVersion`) ou par la façade — jamais par observation de
 *   `content`.
 */

const SYNC_DEBOUNCE_MS = 300;

// Délai court : assez long pour absorber la frappe, assez court pour que
// DocumentStats / la preview Slides restent « frais » à l'œil nu.

/**
 * Résout la source d'une image du document vers une URL chargeable : les
 * chemins relatifs le sont par rapport au fichier ouvert. `null` (pas de
 * fichier, chemin irrésoluble) → placeholder du widget.
 */
function resolveImageSrc(src: string): string | null {
  if (/^(https?:|data:|file:)/.test(src)) return src;
  const { filePath } = useEditorStore.getState();
  if (!filePath) return null;
  const slash = filePath.lastIndexOf('/');
  if (slash < 0) return null;
  const abs = src.startsWith('/') ? src : filePath.slice(0, slash + 1) + src;
  return encodeURI('file://' + abs);
}

/**
 * Résolution des clés de citation contre la bibliographie du store, avec un
 * cache invalidé par identité du tableau `citations` (le rendu live résout
 * chaque clé du viewport à chaque recalcul).
 */
let citationCache: {
  source: unknown;
  map: Map<string, ResolvedCitation>;
} | null = null;

function resolveCitation(key: string): ResolvedCitation | null {
  const { citations } = useBibliographyStore.getState();
  if (!citationCache || citationCache.source !== citations) {
    const map = new Map<string, ResolvedCitation>();
    for (const c of citations) {
      map.set(c.id, { author: c.author, year: c.year, title: c.title });
    }
    citationCache = { source: citations, map };
  }
  return citationCache.map.get(key) ?? null;
}

function getCitations(): CitationCandidate[] {
  return useBibliographyStore.getState().citations.map((c) => ({
    id: c.id,
    author: c.author,
    year: c.year,
    title: c.title,
  }));
}

function getFontFamily(fontFamily: string): string {
  switch (fontFamily) {
    case 'jetbrains':
      return "'JetBrains Mono', 'Consolas', monospace";
    case 'fira':
      return "'Fira Code', 'Consolas', monospace";
    case 'source':
      return "'Source Code Pro', 'Consolas', monospace";
    case 'cascadia':
      return "'Cascadia Code', 'Consolas', monospace";
    // Polices de prose (#12) : ClioDeck édite des manuscrits, pas du code —
    // piles système, rien à installer.
    case 'serif':
      return "'Iowan Old Style', 'Palatino', 'Georgia', 'Times New Roman', serif";
    case 'sans':
      return "-apple-system, 'Segoe UI', 'Helvetica Neue', 'Arial', sans-serif";
    case 'system':
    default:
      return "'SF Mono', 'Monaco', 'Consolas', 'Ubuntu Mono', monospace";
  }
}

// Thème structurel sur les tokens CSS de ClioDeck : les variables suivent le
// thème clair/sombre de l'app, une seule définition suffit.
const cliodeckTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--bg-panel)',
    color: 'var(--text-primary)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    caretColor: 'var(--color-accent)',
    padding: '16px 8px',
  },
  '.cm-placeholder': { color: 'var(--text-tertiary)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    {
      backgroundColor:
        'color-mix(in srgb, var(--color-accent) 22%, transparent)',
    },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-panel)',
    color: 'var(--text-tertiary)',
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-app)',
    color: 'var(--text-primary)',
    borderColor: 'var(--border-color)',
  },
  '.cm-searchMatch': {
    backgroundColor:
      'color-mix(in srgb, var(--color-accent) 30%, transparent)',
  },
});

// Coloration markdown minimale (Phase 1 : éditeur « source »). Le rendu live
// arrive en Phase 2 par décorations, pas par styles de tokens.
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--color-accent)' },
  { tag: tags.url, color: 'var(--text-tertiary)' },
  { tag: tags.monospace, color: 'var(--text-secondary)' },
  { tag: tags.quote, color: 'var(--text-secondary)', fontStyle: 'italic' },
  { tag: tags.contentSeparator, color: 'var(--text-tertiary)' },
  { tag: tags.meta, color: 'var(--text-tertiary)' },
  { tag: tags.processingInstruction, color: 'var(--text-tertiary)' },
  { tag: tags.labelName, color: 'var(--color-accent)' },
]);

// Raccourcis de formatage historiques de ClioDeck. Placé avant
// defaultKeymap pour prendre la priorité. Les mêmes que le menu natif
// (`src/main/menu.ts`) : le bloc citation y est Cmd+Option+Q sous macOS,
// où Cmd+Maj+Q ferme la session : le troisième élément est la touche macOS.
type FormattingBinding = readonly [
  string,
  Parameters<ReturnType<typeof useEditorStore.getState>['insertFormatting']>[0],
  string?,
];
const formattingKeymap = keymap.of(
  (
    [
      ['Mod-b', 'bold'],
      ['Mod-i', 'italic'],
      ['Mod-l', 'link'],
      ["Mod-'", 'citation'],
      ['Mod-Shift-t', 'table'],
      ['Mod-Shift-f', 'footnote'],
      ['Mod-Shift-q', 'blockquote', 'Mod-Alt-q'],
    ] satisfies ReadonlyArray<FormattingBinding>
  ).map(([key, type, mac]: FormattingBinding) => ({
    key,
    mac,
    run: () => {
      useEditorStore.getState().insertFormatting(type);
      return true;
    },
  }))
);

function dynamicExtensions(settings: EditorSettings, dark: boolean): Extension {
  return [
    EditorView.darkTheme.of(dark),
    settings.wordWrap ? EditorView.lineWrapping : [],
    EditorView.theme({
      '&': { fontSize: `${settings.fontSize}px` },
      '.cm-content': { fontFamily: getFontFamily(settings.fontFamily) },
    }),
  ];
}

/** Le focus n'est nulle part, ou sur l'onglet du mode qu'on vient de choisir : rien à lui prendre. */
function focusIsFree(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active.closest('.workspace-mode-bar') !== null;
}

function createFacade(
  view: EditorView,
  changeListeners: Set<(content: string) => void>,
  selectionListeners: Set<(offset: number) => void>,
  proposalsInstance: ProposalsInstance,
  hasKnownCursor: () => boolean,
  cancelScrollRestore: () => void,
  isSlideDeck: boolean
): EditorFacade {
  return {
    engine: 'cm6',
    isSlideDeck,
    getValue: () => readDocText(view.state),
    getCursorOffset: () => view.state.selection.main.head,
    hasKnownCursor,
    getSelectionText: () => {
      const { from, to } = view.state.selection.main;
      return from === to ? null : view.state.sliceDoc(from, to);
    },
    hasFocus: () => view.root.activeElement === view.contentDOM,
    toggleInline: (type, placeholder) => {
      toggleInlineMark(view, type, placeholder);
    },
    editSelection: (edit, origin) => editSelection(view, edit, origin),
    replaceSelection: (text, origin) => {
      if (view.state.readOnly) return;
      view.dispatch({
        ...view.state.replaceSelection(toDocText(text)),
        annotations: changeOrigin.of(origin ?? 'programmatic'),
      });
      view.focus();
    },
    setValue: (text, cursorOffset, origin) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection:
          cursorOffset !== undefined
            ? EditorSelection.cursor(Math.max(0, Math.min(cursorOffset, text.length)))
            : undefined,
        annotations: changeOrigin.of(origin ?? 'programmatic'),
      });
    },
    appendText: (text, origin) => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        annotations: changeOrigin.of(origin ?? 'programmatic'),
      });
    },
    propose: (partial) => {
      // L'effet passerait, pas le texte : accepter journaliserait une décision sans rien écrire.
      if (view.state.readOnly) return false;
      cancelScrollRestore();
      const { range } = proposalsInstance.inject(view, partial);
      const { head } = view.state.selection.main;
      view.dispatch({
        ...(head < range.from || head > range.to ? { selection: EditorSelection.cursor(range.from) } : {}),
        effects: EditorView.scrollIntoView(range.to, { y: 'center' }),
      });
      return true;
    },
    revealLine: (lineNumber) => {
      cancelScrollRestore();
      const line = view.state.doc.line(
        Math.max(1, Math.min(lineNumber, view.state.doc.lines))
      );
      view.dispatch({
        selection: EditorSelection.cursor(line.from),
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      });
      view.focus();
    },
    focus: () => view.focus(),
    onContentChange: (callback) => {
      changeListeners.add(callback);
      return () => changeListeners.delete(callback);
    },
    onSelectionChange: (callback) => {
      selectionListeners.add(callback);
      return () => selectionListeners.delete(callback);
    },
  };
}

export const CodeMirrorEditor: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const proposalsRef = useRef<ProposalsInstance | null>(null);
  const dynamicCompartment = useRef(new Compartment()).current;

  const documentVersion = useEditorStore((s) => s.documentVersion);
  const settings = useEditorStore((s) => s.settings);
  // Projet presentation : le rendu live traite `---` comme frontière de
  // slide numérotée, pas comme règle horizontale (chantier slides).
  const isPresentation = useProjectStore(
    (s) => s.currentProject?.type === 'presentation'
  );
  const { currentTheme } = useTheme();
  const { t } = useTranslation('common');

  // Création / recréation de la vue : au montage et à chaque remplacement du
  // document (`documentVersion`). Pas sur le chemin : le premier enregistrement
  // d'un tampon sans titre le change sans changer le document.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const store = useEditorStore.getState();
    // Document auquel CETTE vue appartient : une vue qui n'en est plus
    // propriétaire n'écrit jamais dans le store. Sinon, sur une bascule de
    // fichier, elle ferait afficher — puis sauvegarder — le texte sortant sous
    // le nom du fichier entrant (écrasement silencieux). Le chemin ne dirait
    // rien quand on relit le même fichier.
    const ownVersion = store.documentVersion;
    const ownsDocument = () => useEditorStore.getState().documentVersion === ownVersion;
    // Suivi tant que la version ne change pas : `saveFileAs` donne un chemin au
    // document sans le remplacer.
    let ownFilePath = store.filePath;
    const detached = store.bufferDetached;
    const changeListeners = new Set<(content: string) => void>();
    const selectionListeners = new Set<(offset: number) => void>();
    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingSync = false;
    // Un clic là où le curseur se trouve déjà ne déplace aucune sélection.
    let cursorPlaced = false;

    // `isDirty` n'est posé que si le texte diffère du miroir : la sauvegarde a pu
    // passer avant cette synchro debouncée, et le reposer 300 ms après elle
    // annoncerait des modifications qui sont déjà sur le disque.
    const pushToMirror = (view: EditorView): string => {
      const content = readDocText(view.state);
      const { content: mirror, isDirty } = useEditorStore.getState();
      useEditorStore.setState({ content, isDirty: isDirty || content !== mirror });
      return content;
    };

    const syncToStore = (view: EditorView) => {
      pendingSync = false;
      if (!ownsDocument()) return;
      const content = pushToMirror(view);
      for (const listener of changeListeners) listener(content);
    };

    // Contrat propositionnel (Phase 4b) : les adjudications partent vers le
    // main (routage journaux) via l'accesseur défensif. Contexte propre à la
    // vue : l'événement `expired` émis par view.destroy() part APRÈS que les
    // stores portent le nouveau chapitre/projet — le lire à ce moment
    // attribuait l'expiration au mauvais document (#31).
    const ownProjectPath =
      useProjectStore.getState().currentProject?.path ?? undefined;
    const proposalsInstance = proposals({
      onEvent: (e) =>
        recordAdjudication(e, {
          filePath: ownFilePath ?? undefined,
          projectPath: ownProjectPath,
        }),
      labels: {
        accept: t('editor.proposalAccept'),
        reject: t('editor.proposalReject'),
        modify: t('editor.proposalModify'),
        rejectionPrompt: t('editor.proposalWhy'),
        apply: t('editor.proposalApply'),
        cancel: t('common.cancel'),
      },
    });
    proposalsRef.current = proposalsInstance;

    const documentExtensions: Extension[] = [
        // Hors de tout document : l'auteur ne doit pas pouvoir y taper un texte
        // qui n'a nulle part où aller, ni une insertion y entrer par programme (la
        // lecture seule n'arrête que le clavier). Le chargement peut durer : la vue
        // dit pourquoi elle ne répond pas.
        detached
          ? [
              EditorState.readOnly.of(true),
              EditorView.editable.of(false),
              EditorState.changeFilter.of(() => false),
              placeholder(t('project.loading')),
            ]
          : [],
        history(),
        EditorView.clipboardInputFilter.of(toDocLineBreaks),
        formattingKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        lineNumbers(),
        highlightSpecialChars(),
        drawSelection(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          extensions: scholarlyMarkdown,
        }),
        syntaxHighlighting(markdownHighlight),
        liveRender({
          resolveImageSrc,
          resolveCitation,
          ...(isPresentation ? { slideSeparators: true } : {}),
        }),
        scholarly({
          resolveCitation,
          getCitations,
          labels: {
            citationNotFound: t('editor.citationNotFound'),
            bibliographyEmpty: t('editor.noCitations'),
            footnoteNoDefinition: t('editor.footnoteNoDefinition'),
            save: t('toolbar.save'),
            cancel: t('common.cancel'),
            frontmatterFolded: t('editor.frontmatterFolded'),
            frontmatterFold: t('editor.frontmatterFold'),
          },
        }),
        proposalsInstance.extension,
        changeOriginGuard(),
        cliodeckTheme,
        dynamicCompartment.of(dynamicExtensions(settings, currentTheme === 'dark')),
        EditorView.domEventObservers({
          mousedown: () => {
            cursorPlaced = true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet) cursorPlaced = true;
          // Curseur : notification synchrone, sans passer par React — les
          // consommateurs (navigateur/preview slides) ne mettent à jour leur
          // état que quand l'index de slide change réellement.
          if (update.selectionSet || update.docChanged) {
            const offset = update.state.selection.main.head;
            for (const listener of selectionListeners) listener(offset);
          }
          if (!update.docChanged || !ownsDocument()) return;
          // isDirty immédiat (autosave, indicateurs) ; contenu debouncé.
          if (!useEditorStore.getState().isDirty) {
            useEditorStore.setState({ isDirty: true });
          }
          pendingSync = true;
          if (syncTimer) clearTimeout(syncTimer);
          syncTimer = setTimeout(() => syncToStore(update.view), SYNC_DEBOUNCE_MS);
        }),
    ];

    // Retour sur un document déjà ouvert : son état est restauré (annulation,
    // curseur) SI son texte correspond encore à ce que le store vient de
    // charger. Le disque fait foi — un fichier modifié dehors, ou un
    // remplacement de contenu, repart d'un état neuf.
    const cached = editorStates.get(editorStateKey(ownFilePath, ownVersion));
    const restored = restoreEditorState(cached, store.content, documentExtensions);
    cursorPlaced = restored !== null && cached?.cursorPlaced === true;

    const view: EditorView = new EditorView({
      state: restored ?? createDocState(store.content, documentExtensions),
      parent: container,
    });

    // Relevé en continu : quand un changement de mode démonte l'éditeur, son DOM est déjà retiré
    // au moment du nettoyage, et son défilement n'y vaut plus que 0.
    let lastScrollTop = 0;
    view.scrollDOM.addEventListener('scroll', () => {
      lastScrollTop = view.scrollDOM.scrollTop;
    });

    // Le défilement n'appartient pas à l'état : il se repose après le premier rendu. La façade est
    // là bien avant : qui lui demande d'aller ailleurs (une proposition, « Ouvrir la source ») ne
    // doit pas se voir ramené à l'ancienne position une image plus tard.
    let scrollRestore: number | null = null;
    const cancelScrollRestore = () => {
      if (scrollRestore !== null) cancelAnimationFrame(scrollRestore);
      scrollRestore = null;
    };
    if (restored && cached) {
      lastScrollTop = cached.scrollTop;
      scrollRestore = requestAnimationFrame(() => {
        scrollRestore = null;
        view.scrollDOM.scrollTop = cached.scrollTop;
      });
    }

    viewRef.current = view;
    useEditorStore
      .getState()
      .setEditorFacade(
        createFacade(
          view,
          changeListeners,
          selectionListeners,
          proposalsInstance,
          () => cursorPlaced,
          cancelScrollRestore,
          isPresentation
        )
      );

    // Retour de mode sur le document qu'on venait de quitter : continuer d'écrire, ou Cmd+Z, ne
    // demande pas de cliquer, et ce clic remplacerait le curseur conservé. Un changement de chapitre
    // porte un autre numéro de document, et un champ qui a le focus le garde.
    if (cursorPlaced && cached?.documentVersion === ownVersion && !detached && focusIsFree()) {
      view.focus();
    }

    // Hook de dev (critère d'acceptation Phase 4) : injection d'une
    // proposition factice sans aucun modèle — utilisé par la vérification
    // pilotée et les démonstrations. Voir docs/editor-proposals.md.
    const devHost = window as unknown as {
      __cliodeckProposals?: { inject: (p: Partial<Proposal>) => Proposal };
    };
    devHost.__cliodeckProposals = {
      inject: (p) => proposalsInstance.inject(view, p),
    };

    // La bibliographie charge en asynchrone : quand `citations` change, la
    // résolution des clés change sans transaction de document — on demande
    // un recalcul des décorations.
    let lastCitations = useBibliographyStore.getState().citations;
    const unsubscribeBibliography = useBibliographyStore.subscribe((s) => {
      if (s.citations !== lastCitations) {
        lastCitations = s.citations;
        view.dispatch({ effects: liveRenderRefresh.of(null) });
      }
    });

    // Le document reçoit son chemin sans transaction : les images relatives
    // se résolvent contre lui, et les adjudications lui sont rattachées.
    const unsubscribeFilePath = useEditorStore.subscribe((s) => {
      if (s.documentVersion !== ownVersion || s.filePath === ownFilePath) return;
      ownFilePath = s.filePath;
      view.dispatch({ effects: liveRenderRefresh.of(null) });
    });

    return () => {
      cancelScrollRestore();
      unsubscribeBibliography();
      unsubscribeFilePath();
      // Ordre : retirer la façade, purger la sync en attente vers le store,
      // puis détruire la vue (la destruction émet `expired` pour les
      // propositions en attente — arbitrage 5).
      useEditorStore.getState().setEditorFacade(null);
      if (syncTimer) clearTimeout(syncTimer);
      // La purge n'a lieu que si le store porte TOUJOURS notre document : sur
      // une bascule, la porte a déjà installé le nouveau contenu.
      if (pendingSync && ownsDocument()) pushToMirror(view);
      // Mémorisation pour un retour ultérieur sur ce document. La porte a
      // sauvegardé le fichier sortant AVANT de basculer (verrou Phase 0) :
      // le texte de la vue correspond donc à celui du disque, et la règle de
      // fraîcheur du cache le revérifiera au retour de toute façon. Un tampon
      // sans titre qu'on remplace n'a pas de retour : son texte ne reste pas ici.
      if (!detached && (ownFilePath || ownsDocument())) {
        editorStates.set(editorStateKey(ownFilePath, ownVersion), {
          ...serializeEditorState(view.state, lastScrollTop),
          cursorPlaced,
          documentVersion: ownVersion,
        });
      }
      changeListeners.clear();
      selectionListeners.clear();
      delete devHost.__cliodeckProposals;
      proposalsRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentVersion, isPresentation]);

  // Réglages et thème : reconfiguration à chaud, sans recréer la vue.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: dynamicCompartment.reconfigure(
        dynamicExtensions(settings, currentTheme === 'dark')
      ),
    });
  }, [settings, currentTheme, dynamicCompartment, documentVersion]);

  // Commande d'insertion IPC (bibliographie, modes IA). Le contenu balisé
  // IA (metadata.modeId) devient une PROPOSITION adjudicable — plus de
  // marqueurs cliodeck-gen côté CM6 (Phase 4) ; le reste s'insère annoté
  // `programmatic`.
  useEffect(() => {
    const unsubscribe = window.electron.editor.onInsertText((raw: unknown) => {
      const view = viewRef.current;
      if (!view || view.state.readOnly) return;
      const payload = normalizeInsertPayload(raw);
      if (!payload.text) return;
      if (payload.metadata?.modeId && proposalsRef.current) {
        const head = view.state.selection.main.head;
        proposalsRef.current.inject(view, {
          range: { from: head, to: head },
          original: '',
          proposed: payload.text,
          category: 'ai-insert',
          source: {
            model: payload.metadata.model ?? 'unknown',
            task: payload.metadata.modeId,
          },
        });
      } else {
        view.dispatch({
          ...view.state.replaceSelection(toDocText(payload.text)),
          annotations: changeOrigin.of('programmatic'),
        });
        view.focus();
      }
    });
    return () => {
      unsubscribe();
    };
  }, []);

  return <div ref={containerRef} className="codemirror-editor" />;
};
