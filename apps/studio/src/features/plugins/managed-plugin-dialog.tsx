import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';

import type {
  ManagedManifest,
  GithubPluginSource,
  ManagedMutationResponse,
  ManagedPlugin,
  ManagedReview,
} from './managed-plugin-types.js';
import { PluginDialog, pluginDialogError } from './plugin-dialog.js';
import type { ManagedAttemptOutcome, ManagedRejection } from './plugin-catalog-store.js';
import { pluginImpact } from './plugin-review.js';
import type { PluginDeclarations } from './plugin-types.js';
import { isDeclarativeSkillManifest } from './managed-plugin-types.js';
import {
  declarativeSkillDisclosure,
  DeclarativeSkillPayload,
} from './plugin-payload-description.js';

type ManagedTarget = ManagedMutationResponse['decision']['target'];

export function managedAction(action: ManagedTarget | ManagedReview): string {
  switch (action.kind) {
    case 'import':
      return '导入';
    case 'activate':
      return action.intent === 'rollback' ? '回退' : '激活';
    case 'enable':
      return '启用';
    case 'disable':
      return '停用';
    case 'revoke':
      return '撤销信任';
    case 'uninstall':
      return '卸载';
  }
}

export function managedRecoveryText(recovery: ManagedRejection['recovery']): string | undefined {
  switch (recovery) {
    case 'preview':
      return '请重新预览插件来源。';
    case 'retry-review':
      return '条件恢复后可重新确认，或重新预览插件来源。';
    case 'review':
      return '请读取目录后重新审查。';
    case 'activate':
      return '请审查候选版本并激活。';
    case 'none':
      return undefined;
  }
}

const contributionLabels = [
  ['tools', '工具'],
  ['providers', '模型提供方'],
  ['promptSections', '提示词片段'],
  ['events', '会话事件'],
  ['commands', '命令'],
  ['skills', '技能'],
  ['hooks', '钩子'],
  ['services', '服务'],
] as const;

export function ManagedContributions({
  values,
  manifest,
}: {
  readonly values: PluginDeclarations;
  readonly manifest?: ManagedManifest;
}): ReactElement {
  const groups = contributionLabels.map(([category, label]) => ({
    label,
    names: values[category] ?? [],
    impact: category === 'hooks' ? ('hook' as const) : undefined,
  }));
  const rows =
    manifest === undefined
      ? groups
      : [
          { label: '能力', names: manifest.capabilities, impact: undefined },
          ...groups,
          { label: '权限', names: manifest.permissions, impact: 'permission' as const },
        ];
  const present = rows.filter(({ names }) => names.length > 0);
  if (present.length === 0) return <p className="plugin-note">当前未提供贡献</p>;
  return (
    <ul className="plugin-declaration-list">
      {present.flatMap(({ label, names, impact }) =>
        [...new Set(names)].map((name) => {
          const assessment = impact === undefined ? undefined : pluginImpact(impact, name);
          return (
            <li
              key={`${label}:${name}`}
              className={assessment?.level === 'high' ? 'plugin-impact-high' : undefined}
            >
              <span>{label}</span> <code>{name}</code>
              {assessment === undefined ? null : <small>{assessment.description}</small>}
            </li>
          );
        }),
      )}
    </ul>
  );
}

export function ManagedIdentity({
  value,
}: {
  readonly value: ManagedPlugin['selection'] | ManagedPlugin['active'];
}): ReactElement {
  return value === null ? (
    <span>无</span>
  ) : (
    <>
      {'version' in value ? <span>v{value.version}</span> : null}
      <span>激活序号 {value.activationSequence}</span>
      <code>{value.digest}</code>
    </>
  );
}

export function ManagedGithubSource({
  source,
}: {
  readonly source: GithubPluginSource;
}): ReactElement {
  return (
    <dl className="managed-github-source managed-identity">
      <div>
        <dt>GitHub 仓库</dt>
        <dd>
          <code>{source.repository}</code>
        </dd>
      </div>
      <div>
        <dt>完整提交</dt>
        <dd>
          <code>{source.commit}</code>
        </dd>
      </div>
      <div>
        <dt>插件子目录</dt>
        <dd>{source.subdirectory === '' ? '仓库根目录' : <code>{source.subdirectory}</code>}</dd>
      </div>
    </dl>
  );
}

export type ManagedDraft =
  | {
      readonly review: Extract<ManagedReview, { kind: 'import' }>;
      readonly sourceDirectory: string;
    }
  | {
      readonly review: Extract<ManagedReview, { kind: 'import' }>;
      readonly github: GithubPluginSource;
      readonly marketplacePublisher?: string;
    }
  | {
      readonly review: Exclude<ManagedReview, { kind: 'import' }>;
      readonly selectedManifest?: ManagedManifest;
      readonly github?: GithubPluginSource;
    };

