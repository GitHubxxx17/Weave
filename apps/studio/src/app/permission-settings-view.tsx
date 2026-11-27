import { useState, type ReactElement } from 'react';

import {
  readDefaultPermissionMode,
  writeDefaultPermissionMode,
  type DefaultPermissionMode,
} from './composer-preferences.js';
import { permissionOptions } from './app-constants.js';

/**
 * Static description of what each permission mode asks about.
 * Studio cannot import `@weave/*`, so this mirrors the runtime rules in
 * `packages/runtime/src/approval-risk.ts` and `sensitive-paths.ts`. Update it
 * whenever those files change.
 */
export interface PermissionModeGuide {
  readonly mode: 'ask' | 'trust' | 'yolo';
  readonly label: string;
  readonly summary: string;
  readonly direct: readonly string[];
  readonly asks: readonly string[];
}

export const permissionModeGuides: readonly PermissionModeGuide[] = [
  {
    mode: 'ask',
    label: '常规',
    summary: '默认模式，会改动文件或运行命令的操作都要先确认。',
    direct: ['读取、搜索项目内的普通文件'],
    asks: ['写入或修改文件', '运行任何命令', '读取疑似密钥的文件（.env、.env.*）'],
  },
  {
    mode: 'trust',
    label: '信任',
    summary: '日常读写和安全命令直接执行，只有高风险操作才打断你。',
    direct: [
      '读写项目内的普通文件',
      '白名单命令：ls、pwd、cat、head、tail、wc、rg、grep；git status/diff/log/show；pnpm test/lint/typecheck/build；npm test；npx vitest；tsc --noEmit（不含管道、重定向、命令串联，参数不指向项目外）',
      '模型声明为低风险的其他命令（不在危险命令名单内）',
    ],
    asks: [
      '危险命令名单：sudo、rm、rmdir、mkfs、dd、shutdown、reboot、kill、pkill、chmod、chown、curl、wget、nc、ssh、scp，git push/reset/clean，npm/pnpm/yarn publish（优先于白名单和模型声明）',
      '不在白名单的命令，且模型声明为高风险或没有声明风险',
      '读取疑似密钥的文件（.env、.env.*）',
      '写入或修改敏感文件（见下方）',
      '经绝对路径或符号链接写到敏感文件（按实际落点判断）',
    ],
  },
  {
    mode: 'yolo',
    label: '完全访问',
    summary: '写文件、运行命令、读取密钥文件都不再确认，请谨慎使用。',
    direct: ['所有操作直接执行'],
    asks: ['不确认（工作区策略强制要求确认的操作除外）'],
  },
];

/** Write targets that still ask in 信任 mode; keep in sync with `sensitive-paths.ts`. */
export const sensitivePathCategories: readonly {
  readonly name: string;
  readonly examples: string;
}[] = [
  {
    name: 'Git 内部与钩子',
    examples: '.git/、.husky/、.githooks/、.pre-commit-config.yaml、lefthook.yml',
  },
  {
    name: 'CI 配置',
    examples:
      '.github/workflows/、.github/actions/、.circleci/、.buildkite/、.gitlab-ci.yml、azure-pipelines.yml、Jenkinsfile',
  },
  {
    name: '包管理与构建脚本',
    examples:
      'package.json、.npmrc、.yarnrc、.yarnrc.yml、pnpm-workspace.yaml、Makefile、justfile（任意目录）',
  },
  {
    name: '自动执行的环境与编辑器配置',
    examples:
      '.envrc、.devcontainer/、.vscode/tasks.json、.vscode/launch.json、.vscode/settings.json',
  },
  { name: '密钥文件', examples: '.env、.env.*（任意目录）' },
];

const defaultChoices = permissionOptions.filter(
  (option): option is typeof option & { value: DefaultPermissionMode } =>
    option.value === 'ask' || option.value === 'trust',
);

/** Settings page: default permission mode for new Sessions and what each mode asks. */
export function PermissionSettingsView(): ReactElement {
  const [defaultMode, setDefaultMode] = useState<DefaultPermissionMode>(readDefaultPermissionMode);

  function choose(mode: DefaultPermissionMode): void {
    writeDefaultPermissionMode(mode);
    setDefaultMode(mode);
  }

  return (
    <div className="permission-settings-view">
      <div className="product-view-heading">
        <div>
          <p>配置</p>
          <h2>运行权限</h2>
          <span>决定 Agent 写文件、运行命令前是否需要你确认。</span>
        </div>
      </div>

      <section className="permission-settings-section" aria-labelledby="permission-default-title">
        <h2 id="permission-default-title">新会话的默认模式</h2>
        <p className="permission-settings-note">
          只对还没有自己选过模式的新会话生效；已有会话保持各自的选择，也可以随时在输入框里切换。
        </p>
        <div
          className="permission-settings-choices"
          role="radiogroup"
          aria-label="新会话的默认模式"
        >
          {defaultChoices.map((option) => (
            <button
              key={option.value}
              className="permission-settings-choice"
              type="button"
              role="radio"
              aria-checked={defaultMode === option.value}
              onClick={() => choose(option.value)}
            >
              <strong>{option.label}</strong>
              <span>{option.description}</span>
            </button>
          ))}
        </div>
        <p className="permission-settings-note">
          完全访问不能设为默认，只能在每个会话里手动选择，避免新会话在你不知情时跳过所有确认。
        </p>
      </section>

      <section className="permission-settings-section" aria-labelledby="permission-modes-title">
        <h2 id="permission-modes-title">三种模式的区别</h2>
        <div className="permission-settings-cards">
          {permissionModeGuides.map((guide) => (
            <article
              key={guide.mode}
              className={`permission-settings-card${guide.mode === 'yolo' ? ' permission-settings-card-danger' : ''}`}
              aria-label={guide.label}
            >
              <h3>{guide.label}</h3>
              <p className="permission-settings-note">{guide.summary}</p>
              <h4>直接执行</h4>
              <ul>
                {guide.direct.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <h4>需要确认</h4>
              <ul>
                {guide.asks.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="permission-settings-section" aria-labelledby="permission-sensitive-title">
        <h2 id="permission-sensitive-title">信任模式下仍需确认的写入路径</h2>
        <p className="permission-settings-note">
          这些文件之后会自动执行代码或包含密钥，修改它们即使在信任模式下也会先问你。
        </p>
        <ul className="permission-settings-sensitive">
          {sensitivePathCategories.map((category) => (
            <li key={category.name}>
              <strong>{category.name}</strong>
              <code>{category.examples}</code>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
