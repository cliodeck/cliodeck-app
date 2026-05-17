/**
 * IdeasPanel — list + edit view for persistent ideas in Brainstorm mode.
 *
 * Shows a filterable list of ideas on the left and an editor on the right
 * (or inline on narrow viewports). Ideas can be created, edited, tagged,
 * linked, and deleted.
 */

import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Search,
  Tag,
  Link2,
  Trash2,
  X,
  Download,
} from 'lucide-react';
import { useIdeaStore, type Idea, type IdeaLink } from '../../stores/ideaStore';
import { useProjectStore } from '../../stores/projectStore';
import './IdeasPanel.css';

export const IdeasPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const ideas = useIdeaStore((s) => s.ideas);
  const selectedId = useIdeaStore((s) => s.selectedId);
  const { addIdea, updateIdea, removeIdea, setSelected, addTag, removeTag, addLink, removeLink, saveIdeas } =
    useIdeaStore.getState();
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);

  const [searchQuery, setSearchQuery] = useState('');
  const [newTagInput, setNewTagInput] = useState('');
  const [newLinkInput, setNewLinkInput] = useState('');
  const [importing, setImporting] = useState(false);

  const filteredIdeas = useMemo(() => {
    if (!searchQuery.trim()) return ideas;
    const q = searchQuery.toLowerCase();
    return ideas.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        i.content.toLowerCase().includes(q) ||
        i.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }, [ideas, searchQuery]);

  const selectedIdea = ideas.find((i) => i.id === selectedId) ?? null;

  const handleCreate = () => {
    const id = addIdea({
      title: t('ideas.newIdeaTitle'),
      content: '',
      tags: [],
      links: [],
      origin: { type: 'manual' },
    });
    setSelected(id);
    if (projectPath) saveIdeas(projectPath);
  };

  const handleImportObsidian = async () => {
    const fusion = window.electron.fusion;
    if (!fusion) return;
    setImporting(true);
    try {
      const result = await fusion.vault.importAsIdeas({ maxFiles: 200 });
      if (result.success && result.ideas) {
        const imported = result.ideas as Array<{
          title: string;
          content: string;
          tags: string[];
          wikilinks: string[];
          notePath: string;
        }>;
        for (const note of imported) {
          // Check if idea with same title already exists (avoid duplicates)
          const existing = ideas.find((i) => i.title === note.title && i.origin.type === 'obsidian');
          if (existing) continue;
          addIdea({
            title: note.title,
            content: note.content,
            tags: note.tags,
            links: note.wikilinks.map((wl) => ({
              targetId: wl,
              targetType: 'idea' as const,
              label: 'wikilink',
            })),
            origin: { type: 'obsidian', notePath: note.notePath },
          });
        }
        if (projectPath) saveIdeas(projectPath);
      }
    } catch (e) {
      console.error('Obsidian import failed:', e);
    } finally {
      setImporting(false);
    }
  };

  const handleTitleChange = (title: string) => {
    if (!selectedId) return;
    updateIdea(selectedId, { title });
  };

  const handleContentChange = (content: string) => {
    if (!selectedId) return;
    updateIdea(selectedId, { content });
  };

  const handleSave = () => {
    if (projectPath) saveIdeas(projectPath);
  };

  const handleDelete = () => {
    if (!selectedId) return;
    removeIdea(selectedId);
    if (projectPath) saveIdeas(projectPath);
  };

  const handleAddTag = () => {
    if (!selectedId || !newTagInput.trim()) return;
    addTag(selectedId, newTagInput.trim());
    setNewTagInput('');
    if (projectPath) saveIdeas(projectPath);
  };

  const handleRemoveTag = (tag: string) => {
    if (!selectedId) return;
    removeTag(selectedId, tag);
    if (projectPath) saveIdeas(projectPath);
  };

  const handleAddLink = () => {
    if (!selectedId || !newLinkInput.trim()) return;
    const link: IdeaLink = {
      targetId: newLinkInput.trim(),
      targetType: 'idea',
    };
    addLink(selectedId, link);
    setNewLinkInput('');
    if (projectPath) saveIdeas(projectPath);
  };

  const handleRemoveLink = (targetId: string) => {
    if (!selectedId) return;
    removeLink(selectedId, targetId);
    if (projectPath) saveIdeas(projectPath);
  };

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleDateString(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  };

  return (
    <div className="ideas-panel">
      {/* List sidebar */}
      <aside className="ideas-panel__list">
        <div className="ideas-panel__list-header">
          <div className="ideas-panel__search">
            <Search size={14} />
            <input
              type="text"
              placeholder={t('ideas.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <button
            className="ideas-panel__add-btn"
            onClick={handleImportObsidian}
            disabled={importing}
            title={t('ideas.importObsidian')}
          >
            <Download size={16} />
          </button>
          <button
            className="ideas-panel__add-btn"
            onClick={handleCreate}
            title={t('ideas.create')}
          >
            <Plus size={16} />
          </button>
        </div>

        <div className="ideas-panel__items">
          {filteredIdeas.length === 0 ? (
            <div className="ideas-panel__empty">
              {ideas.length === 0
                ? t('ideas.emptyState')
                : t('ideas.noResults')}
            </div>
          ) : (
            filteredIdeas.map((idea) => (
              <button
                key={idea.id}
                className={`ideas-panel__item ${idea.id === selectedId ? 'is-selected' : ''}`}
                onClick={() => setSelected(idea.id)}
              >
                <span className="ideas-panel__item-title">{idea.title}</span>
                <span className="ideas-panel__item-meta">
                  {idea.tags.length > 0 && (
                    <span className="ideas-panel__item-tags">
                      <Tag size={10} /> {idea.tags.length}
                    </span>
                  )}
                  <span className="ideas-panel__item-date">{formatDate(idea.updatedAt)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Editor */}
      <main className="ideas-panel__editor">
        {selectedIdea ? (
          <IdeaEditor
            idea={selectedIdea}
            onTitleChange={handleTitleChange}
            onContentChange={handleContentChange}
            onSave={handleSave}
            onDelete={handleDelete}
            onAddTag={handleAddTag}
            onRemoveTag={handleRemoveTag}
            onAddLink={handleAddLink}
            onRemoveLink={handleRemoveLink}
            newTagInput={newTagInput}
            setNewTagInput={setNewTagInput}
            newLinkInput={newLinkInput}
            setNewLinkInput={setNewLinkInput}
            allIdeas={ideas}
          />
        ) : (
          <div className="ideas-panel__placeholder">
            <p>{t('ideas.selectOrCreate')}</p>
          </div>
        )}
      </main>
    </div>
  );
};

// Internal editor component
interface IdeaEditorProps {
  idea: Idea;
  onTitleChange: (title: string) => void;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onAddTag: () => void;
  onRemoveTag: (tag: string) => void;
  onAddLink: () => void;
  onRemoveLink: (targetId: string) => void;
  newTagInput: string;
  setNewTagInput: (v: string) => void;
  newLinkInput: string;
  setNewLinkInput: (v: string) => void;
  allIdeas: Idea[];
}

const IdeaEditor: React.FC<IdeaEditorProps> = ({
  idea,
  onTitleChange,
  onContentChange,
  onSave,
  onDelete,
  onAddTag,
  onRemoveTag,
  onAddLink,
  onRemoveLink,
  newTagInput,
  setNewTagInput,
  newLinkInput,
  setNewLinkInput,
  allIdeas,
}) => {
  const { t } = useTranslation('common');

  const linkedIdeaTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of allIdeas) map.set(i.id, i.title);
    return map;
  }, [allIdeas]);

  return (
    <div className="idea-editor">
      <div className="idea-editor__header">
        <input
          className="idea-editor__title"
          type="text"
          value={idea.title}
          onChange={(e) => onTitleChange(e.target.value)}
          onBlur={onSave}
          placeholder={t('ideas.titlePlaceholder')}
        />
        <button className="idea-editor__delete" onClick={onDelete} title={t('ideas.delete')}>
          <Trash2 size={16} />
        </button>
      </div>

      <textarea
        className="idea-editor__content"
        value={idea.content}
        onChange={(e) => onContentChange(e.target.value)}
        onBlur={onSave}
        placeholder={t('ideas.contentPlaceholder')}
      />

      {/* Tags */}
      <div className="idea-editor__section">
        <h4><Tag size={14} /> {t('ideas.tags')}</h4>
        <div className="idea-editor__tags">
          {idea.tags.map((tag) => (
            <span key={tag} className="idea-editor__tag">
              {tag}
              <button onClick={() => onRemoveTag(tag)} aria-label={`Remove ${tag}`}>
                <X size={10} />
              </button>
            </span>
          ))}
          <div className="idea-editor__tag-input">
            <input
              type="text"
              value={newTagInput}
              onChange={(e) => setNewTagInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onAddTag()}
              placeholder={t('ideas.addTag')}
            />
          </div>
        </div>
      </div>

      {/* Links */}
      <div className="idea-editor__section">
        <h4><Link2 size={14} /> {t('ideas.links')}</h4>
        <div className="idea-editor__links">
          {idea.links.map((link) => (
            <span key={link.targetId} className="idea-editor__link">
              {link.targetType === 'idea'
                ? linkedIdeaTitles.get(link.targetId) ?? link.targetId
                : `📄 ${link.targetId}`}
              {link.label && <em> ({link.label})</em>}
              <button onClick={() => onRemoveLink(link.targetId)} aria-label="Remove link">
                <X size={10} />
              </button>
            </span>
          ))}
          <div className="idea-editor__link-input">
            <input
              type="text"
              value={newLinkInput}
              onChange={(e) => setNewLinkInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onAddLink()}
              placeholder={t('ideas.addLink')}
            />
          </div>
        </div>
      </div>

      {/* Origin info */}
      <div className="idea-editor__meta">
        <span>{t('ideas.origin')}: {idea.origin.type}</span>
        <span>{t('ideas.created')}: {new Date(idea.createdAt).toLocaleString()}</span>
      </div>
    </div>
  );
};