function usePreviewExpired(expiresAt: string | undefined): boolean {
  const [expired, setExpired] = useState(
    () => expiresAt !== undefined && Date.parse(expiresAt) <= Date.now(),
  );
  useEffect(() => {
    if (expiresAt === undefined) return;
    const deadline = Date.parse(expiresAt);
    let timeout: number;
    const check = (): void => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) setExpired(true);
      else timeout = window.setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    check();
    return () => window.clearTimeout(timeout);
  }, [expiresAt]);
  return expired;
}

interface DialogFocusProps {
  readonly getFallbackFocus: () => HTMLElement | null;
  readonly onCancel: () => void;
}

export function ManagedPluginDialog({
  draft,
  blocked,
  onSubmit,
  onCancel,
  onReviewAgain,
  getFallbackFocus,
}: DialogFocusProps & {
  readonly draft: ManagedDraft;
  readonly blocked: boolean;
  readonly onSubmit: (review: ManagedReview) => Promise<ManagedAttemptOutcome>;
  readonly onReviewAgain: () => void;
}): ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const active = useRef(false);
  const pending = useRef(false);
  const warningId = useId();
  const immediateDescriptionId = useId();
  const [immediate, setImmediate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] =
    useState<Extract<ManagedAttemptOutcome, { kind: 'not-sent' | 'rejected' }>>();
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { review } = draft;
  const { kind } = review;
  const candidate = kind === 'import' ? review.preview.candidate : undefined;
  const manifest =
    kind === 'activate'
      ? review.manifest
      : 'selectedManifest' in draft
        ? draft.selectedManifest
        : candidate?.manifest;
  const pluginId = kind === 'import' ? review.preview.candidate.manifest.id : review.pluginId;
  const digest =
    kind === 'import'
      ? review.preview.candidate.digest
      : kind === 'activate'
        ? review.digest
        : review.selectedDigest;
  const expiresAt = kind === 'import' ? review.preview.expiresAt : undefined;
  const expired = usePreviewExpired(expiresAt);
  const locallyStale =
    result?.kind === 'not-sent' && result.error.code === 'plugin-managed-review-stale';
  const destructive = kind === 'disable' || kind === 'revoke' || kind === 'uninstall';
  const confirmsActivation = kind === 'activate' || kind === 'enable';
  const declarative = isDeclarativeSkillManifest(manifest);
  const action = managedAction(review);
  const canSubmit = !blocked && !submitting && !expired && !locallyStale;
  const submit = async (): Promise<void> => {
    if (!canSubmit || pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setResult(undefined);
    try {
      const outcome = await onSubmit(destructive ? { ...review, immediate } : review);
      if (!active.current) return;
      switch (outcome.kind) {
        case 'saved':
        case 'unresolved':
          onCancel();
          break;
        case 'rejected':
          if (outcome.recovery === 'retry-review') setResult(outcome);
          else onCancel();
          break;
        case 'not-sent':
          setResult(outcome);
          break;
      }
    } finally {
      pending.current = false;
      if (active.current) setSubmitting(false);
    }
  };
  return (
    <PluginDialog
      title={`${action}插件「${pluginId}」`}
      {...(confirmsActivation ? { descriptionId: warningId } : {})}
      cancelRef={cancelRef}
      onCancel={onCancel}
      getFallbackFocus={getFallbackFocus}
      fixedContent={
        confirmsActivation ? (
          <p className="plugin-dialog-warning" id={warningId}>
            {declarative
              ? declarativeSkillDisclosure
              : '插件代码拥有与 Weave 相同的系统权限，可访问文件、网络和会话内容。下方权限由插件声明。仅信任来源明确的插件。'}
          </p>
        ) : undefined
      }
      actions={
        <>
          <button ref={cancelRef} type="button" onClick={onCancel}>
            取消
          </button>
          {expired || locallyStale ? (
            <button type="button" onClick={onReviewAgain} disabled={blocked}>
              {kind === 'import' ? '重新预览' : '重新审查'}
            </button>
          ) : null}
          <button type="button" onClick={() => void submit()} disabled={!canSubmit}>
            确认{action}
          </button>
        </>
      }
    >
      {declarative ? <DeclarativeSkillPayload /> : null}
      <div className="plugin-review-identity managed-identity">
        <dl>
          <div>
            <dt>插件 ID</dt>
            <dd>{pluginId}</dd>
          </div>
          {manifest === undefined ? null : (
            <div>
              <dt>目标版本</dt>
              <dd>v{manifest.version}</dd>
            </div>
          )}
          {manifest !== undefined && (kind === 'activate' || kind === 'import') ? (
            <>
              <div>
                <dt>名称</dt>
                <dd>{manifest.name}</dd>
              </div>
              <div>
                <dt>API 版本</dt>
                <dd>{manifest.apiVersion}</dd>
              </div>
              {manifest.description === undefined ? null : (
                <div>
                  <dt>说明</dt>
                  <dd>{manifest.description}</dd>
                </div>
              )}
              {manifest.host === undefined ? null : (
                <div>
                  <dt>宿主</dt>
                  <dd>{manifest.host}</dd>
                </div>
              )}
              {manifest.engines === undefined ? null : (
                <div>
                  <dt>Weave 兼容</dt>
                  <dd>{manifest.engines.weave}</dd>
                </div>
              )}
            </>
          ) : null}
          <div>
            <dt>目标摘要</dt>
            <dd>{digest === null ? '无' : <code>{digest}</code>}</dd>
          </div>
          {kind === 'activate' ? (
            <div>
              <dt>前选择</dt>
              <dd>
                {review.previousSelection === null ? '无' : <code>{review.previousSelection}</code>}
              </dd>
            </div>
          ) : null}
          {'sourceDirectory' in draft ? (
            <div>
              <dt>来源目录</dt>
              <dd className="managed-source-path">{draft.sourceDirectory}</dd>
            </div>
          ) : null}
          {candidate === undefined ? null : (
            <div>
              <dt>内容</dt>
              <dd>
                {candidate.files} 个文件 · {candidate.bytes} 字节
              </dd>
            </div>
          )}
        </dl>
      </div>
      {'github' in draft && draft.github !== undefined ? (
        <ManagedGithubSource source={draft.github} />
      ) : null}
      {'marketplacePublisher' in draft ? (
        <p className="plugin-dialog-note">市场发布者：{draft.marketplacePublisher}（目录署名）</p>
      ) : null}
      {expiresAt === undefined ? null : (
        <p className="plugin-dialog-note">
          预览有效至 <time dateTime={expiresAt}>{new Date(expiresAt).toLocaleString()}</time>
        </p>
      )}
      {expired ? (
        <p className="plugin-dialog-error" role="status">
          预览已到期，请重新预览。
        </p>
      ) : null}
      {kind === 'import' ? <p>导入会保存候选版本。激活与授信需要单独确认。</p> : null}
      {destructive ? (
        <>
          {kind === 'uninstall' ? <p>卸载会清除当前选择和信任，并保留候选历史。</p> : null}
          <label className="plugin-immediate-choice">
            <input
              type="checkbox"
              aria-describedby={immediateDescriptionId}
              checked={immediate}
              onChange={(event) => setImmediate(event.target.checked)}
              disabled={!canSubmit}
            />
            立即生效（可能取消所有进行中的回合）
          </label>
          <p className="plugin-dialog-note" id={immediateDescriptionId}>
            默认让已有回合继续。勾选后，如果此插件仍在任一保留代际中，会取消 Server
            中所有会话在当前代和已退役代进行中的回合，包括与此插件无关的回合和当前界面不可见会话中的回合。
          </p>
          <p className="plugin-dialog-note">
            已保存的状态无需改变时，也可以勾选「立即生效」并再次确认，请求取消进行中的回合。
          </p>
        </>
      ) : null}
      {result === undefined ? null : (
        <p className="plugin-dialog-error" role="alert">
          {result.error.message}（{result.error.code}）
          {result.kind === 'rejected' ? managedRecoveryText(result.recovery) : null}
        </p>
      )}
      {manifest === undefined ? null : (
        <section aria-label="插件声明">
          <h3>插件声明</h3>
          <ManagedContributions values={manifest.contributes} manifest={manifest} />
        </section>
      )}
    </PluginDialog>
  );
}

