import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import './plugin-dialog.css';

interface PluginDialogProps {
  readonly title: string;
  readonly descriptionId?: string;
  readonly fixedContent?: ReactNode;
  readonly children: ReactNode;
  readonly actions: ReactNode;
  readonly cancelRef: RefObject<HTMLButtonElement | null>;
  readonly onCancel: () => void;
  readonly getFallbackFocus: () => HTMLElement | null;
}

const focusableSelector =
  'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

function available(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(':disabled') || element.hasAttribute('disabled')) {
    return false;
  }
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

/** Shared modal ownership is limited to DOM focus/inert state, never requests. */
export function PluginDialog({
  title,
  descriptionId,
  fixedContent,
  children,
  actions,
  cancelRef,
  onCancel,
  getFallbackFocus,
}: PluginDialogProps): ReactElement {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const callbacks = useRef({ onCancel, getFallbackFocus });
  callbacks.current = { onCancel, getFallbackFocus };
  const [portal] = useState(() => {
    const container = document.createElement('div');
    container.dataset.pluginDialogPortal = '';
    return container;
  });

  useLayoutEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.append(portal);
    const inertValues = new Map<HTMLElement, string | null>();
    const makeBackgroundInert = (): void => {
      for (const child of document.body.children) {
        if (child instanceof HTMLElement && child !== portal && !inertValues.has(child)) {
          inertValues.set(child, child.getAttribute('inert'));
          child.setAttribute('inert', '');
        }
      }
    };
    makeBackgroundInert();
    const observer = new MutationObserver(makeBackgroundInert);
    observer.observe(document.body, { childList: true });

    const enabledControls = (): HTMLElement[] =>
      [...(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])].filter(
        (element) => available(element) && element.tabIndex >= 0,
      );
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        callbacks.current.onCancel();
      } else if (event.key === 'Tab') {
        const controls = enabledControls();
        if (controls.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const index = controls.findIndex((element) => element === document.activeElement);
        const next =
          index === -1
            ? event.shiftKey
              ? controls.length - 1
              : 0
            : event.shiftKey
              ? (index - 1 + controls.length) % controls.length
              : (index + 1) % controls.length;
        controls[next]?.focus();
      }
    };
    const onFocus = (event: FocusEvent): void => {
      if (event.target instanceof Node && !portal.contains(event.target)) {
        cancelRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocus, true);
    cancelRef.current?.focus();

    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocus, true);
      for (const [element, value] of inertValues) {
        if (value === null) element.removeAttribute('inert');
        else element.setAttribute('inert', value);
      }
      portal.remove();
      const focus =
        origin !== null && available(origin) ? origin : callbacks.current.getFallbackFocus();
      if (focus !== null && available(focus)) focus.focus();
    };
  }, [cancelRef, portal]);

  return createPortal(
    <div className="dialog-backdrop plugin-dialog-backdrop">
      <section
        className="project-dialog plugin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(descriptionId === undefined ? {} : { 'aria-describedby': descriptionId })}
        ref={dialogRef}
      >
        <header className="plugin-dialog-header">
          <h2 id={titleId}>{title}</h2>
        </header>
        {fixedContent === undefined ? null : (
          <div className="plugin-dialog-fixed">{fixedContent}</div>
        )}
        <div className="plugin-dialog-body">{children}</div>
        <footer className="plugin-dialog-actions">{actions}</footer>
      </section>
    </div>,
    portal,
  );
}

export function pluginDialogError(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}
