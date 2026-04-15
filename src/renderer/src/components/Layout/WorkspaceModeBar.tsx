/**
 * WorkspaceModeBar (fusion phase 3.1a).
 *
 * Top-level four-mode navigation. Slim by design: it just switches the
 * `useWorkspaceModeStore.active` value; the layout decides what each mode
 * renders in the centre panel.
 *
 * Visual style intentionally matches the existing left-rail tabs
 * (compact, icon + label, current mode highlighted) so it doesn't look
 * grafted on. CSS lives next to the component to keep cohesion.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Lightbulb, Pen, BarChart3, Share2 } from 'lucide-react';
import {
  useWorkspaceModeStore,
  WORKSPACE_MODES,
  type WorkspaceMode,
} from '../../stores/workspaceModeStore';
import './WorkspaceModeBar.css';

const ICONS: Record<WorkspaceMode, React.ComponentType<{ size?: number }>> = {
  brainstorm: Lightbulb,
  write: Pen,
  analyze: BarChart3,
  export: Share2,
};

export const WorkspaceModeBar: React.FC = () => {
  const { t } = useTranslation('common');
  const active = useWorkspaceModeStore((s) => s.active);
  const setActive = useWorkspaceModeStore((s) => s.setActive);

  return (
    <nav className="workspace-mode-bar" aria-label={t('workspaceMode.brainstorm')}>
      {WORKSPACE_MODES.map((m) => {
        const Icon = ICONS[m];
        const isActive = m === active;
        return (
          <button
            key={m}
            type="button"
            className={`workspace-mode-bar__tab${
              isActive ? ' workspace-mode-bar__tab--active' : ''
            }`}
            onClick={() => setActive(m)}
            aria-pressed={isActive}
          >
            <Icon size={16} />
            <span>{t(`workspaceMode.${m}`)}</span>
          </button>
        );
      })}
    </nav>
  );
};