export function ManagedRecoveryDialog({
  kind,
  blocked,
  onConfirm,
  onCancel,
  getFallbackFocus,
}: DialogFocusProps & {
  readonly kind: 'retry' | 'stop';
  readonly blocked: boolean;
  readonly onConfirm: () => Promise<void>;
}): ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const active = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const retry = kind === 'retry';
  const submit = async (): Promise<void> => {
    if (blocked || pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onConfirm();
      if (active.current) onCancel();
    } catch (reason) {
      if (active.current) setError(pluginDialogError(reason));
    } finally {
      pending.current = false;
      if (active.current) setSubmitting(false);
    }
  };
  return (
    <PluginDialog
      title={retry ? '重试原请求' : '停止跟踪原请求'}
      cancelRef={cancelRef}
      onCancel={onCancel}
      getFallbackFocus={getFallbackFocus}
      actions={
        <>
          <button ref={cancelRef} type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" onClick={() => void submit()} disabled={blocked || submitting}>
            {retry ? '确认重试' : '确认停止跟踪'}
          </button>
        </>
      }
    >
      <p>
        {retry
          ? '将重新发送同一个请求以核对决定。原决定未保存且原条件仍成立时，请求可能在本次执行。'
          : '原决定可能已经保存。停止跟踪后将重新读取目录，原决定仍可能生效。'}
      </p>
      {error === undefined ? null : (
        <p className="plugin-dialog-error" role="alert">
          {error}
        </p>
      )}
    </PluginDialog>
  );
}
