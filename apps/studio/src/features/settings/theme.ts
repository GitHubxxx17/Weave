import { z } from 'zod';

/**
 * 界面主题偏好：跟随系统 / 浅色 / 深色。
 * 偏好存 localStorage（Zod 校验，非法值回退"跟随系统"），解析后的结果写到
 * `<html data-theme>`，配色由 app.css 的 `:root[data-theme='dark']` 提供。
 */
export const themePreferenceSchema = z.enum(['system', 'light', 'dark']);
export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type ResolvedTheme = 'light' | 'dark';

export const defaultThemePreference: ThemePreference = 'system';
export const themeStorageKey = 'weave.studio.theme.v1';
const darkQuery = '(prefers-color-scheme: dark)';

function readItem(key: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function readThemePreference(): ThemePreference {
  const parsed = themePreferenceSchema.safeParse(readItem(themeStorageKey));
  return parsed.success ? parsed.data : defaultThemePreference;
}

function writeThemePreference(preference: ThemePreference): void {
  try {
    globalThis.localStorage?.setItem(themeStorageKey, preference);
  } catch {
    // 存储不可用时偏好只在本次运行内生效。
  }
}

function systemPrefersDark(): boolean {
  return globalThis.window?.matchMedia?.(darkQuery).matches === true;
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

/** 把偏好解析成 light/dark 并写到根元素。 */
export function applyTheme(root: HTMLElement, preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference, systemPrefersDark());
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  return resolved;
}

type Listener = (preference: ThemePreference) => void;
const listeners = new Set<Listener>();

/** 订阅偏好变化（本窗口设置或其他窗口的 storage 事件）。返回取消订阅函数。 */
export function subscribeThemePreference(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(preference: ThemePreference): void {
  for (const listener of listeners) listener(preference);
}

/** 保存偏好并立即应用到根元素。 */
export function setThemePreference(root: HTMLElement, preference: ThemePreference): void {
  writeThemePreference(preference);
  applyTheme(root, preference);
  notify(preference);
}

/**
 * 在 React 渲染前同步应用一次主题，并开始监听：
 * - 系统深浅色变化（仅偏好为"跟随系统"时生效）；
 * - 其他窗口通过 storage 事件修改的偏好。
 * 返回的函数会移除全部监听。
 */
export function startThemeSync(root: HTMLElement): () => void {
  applyTheme(root, readThemePreference());

  const media = globalThis.window?.matchMedia?.(darkQuery);
  const onSystemChange = (): void => {
    const preference = readThemePreference();
    if (preference === 'system') applyTheme(root, preference);
  };
  media?.addEventListener('change', onSystemChange);

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== themeStorageKey) return;
    const preference = readThemePreference();
    applyTheme(root, preference);
    notify(preference);
  };
  globalThis.window?.addEventListener('storage', onStorage);

  return () => {
    media?.removeEventListener('change', onSystemChange);
    globalThis.window?.removeEventListener('storage', onStorage);
  };
}
