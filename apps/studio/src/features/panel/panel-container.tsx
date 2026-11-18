import { useState, type ReactElement, type RefObject } from 'react';
import { Check, PanelRight, Pin, PinOff, Plus, X } from 'lucide-react';

import type { PanelContext } from './panel-data.js';
import { PanelResizer } from './panel-resizer.js';
import { panelDescriptor, panelDescriptors, type PanelKind } from './panel-registry.js';
import { usePanelTabs } from './use-panel-tabs.js';

type OpenMenu =
  { readonly type: 'add' } | { readonly type: 'tab'; readonly kind: PanelKind } | null;

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
 * tabs are open, pinned, and active is persisted for the whole app. When
 * `collapsed`, the panel stays mounted but is hidden and inert so the shell
 * can animate it out and back.
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
  const active = panelDescriptor(tabs.layout.active);

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
          {tabs.layout.open.map((kind) => {
            const descriptor = panelDescriptor(kind);
            if (descriptor === undefined) {
              return null;
            }
            const isActive = kind === tabs.layout.active;
            const isPinned = tabs.layout.pinned.includes(kind);
            return (
              <div
                className={`panel-tab${isActive ? ' panel-tab-active' : ''}`}
                key={kind}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ type: 'tab', kind });
                }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className="panel-tab-button"
                  onClick={() => tabs.activate(kind)}
                >
                  <descriptor.Icon aria-hidden="true" />
                  <span className="panel-tab-label">{descriptor.label}</span>
                </button>
                {isPinned ? null : (
                  <button
                    type="button"
                    className="panel-tab-close"
                    aria-label={`关闭${descriptor.label}`}
                    onClick={() => tabs.close(kind)}
                  >
                    <X aria-hidden="true" />
                  </button>
                )}
                {menu?.type === 'tab' && menu.kind === kind ? (
                  <div
                    className="popup-menu panel-tab-menu"
                    role="menu"
                    aria-label={`${descriptor.label}标签操作`}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        tabs.togglePin(kind);
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
                        tabs.close(kind);
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
                  const isOpen = tabs.layout.open.includes(descriptor.kind);
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      key={descriptor.kind}
                      disabled={descriptor.comingSoon}
                      onClick={() => {
                        if (isOpen) {
                          tabs.activate(descriptor.kind);
                        } else {
                          tabs.open(descriptor.kind);
                        }
                        setMenu(null);
                      }}
                    >
                      <span className="menu-icon">
                        <descriptor.Icon aria-hidden="true" />
                      </span>
                      <span className="panel-add-label">{descriptor.label}</span>
                      {descriptor.comingSoon ? (
                        <small className="panel-add-soon">即将推出</small>
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
        {tabs.layout.open.map((kind) => {
          const descriptor = panelDescriptor(kind);
          if (descriptor?.keepAlive !== true || descriptor.render === undefined) {
            return null;
          }
          const isActive = kind === tabs.layout.active;
          return (
            <div className="panel-pane" key={kind} hidden={!isActive}>
              {descriptor.render(context)}
            </div>
          );
        })}
        {active?.keepAlive === false ? (active.render?.(context) ?? null) : null}
      </div>
    </aside>
  );
}
