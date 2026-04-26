/**
 * McpToolsBanner (fusion 2.5).
 *
 * Compact bar shown above the chat input when at least one MCP client
 * is `ready`. Presents the count of currently-enabled tools and a
 * popover for fine-grained control. The default policy (per A12) is
 * "auto-enable read-only, opt-in for write/network" — the popover
 * groups tools accordingly so the user can see at a glance which
 * tools the model can call right now.
 *
 * Keeps zero state of its own — everything reads from the
 * `mcpToolsStore` and the `useMcpToolsList` hook.
 */
import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Wrench } from 'lucide-react';
import {
  useMcpToolsStore,
  computeEffectiveEnabled,
  groupToolsByKind,
  selectEnabledToolNames,
  type MCPToolDescriptor,
} from '../../stores/mcpToolsStore';

interface Props {
  tools: readonly MCPToolDescriptor[];
}

export const McpToolsBanner: React.FC<Props> = ({ tools }) => {
  const { t } = useTranslation('common');
  const overrides = useMcpToolsStore((s) => s.overrides);
  const setEnabled = useMcpToolsStore((s) => s.setEnabled);
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  const enabledNames = useMemo(
    () => selectEnabledToolNames(tools, overrides),
    [tools, overrides]
  );
  const enabledCount = enabledNames.length;
  const totalCount = tools.length;

  const groups = useMemo(() => groupToolsByKind(tools), [tools]);
  const activeClients = useMemo(() => {
    const set = new Set<string>();
    for (const name of enabledNames) {
      const t = tools.find((x) => x.namespaced === name);
      if (t) set.add(t.clientName);
    }
    return Array.from(set).sort();
  }, [enabledNames, tools]);

  if (totalCount === 0) return null;

  return (
    <details
      ref={detailsRef}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="mcp-tools-banner"
      style={{
        borderBottom: '1px solid var(--border-color)',
        background: 'var(--bg-panel)',
        fontSize: 12,
      }}
    >
      <summary
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px',
          cursor: 'pointer',
          listStyle: 'none',
          color: 'var(--text-secondary)',
        }}
      >
        <Wrench size={13} />
        <span>
          {t('mcpTools.summary', {
            enabled: enabledCount,
            total: totalCount,
            defaultValue: '{{enabled}} / {{total}} MCP tools active',
          })}
        </span>
        {activeClients.length > 0 && (
          <span style={{ opacity: 0.7 }}>
            · {activeClients.join(', ')}
          </span>
        )}
        <ChevronDown
          size={13}
          style={{
            marginLeft: 'auto',
            transform: open ? 'rotate(180deg)' : undefined,
            transition: 'transform 120ms',
          }}
        />
      </summary>
      <div style={{ padding: '6px 10px 10px' }}>
        <ToolGroup
          title={t('mcpTools.groups.read', 'Read-only · auto-enabled')}
          tools={groups.read}
          overrides={overrides}
          onToggle={setEnabled}
        />
        <ToolGroup
          title={t('mcpTools.groups.write', 'Write / network · opt-in')}
          tools={groups.write}
          overrides={overrides}
          onToggle={setEnabled}
        />
      </div>
    </details>
  );
};

interface ToolGroupProps {
  title: string;
  tools: readonly MCPToolDescriptor[];
  overrides: Record<string, boolean>;
  onToggle: (namespaced: string, enabled: boolean) => void;
}

const ToolGroup: React.FC<ToolGroupProps> = ({
  title,
  tools,
  overrides,
  onToggle,
}) => {
  if (tools.length === 0) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <div
        style={{
          fontSize: 10.5,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--text-tertiary)',
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {tools.map((tool) => {
          const enabled = computeEffectiveEnabled(
            tool.bareName,
            overrides[tool.namespaced]
          );
          return (
            <li key={tool.namespaced} style={{ marginBottom: 2 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => onToggle(tool.namespaced, e.target.checked)}
                />
                <code style={{ fontSize: 11.5 }}>{tool.namespaced}</code>
                {tool.description && (
                  <span
                    style={{
                      opacity: 0.65,
                      fontSize: 11,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    — {tool.description}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
