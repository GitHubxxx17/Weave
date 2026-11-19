import { useState, type ReactElement, type RefObject } from 'react';
import { Check, PanelRight, Pin, PinOff, Plus, X } from 'lucide-react';

import type { PanelContext } from './panel-data.js';
import { PanelResizer } from './panel-resizer.js';
import {
  panelDescriptor,
  panelDescriptors,
  type PanelDescriptor,
  type PanelKind,
} from './panel-registry.js';
import { usePanelTabs, type PanelTab } from './use-panel-tabs.js';

type OpenMenu = { readonly type: 'add' } | { readonly type: 'tab'; readonly id: string } | null;

interface LabeledTab {
  readonly tab: PanelTab;
  readonly descriptor: PanelDescriptor | undefined;
  /** Display label; a kind with several open tabs is numbered, e.g. `终端 2`. */
  readonly label: string;
}

/** Pairs each tab with its descriptor and a display label, numbering duplicates. */
function labelTabs(tabs: readonly PanelTab[]): LabeledTab[] {
  const counts = new Map<PanelKind, number>();
  for (const tab of tabs) {
    counts.set(tab.kind, (counts.get(tab.kind) ?? 0) + 1);
  }
  const seen = new Map<PanelKind, number>();
  return tabs.map((tab) => {
    const descriptor = panelDescriptor(tab.kind);
    const ordinal = (seen.get(tab.kind) ?? 0) + 1;
    seen.set(tab.kind, ordinal);
    const base = descriptor?.label ?? tab.kind;
    const label = (counts.get(tab.kind) ?? 1) > 1 ? `${base} ${ordinal}` : base;
    return { tab, descriptor, label };
  });
}

export interface PanelContainerProps {
  readonly context: PanelContext;
  readonly collapsed: boolean;
  readonly width: number;
  readonly shellRef: RefObject<HTMLElement | null>;
  readonly conversationRef: RefObject<HTMLElement | null>;
  readonly onResize: (width: number) => void;
  readonly onCollapse: () => void;
}

/**
 * Standalone right-hand panel: a tab bar of pinnable panels, an add menu for
 * the rest, a resizer on its left edge, and the active panel's body. Which
 * tabs are open, pinned, and active is persisted for the whole app. Terminal
 * and preview panels can be opened more than once; each tab keeps its own
 * live content. When `collapsed`, the panel stays mounted but is hidden and
 * inert so the shell can animate it out and back.
 */
export function PanelContainer({
  context,
  collapsed,
  width,
  shellRef,
  conversationRef,
  onResize,
  onCollapse,
}: PanelContainerProps): ReactElement {
  const tabs = usePanelTabs();
  const [menu, setMenu] = useState<OpenMenu>(null);
  const activeTab = tabs.layout.tabs.find((tab) => tab.id === tabs.layout.active);
  const activeDescriptor = activeTab === undefined ? undefined : panelDescriptor(activeTab.kind);

  return (
    <aside
      className="activity-panel"
      aria-label="运行活动"
      aria-hidden={collapsed || undefined}
      inert={collapsed}
    >
      {collapsed ? null : (
        <PanelResizer
          width={width}
          shellRef={shellRef}
          conversationRef={conversationRef}
          onResize={onResize}
        />
      )}
      {menu !== null ? (
        <button
          className="menu-scrim"
          type="button"
          aria-label="关闭菜单"
          onClick={() => setMenu(null)}
        />
      ) : null}
      <div className="panel-tabbar">
        <div className="panel-tablist" role="tablist" aria-label="面板标签">
          {labelTabs(tabs.layout.tabs).map(({ tab, descriptor, label }) => {
            if (descriptor === undefined) {
              return null;
            }
            const isActive = tab.id === tabs.layout.active;
            const isPinned = tabs.layout.pinned.includes(tab.id);
            return (
              <div
                className={`panel-tab${isActive ? ' panel-tab-active' : ''}`}
                key={tab.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ type: 'tab', id: tab.id });
                }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className="panel-tab-button"
                  onClick={() => tabs.activate(tab.id)}
                >
                  <descriptor.Icon aria-hidden="true" />
                  <span className="panel-tab-label">{label}</span>
                </button>
                {isPinned ? null : (
                  <button
                    type="button"
                    className="panel-tab-close"
                    aria-label={`关闭${label}`}
                    onClick={() => tabs.close(tab.id)}
                  >
                    <X aria-hidden="true" />
                  </button>
                )}
                {menu?.type === 'tab' && menu.id === tab.id ? (
                  <div
                    className="popup-menu panel-tab-menu"
                    role="menu"
                    aria-label={`${label}标签操作`}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        tabs.togglePin(tab.id);
                        setMenu(null);
                      }}
                    >
                      <span className="menu-icon">
                        {isPinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
                      </span>
                      {isPinned ? '取消固定' : '固定'}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={isPinned}
                      onClick={() => {
                        tabs.close(tab.id);
                        setMenu(null);
                      }}
                    >
                      <span className="menu-icon">
                        <X aria-hidden="true" />
                      </span>
                      关闭
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="panel-tabbar-actions">
          <div className="menu-anchor">
            <button
              className="icon-button"
              type="button"
              aria-label="添加面板"
              title="添加面板"
              aria-expanded={menu?.type === 'add'}
              onClick={() => setMenu(menu?.type === 'add' ? null : { type: 'add' })}
            >
              <Plus aria-hidden="true" />
            </button>
            {menu?.type === 'add' ? (
              <div
                className="popup-menu popup-menu-right panel-add-menu"
                role="menu"
                aria-label="添加面板"
              >
                {panelDescriptors.map((descriptor) => {
                  const isOpen = tabs.layout.tabs.some((tab) => tab.kind === descriptor.kind);
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      key={descriptor.kind}
                      disabled={descriptor.comingSoon}
                      onClick={() => {
                        tabs.open(descriptor.kind);
                        setMenu(null);
                      }}
                    >
                      <span className="menu-icon">
                        <descriptor.Icon aria-hidden="true" />
                      </span>
                      <span className="panel-add-label">{descriptor.label}</span>
                      {descriptor.comingSoon ? (
                        <small className="panel-add-soon">即将推出</small>
                      ) : descriptor.multi ? (
                        <Plus className="menu-check" aria-hidden="true" />
                      ) : isOpen ? (
                        <Check className="menu-check" aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="收起上下文"
            title="收起上下文"
            onClick={onCollapse}
          >
            <PanelRight aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="activity-body activity-scroll">
        {tabs.layout.tabs.map((tab) => {
          const descriptor = panelDescriptor(tab.kind);
          if (descriptor?.keepAlive !== true || descriptor.render === undefined) {
            return null;
          }
          const isActive = tab.id === tabs.layout.active;
          return (
            <div className="panel-pane" key={tab.id} hidden={!isActive}>
              {descriptor.render(context, tab.id)}
            </div>
          );
        })}
        {activeDescriptor?.keepAlive === false
          ? (activeDescriptor.render?.(context, activeTab?.id ?? activeDescriptor.kind) ?? null)
          : null}
      </div>
    </aside>
  );
}
