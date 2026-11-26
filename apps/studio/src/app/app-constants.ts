import { Handshake, ShieldCheck, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { ProviderSettings } from '../features/providers/provider-types.js';
import type { ProductView, RunStatus } from './app-types.js';

export const statusLabels: Record<RunStatus, string> = {
  idle: '就绪',
  streaming: '运行中',
  completed: '已完成',
  error: '出错',
  cancelled: '已取消',
};

export const viewLabels: Record<
  Exclude<ProductView, 'studio' | 'marketplace' | 'memory' | 'retrieval'>,
  { title: string; description: string }
> = {
  projects: {
    title: '项目',
    description: '每个项目对应一个本地文件夹，并包含多个 Agent 会话',
  },
  history: {
    title: '历史',
    description: '运行记录和会话时间线将在这里统一展示',
  },
  archived: {
    title: '归档',
    description: '已归档的会话可以恢复，也可以在这里删除',
  },
  settings: {
    title: '设置',
    description: '模型、权限和插件配置将在这里集中管理',
  },
};

export type PermissionOption = {
  readonly value: 'ask' | 'trust' | 'yolo';
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly danger?: boolean;
};

export const permissionOptions: readonly PermissionOption[] = [
  {
    value: 'ask',
    label: '常规',
    description: '每次写文件或运行命令都要你确认',
    icon: ShieldCheck,
  },
  {
    value: 'trust',
    label: '信任',
    description: '本会话自动执行，仅高风险操作才确认',
    icon: Handshake,
  },
  {
    value: 'yolo',
    label: '完全访问',
    description: '全程不确认、直接执行，请谨慎',
    icon: Zap,
    danger: true,
  },
];

/** Model reasoning-effort options; the empty value sends no hint (provider default). */
export const reasoningEffortOptions = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
] as const;

export const fallbackProviderSettings: ProviderSettings = {
  providers: [
    {
      id: 'mock',
      label: '本地模型',
      type: 'mock',
      defaultModel: 'weave-local-demo',
      hasApiKey: false,
      editable: false,
    },
  ],
  defaultProvider: 'mock',
  canManage: false,
};
