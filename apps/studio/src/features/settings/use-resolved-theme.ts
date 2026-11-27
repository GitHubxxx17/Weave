import { useSyncExternalStore } from 'react';

import type { ResolvedTheme } from './theme.js';

/**
 * 读取 `<html data-theme>` 上已解析的主题。
 * 供无法使用 CSS 变量、需要显式传入主题的第三方组件使用（例如 Diff 视图）。
 */
function readResolvedTheme(): ResolvedTheme {
  return globalThis.document?.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** 监听根元素 `data-theme` 的变化，覆盖设置页切换、跟随系统和其他窗口同步三种来源。 */
function subscribe(onChange: () => void): () => void {
  const root = globalThis.document?.documentElement;
  if (root === undefined || typeof MutationObserver === 'undefined') return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/** 当前生效的 light/dark 主题，根元素主题变化时触发重新渲染。 */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, readResolvedTheme, () => 'light');
}
