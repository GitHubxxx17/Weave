import { useEffect, useState, type ReactElement } from 'react';

import {
  readThemePreference,
  setThemePreference,
  subscribeThemePreference,
  type ThemePreference,
} from '../features/settings/theme.js';

type PreviewKind = 'light' | 'dark' | 'system';

const themeOptions: ReadonlyArray<{
  readonly value: ThemePreference;
  readonly label: string;
  readonly hint: string;
  readonly preview: PreviewKind;
}> = [
  { value: 'system', label: '跟随系统', hint: '随操作系统的深浅色设置自动切换', preview: 'system' },
  { value: 'light', label: '浅色', hint: '始终使用浅色界面', preview: 'light' },
  { value: 'dark', label: '深色', hint: '始终使用深色界面', preview: 'dark' },
];

function ThemePreview({ kind }: { readonly kind: PreviewKind }): ReactElement {
  if (kind === 'system') {
    return (
      <span className="appearance-preview appearance-preview-system" aria-hidden="true">
        <span className="appearance-preview-half appearance-preview-light" />
        <span className="appearance-preview-half appearance-preview-dark" />
      </span>
    );
  }
  return (
    <span className="appearance-preview" aria-hidden="true">
      <span className={`appearance-preview-half appearance-preview-${kind}`} />
    </span>
  );
}

/** 界面外观：跟随系统 / 浅色 / 深色，选中立即生效。 */
export function AppearanceSettingsView(): ReactElement {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);

  useEffect(() => subscribeThemePreference(setPreference), []);

  return (
    <div className="appearance-settings-view">
      <div className="product-view-heading">
        <div>
          <p>系统</p>
          <h2>界面外观</h2>
          <span>选择 Weave 的界面主题，设置立即生效并保存在这台电脑上。</span>
        </div>
      </div>
      <div className="appearance-options" role="radiogroup" aria-label="界面主题">
        {themeOptions.map((option) => {
          const checked = option.value === preference;
          return (
            <button
              key={option.value}
              className={`appearance-option${checked ? ' appearance-option-selected' : ''}`}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => {
                setThemePreference(document.documentElement, option.value);
                setPreference(option.value);
              }}
            >
              <ThemePreview kind={option.preview} />
              <span className="appearance-option-copy">
                <strong>{option.label}</strong>
                <span>{option.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
