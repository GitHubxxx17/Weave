export type SettingsCategoryId = 'providers' | 'permissions' | 'storage' | 'appearance';

export interface SettingsCategory {
  readonly id: SettingsCategoryId;
  readonly label: string;
  readonly group: '配置' | '系统';
  /** Categories not built yet stay visible but cannot be selected. */
  readonly available: boolean;
  /** Extra words the sidebar search matches besides the label. */
  readonly keywords: readonly string[];
}

export const settingsCategories: readonly SettingsCategory[] = [
  {
    id: 'providers',
    label: '模型服务',
    group: '配置',
    available: true,
    keywords: ['模型', '服务', 'provider', 'api', 'key', '密钥', '默认'],
  },
  {
    id: 'permissions',
    label: '运行权限',
    group: '配置',
    available: true,
    keywords: [
      '权限',
      '审批',
      '命令',
      '信任',
      '默认',
      '模式',
      '完全访问',
      '敏感',
      '密钥',
      '白名单',
    ],
  },
  {
    id: 'storage',
    label: '数据存储',
    group: '系统',
    available: true,
    keywords: ['存储', '目录', '路径', '数据库', '插件', '技能', '记忆', '占用', '大小', '文件夹'],
  },
  {
    id: 'appearance',
    label: '界面外观',
    group: '系统',
    available: false,
    keywords: ['外观', '主题', '颜色', '深色', '字体'],
  },
];

/** Keeps categories whose label or keywords contain the query (case-insensitive). */
export function filterSettingsCategories(query: string): readonly SettingsCategory[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return settingsCategories;
  return settingsCategories.filter(({ label, keywords }) =>
    [label, ...keywords].some((text) => text.toLowerCase().includes(needle)),
  );
}
