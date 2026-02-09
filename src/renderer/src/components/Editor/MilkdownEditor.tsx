import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { gfm } from '@milkdown/kit/preset/gfm';
import { replaceAll } from '@milkdown/utils';
import { useEditorStore } from '../../stores/editorStore';
import { useBibliographyStore } from '../../stores/bibliographyStore';
import { useTheme } from '../../hooks/useTheme';
import '@milkdown/crepe/theme/common/style.css';
import './MilkdownEditor.css';

// Citation autocomplete component
const CitationAutocomplete: React.FC<{
  query: string;
  position: { top: number; left: number };
  onSelect: (citationId: string) => void;
  onClose: () => void;
}> = ({ query, position, onSelect, onClose }) => {
  const { t } = useTranslation('common');
  const { citations } = useBibliographyStore();
  const menuRef = useRef<HTMLDivElement>(null);

  // Filter citations based on query
  const filteredCitations = citations.filter((citation) => {
    const searchText = query.toLowerCase();
    return (
      citation.id.toLowerCase().includes(searchText) ||
      citation.author.toLowerCase().includes(searchText) ||
      citation.title.toLowerCase().includes(searchText) ||
      citation.year.includes(searchText)
    );
  }).slice(0, 10);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  if (filteredCitations.length === 0) {
    return (
      <div
        ref={menuRef}
        className="citation-autocomplete-menu"
        style={{ top: position.top, left: position.left }}
      >
        <div className="citation-autocomplete-empty">
          {t('milkdownEditor.noCitationFound')}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      className="citation-autocomplete-menu"
      style={{ top: position.top, left: position.left }}
    >
      {filteredCitations.map((citation) => (
        <button
          key={citation.id}
          className="citation-autocomplete-item"
          onClick={() => onSelect(citation.id)}
        >
          <span className="citation-key">@{citation.id}</span>
          <span className="citation-info">
            {citation.author} ({citation.year})
          </span>
          <span className="citation-title">{citation.title}</span>
        </button>
      ))}
    </div>
  );
};

export const MilkdownEditor: React.FC = () => {
  const { t } = useTranslation('common');
  const {
    content,
    filePath,
    setContent,
    settings,
    pendingFootnoteScroll,
    clearPendingFootnoteScroll,
  } = useEditorStore();
  const { currentTheme } = useTheme();
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const isInternalUpdate = useRef(false);
  const contentRef = useRef(content);
  const [isEditorReady, setIsEditorReady] = useState(false);

  // Citation autocomplete state
  const [showCitationMenu, setShowCitationMenu] = useState(false);
  const [citationQuery, setCitationQuery] = useState('');
  const [citationMenuPosition, setCitationMenuPosition] = useState({ top: 0, left: 0 });
  const citationStartPos = useRef<number | null>(null);

  // Keep contentRef in sync
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // Safe editor action wrapper
  const safeEditorAction = useCallback((action: (ctx: Parameters<Parameters<NonNullable<typeof crepeRef.current>['editor']['action']>[0]>[0]) => void) => {
    const crepe = crepeRef.current;
    if (!crepe?.editor || !isEditorReady) return false;

    try {
      crepe.editor.action(action);
      return true;
    } catch (error) {
      console.warn('[MilkdownEditor] Editor action failed:', error);
      return false;
    }
  }, [isEditorReady]);

  // Initialize Crepe editor
  useEffect(() => {
    if (!editorContainerRef.current) return;

    setIsEditorReady(false);

    if (crepeRef.current) {
      console.log('[MilkdownEditor] Destroying old editor for new file');
      crepeRef.current.destroy();
      crepeRef.current = null;
    }

    console.log('[MilkdownEditor] Initializing Crepe editor for file:', filePath);

    const welcomeText = `# ${t('milkdownEditor.welcome')}\n\n${t('milkdownEditor.startWriting')}`;
    const placeholderText = t('milkdownEditor.placeholder');
    const crepe = new Crepe({
      root: editorContainerRef.current,
      defaultValue: contentRef.current || welcomeText,
      featureConfigs: {
        [Crepe.Feature.Placeholder]: {
          text: placeholderText,
        },
      },
    });

    // Add GFM plugin for footnote support
    crepe.editor.use(gfm);

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, prevMarkdown) => {
        if (markdown !== prevMarkdown) {
          isInternalUpdate.current = true;
          setContent(markdown);
          setTimeout(() => {
            isInternalUpdate.current = false;
          }, 50);
        }
      });
    });

    crepe.create().then(() => {
      console.log('[MilkdownEditor] Crepe editor created successfully');
      crepeRef.current = crepe;
      useEditorStore.setState({ milkdownEditor: crepe.editor });
      setTimeout(() => {
        setIsEditorReady(true);
        console.log('[MilkdownEditor] Editor is now ready');
      }, 100);
    }).catch((err) => {
      console.error('[MilkdownEditor] Failed to create editor:', err);
    });

    return () => {
      console.log('[MilkdownEditor] Destroying Crepe editor on unmount');
      setIsEditorReady(false);
      crepe.destroy();
      crepeRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, setContent, t]);

  // Sync external content changes to the editor
  const lastSyncedContent = useRef(content);
  useEffect(() => {
    const crepe = crepeRef.current;
    if (!crepe?.editor || !isEditorReady) return;

    if (isInternalUpdate.current) return;
    if (content === lastSyncedContent.current) return;

    console.log('[MilkdownEditor] Syncing external content change');
    isInternalUpdate.current = true;
    try {
      crepe.editor.action(replaceAll(content));
      lastSyncedContent.current = content;
    } catch (error) {
      console.warn('[MilkdownEditor] Failed to sync content:', error);
    }
    setTimeout(() => {
      isInternalUpdate.current = false;
    }, 100);
  }, [content, isEditorReady]);

  // Handle IPC text insertion from bibliography panel
  useEffect(() => {
    const handler = (text: string) => {
      safeEditorAction((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        const { tr, selection } = state;
        tr.insertText(text, selection.from, selection.to);
        view.dispatch(tr);
        view.focus();
      });
    };

    const cleanup = window.electron.editor.onInsertText(handler);
    return cleanup;
  }, [safeEditorAction]);

  // Handle citation autocomplete detection (only citations, not footnotes)
  useEffect(() => {
    const handleKeyUp = () => {
      if (!isEditorReady) return;

      safeEditorAction((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        const { selection } = state;
        const pos = selection.from;

        // Get text before cursor (up to 50 chars)
        const start = Math.max(0, pos - 50);
        const textBefore = state.doc.textBetween(start, pos, '\n');

        // Check for "[@" pattern (citations only)
        const citationMatch = textBefore.match(/\[@([a-zA-Z0-9_-]*)$/);

        if (citationMatch) {
          const query = citationMatch[1] || '';
          setCitationQuery(query);

          const coords = view.coordsAtPos(pos);
          const editorRect = editorContainerRef.current?.getBoundingClientRect();
          if (editorRect) {
            setCitationMenuPosition({
              top: coords.bottom - editorRect.top + 5,
              left: coords.left - editorRect.left,
            });
          }

          citationStartPos.current = pos - citationMatch[0].length;
          setShowCitationMenu(true);
        } else {
          setShowCitationMenu(false);
          citationStartPos.current = null;
        }
      });
    };

    const container = editorContainerRef.current;
    if (container) {
      container.addEventListener('keyup', handleKeyUp);
      return () => {
        container.removeEventListener('keyup', handleKeyUp);
      };
    }
  }, [isEditorReady, safeEditorAction]);

  // Handle citation selection
  const handleCitationSelect = useCallback((citationId: string) => {
    if (citationStartPos.current === null) return;

    const startPos = citationStartPos.current;
    safeEditorAction((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const { selection } = state;

      const tr = state.tr.replaceWith(
        startPos,
        selection.from,
        state.schema.text(`[@${citationId}]`)
      );

      view.dispatch(tr);
      view.focus();
    });

    setShowCitationMenu(false);
    citationStartPos.current = null;
  }, [safeEditorAction]);

  // Apply font settings via CSS custom properties
  useEffect(() => {
    const container = editorContainerRef.current;
    if (container) {
      container.style.setProperty('--editor-font-size', `${settings.fontSize}px`);

      const fontFamilyMap: Record<string, string> = {
        system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        jetbrains: "'JetBrains Mono', 'Consolas', monospace",
        fira: "'Fira Code', 'Consolas', monospace",
        source: "'Source Code Pro', 'Consolas', monospace",
        cascadia: "'Cascadia Code', 'Consolas', monospace",
      };
      container.style.setProperty('--editor-font-family', fontFamilyMap[settings.fontFamily] || fontFamilyMap.system);
    }
  }, [settings.fontSize, settings.fontFamily]);

  // Handle scrolling to footnote definition after insertion
  useEffect(() => {
    if (pendingFootnoteScroll === null || !isEditorReady) return;

    // Wait for content to sync to the editor
    const timeout = setTimeout(() => {
      safeEditorAction((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;

        try {
          // Find the footnote definition pattern [^N]: in the document
          // We need to search through text nodes to find it
          let targetPos = -1;
          const footnoteDefRegex = /\[\^\d+\]:\s*$/;

          state.doc.descendants((node, pos) => {
            if (node.isText && node.text) {
              const match = node.text.match(footnoteDefRegex);
              if (match) {
                // Found the footnote definition, position cursor at end of this text
                targetPos = pos + node.text.length;
                return false; // Stop searching
              }
            }
            return true;
          });

          if (targetPos > 0) {
            // Position cursor at the end of the footnote definition
            const $pos = state.doc.resolve(targetPos);
            const selection = state.selection.constructor.near($pos);

            const tr = state.tr.setSelection(selection);
            view.dispatch(tr);
            view.focus();

            // Scroll to make the cursor visible
            setTimeout(() => {
              const coords = view.coordsAtPos(targetPos);
              if (coords && editorContainerRef.current) {
                const containerRect = editorContainerRef.current.getBoundingClientRect();
                const scrollTop = coords.top - containerRect.top - 100 + editorContainerRef.current.scrollTop;
                editorContainerRef.current.scrollTo({
                  top: Math.max(0, scrollTop),
                  behavior: 'smooth',
                });
              }
            }, 50);

            console.log('[MilkdownEditor] Cursor positioned at footnote definition, pos:', targetPos);
          } else {
            // Fallback: scroll to bottom
            console.log('[MilkdownEditor] Footnote definition not found, scrolling to bottom');
            if (editorContainerRef.current) {
              editorContainerRef.current.scrollTo({
                top: editorContainerRef.current.scrollHeight,
                behavior: 'smooth',
              });
            }
          }
        } catch (error) {
          console.warn('[MilkdownEditor] Failed to scroll to footnote:', error);
          if (editorContainerRef.current) {
            editorContainerRef.current.scrollTo({
              top: editorContainerRef.current.scrollHeight,
              behavior: 'smooth',
            });
          }
        }
      });

      clearPendingFootnoteScroll();
    }, 300);

    return () => clearTimeout(timeout);
  }, [pendingFootnoteScroll, isEditorReady, safeEditorAction, clearPendingFootnoteScroll]);

  // Handle footnote navigation (click on reference -> scroll to definition, click on definition number -> scroll to reference)
  useEffect(() => {
    const container = editorContainerRef.current;
    if (!container || !isEditorReady) return;

    const handleFootnoteClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Check if clicked on footnote reference (sup element)
      const footnoteRef = target.closest('sup[data-type="footnote_reference"]');
      if (footnoteRef) {
        e.preventDefault();
        e.stopPropagation();

        // Extract footnote number from the element text content
        const footnoteNum = footnoteRef.textContent?.trim();
        if (!footnoteNum) return;

        // Find the corresponding footnote definition
        const footnoteDefinition = container.querySelector(
          `dl[data-type="footnote_definition"] dt`
        );

        // Look through all footnote definitions to find the matching one
        const allDefinitions = container.querySelectorAll('dl[data-type="footnote_definition"]');
        for (const def of allDefinitions) {
          const dt = def.querySelector('dt');
          if (dt && dt.textContent?.trim() === footnoteNum) {
            // Add ID to the reference for back navigation
            const refId = `fnref-${footnoteNum}`;
            footnoteRef.setAttribute('id', refId);

            // Scroll to the definition
            def.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // Flash effect on definition
            def.classList.add('footnote-highlight');
            setTimeout(() => def.classList.remove('footnote-highlight'), 1500);
            return;
          }
        }

        console.log('[MilkdownEditor] Footnote definition not found for:', footnoteNum);
        return;
      }

      // Check if clicked on footnote definition number (dt element inside dl)
      const footnoteDefNum = target.closest('dl[data-type="footnote_definition"] > dt');
      if (footnoteDefNum) {
        e.preventDefault();
        e.stopPropagation();

        const footnoteNum = footnoteDefNum.textContent?.trim();
        if (!footnoteNum) return;

        // Find the corresponding footnote reference in the text
        const allRefs = container.querySelectorAll('sup[data-type="footnote_reference"]');
        for (const ref of allRefs) {
          if (ref.textContent?.trim() === footnoteNum) {
            // Scroll to the reference
            ref.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // Flash effect on reference
            ref.classList.add('footnote-highlight');
            setTimeout(() => ref.classList.remove('footnote-highlight'), 1500);
            return;
          }
        }

        console.log('[MilkdownEditor] Footnote reference not found for:', footnoteNum);
      }
    };

    container.addEventListener('click', handleFootnoteClick);
    return () => container.removeEventListener('click', handleFootnoteClick);
  }, [isEditorReady]);

  return (
    <div
      ref={editorContainerRef}
      className={`milkdown-editor-container ${currentTheme === 'dark' ? 'milkdown-dark' : 'milkdown-light'}`}
    >
      {showCitationMenu && (
        <CitationAutocomplete
          query={citationQuery}
          position={citationMenuPosition}
          onSelect={handleCitationSelect}
          onClose={() => setShowCitationMenu(false)}
        />
      )}
    </div>
  );
};
