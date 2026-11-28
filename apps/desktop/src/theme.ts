import { z } from 'zod';

/** Theme preference chosen in Studio settings; mirrors `ThemePreference` in Studio. */
export const themePreferenceSchema = z.enum(['system', 'light', 'dark']);
export type ThemePreference = z.infer<typeof themePreferenceSchema>;

/**
 * Window background colors, equal to Studio's `--app-bg` in `apps/studio/src/app/app.css`
 * (`:root` and `:root[data-theme='dark']`). A Desktop test compares them with the CSS,
 * so change both together.
 */
export const studioBackgroundColors = { light: '#f7f8fc', dark: '#12141b' } as const;

/** IPC channel used by the Preload `setTheme()` bridge. */
export const setThemeChannel = 'weave:set-theme';

export function getBackgroundColor(useDarkColors: boolean): string {
  return useDarkColors ? studioBackgroundColors.dark : studioBackgroundColors.light;
}
