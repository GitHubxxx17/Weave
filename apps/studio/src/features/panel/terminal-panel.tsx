import { useEffect, useRef, type ReactElement } from 'react';
import { SquareTerminal } from 'lucide-react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

/**
 * Embeds an interactive shell via xterm.js wired to the desktop pty bridge.
 * Desktop only: in browser mode `window.weaveDesktop.terminal` is absent and
 * the panel shows a short notice instead. The pty lives in the Main process;
 * this component only forwards keystrokes and renders output.
 */
export function TerminalPanel({ cwd }: { readonly cwd: string | undefined }): ReactElement {
  const bridge = globalThis.window?.weaveDesktop?.terminal;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (bridge === undefined || container === null) {
      return;
    }

    let disposed = false;
    let terminalId: string | undefined;
    let xterm: Terminal | undefined;
    const cleanups: Array<() => void> = [];

    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon: Fit }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed) {
        return;
      }
      const term = new XTerm({
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        cursorBlink: true,
        theme: { background: '#10131a', foreground: '#e7e9f1' },
      });
      const fit: FitAddon = new Fit();
      term.loadAddon(fit);
      term.open(container);
      fit.fit();
      xterm = term;

      const created = await bridge.create({ cwd: cwd ?? null, cols: term.cols, rows: term.rows });
      if (disposed) {
        term.dispose();
        return;
      }
      if (created.id === undefined) {
        term.write(`\r\n无法启动终端：${created.error ?? '未知错误'}\r\n`);
        return;
      }
      terminalId = created.id;

      cleanups.push(
        bridge.onData((payload) => {
          if (payload.id === terminalId) {
            term.write(payload.data);
          }
        }),
      );
      cleanups.push(
        bridge.onExit((payload) => {
          if (payload.id === terminalId) {
            term.write(`\r\n\x1b[90m[进程已退出，代码 ${payload.exitCode}]\x1b[0m\r\n`);
          }
        }),
      );
      const inputSub = term.onData((data) => {
        if (terminalId !== undefined) {
          bridge.write(terminalId, data);
        }
      });
      cleanups.push(() => inputSub.dispose());

      const observer = new ResizeObserver(() => {
        try {
          fit.fit();
          if (terminalId !== undefined) {
            bridge.resize(terminalId, term.cols, term.rows);
          }
        } catch {
          // The element can be detached mid-measure while switching tabs.
        }
      });
      observer.observe(container);
      cleanups.push(() => observer.disconnect());
    })();

    return () => {
      disposed = true;
      for (const cleanup of cleanups) {
        cleanup();
      }
      if (terminalId !== undefined) {
        bridge.dispose(terminalId);
      }
      xterm?.dispose();
    };
  }, [bridge, cwd]);

  if (bridge === undefined) {
    return (
      <div className="panel-body" role="region" aria-label="终端">
        <div className="terminal-unavailable">
          <span className="terminal-unavailable-icon" aria-hidden="true">
            <SquareTerminal />
          </span>
          <strong>终端仅在桌面端可用</strong>
          <p>在 Weave 桌面应用中打开此会话即可使用内置终端。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel-body terminal-panel" role="region" aria-label="终端">
      <div className="terminal-surface" ref={containerRef} />
    </div>
  );
}
