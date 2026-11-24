import { useLayoutEffect, useId, useRef, useState, type ReactElement } from 'react';

import {
  contributionLabels,
  ManagedGithubSource,
  managedRecoveryText,
  usePreviewExpired,
} from './managed-plugin-dialog.js';
import type {
  ManagedManifest,
  ManagedUpdatePreview,
  ManagedUpdateReview,
} from './managed-plugin-types.js';
import { isDeclarativeSkillManifest } from './managed-plugin-types.js';
import type { ManagedAttemptOutcome } from './plugin-catalog-store.js';
import { PluginDialog } from './plugin-dialog.js';
import { declarativeSkillDisclosure } from './plugin-payload-description.js';
import { pluginImpact } from './plugin-review.js';

export interface DeclarationChange {
  readonly label: string;
  readonly name: string;
  readonly change: 'added' | 'removed';
  readonly impact: ReturnType<typeof pluginImpact> | undefined;
}

function declarationRows(manifest: ManagedManifest) {
  return [
    { label: '能力', names: manifest.capabilities, impact: undefined },
    ...contributionLabels.map(([category, label]) => ({
      label,
      names: manifest.contributes[category] ?? [],
      impact: category === 'hooks' ? ('hook' as const) : undefined,
    })),
    { label: '权限', names: manifest.permissions, impact: 'permission' as const },
  ];
}

/** Lists what the new version adds to or drops from the installed version's declarations. */
export function declarationChanges(
  current: ManagedManifest,
  next: ManagedManifest,
): readonly DeclarationChange[] {
  const before = declarationRows(current);
  const changes: DeclarationChange[] = [];
  declarationRows(next).forEach(({ label, names, impact }, index) => {
    const previous = new Set<string>(before[index]?.names ?? []);
    const upcoming = new Set<string>(names);
    for (const name of upcoming) {
      if (!previous.has(name)) {
        changes.push({
          label,
          name,
          change: 'added',
          impact: impact === undefined ? undefined : pluginImpact(impact, name),
        });
      }
    }
    for (const name of previous) {
      if (!upcoming.has(name)) changes.push({ label, name, change: 'removed', impact: undefined });
    }
  });
  return changes;
}

export function ManagedUpdateDialog({
  preview,
  blocked,
  onSubmit,
  onCancel,
  getFallbackFocus,
}: {
  readonly preview: ManagedUpdatePreview;
  readonly blocked: boolean;
  readonly onSubmit: (review: ManagedUpdateReview) => Promise<ManagedAttemptOutcome>;
  readonly onCancel: () => void;
  readonly getFallbackFocus: () => HTMLElement | null;
}): ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const active = useRef(false);
  const pending = useRef(false);
  const warningId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] =
    useState<Extract<ManagedAttemptOutcome, { kind: 'not-sent' | 'rejected' }>>();
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { pluginId, current, candidate, update } = preview;
  const expired = usePreviewExpired(preview.expiresAt);
  const changes = declarationChanges(current.manifest, candidate.manifest);
  const declarative = isDeclarativeSkillManifest(candidate.manifest);
  const stale = result?.kind === 'not-sent' && result.error.code === 'plugin-managed-review-stale';
  const canSubmit = !blocked && !submitting && !expired && !stale;
  const submit = async (): Promise<void> => {
    if (!canSubmit || pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setResult(undefined);
    try {
      const outcome = await onSubmit({
        pluginId,
        previewId: preview.previewId,
        // The digest covers the manifest, so the confirmation names exactly this content.
        candidateDigest: candidate.digest,
        previousSelection: preview.previousSelection,
        expectedInstallSequence: preview.expectedInstallSequence,
        expectedTrustSequence: preview.expectedTrustSequence,
      });
      if (!active.current) return;
      if (outcome.kind === 'not-sent') setResult(outcome);
      else onCancel();
    } finally {
      pending.current = false;
      if (active.current) setSubmitting(false);
    }
  };
  return (
    <PluginDialog
      title={`更新插件「${pluginId}」`}
      descriptionId={warningId}
      cancelRef={cancelRef}
      onCancel={onCancel}
      getFallbackFocus={getFallbackFocus}
      fixedContent={
        <p className="plugin-dialog-warning" id={warningId}>
          {declarative
            ? declarativeSkillDisclosure
            : '更新会用新版本替换当前版本并重新授信、启用。插件代码拥有与 Weave 相同的系统权限，可访问文件、网络和会话内容。'}
        </p>
      }
      actions={
        <>
          <button ref={cancelRef} type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" onClick={() => void submit()} disabled={!canSubmit}>
            确认更新
          </button>
        </>
      }
    >
      <div className="plugin-review-identity managed-identity">
        <dl>
          <div>
            <dt>插件 ID</dt>
            <dd>{pluginId}</dd>
          </div>
          <div>
            <dt>当前版本</dt>
            <dd>
              v{current.manifest.version} · <code>{current.digest}</code>
            </dd>
          </div>
          <div>
            <dt>新版本</dt>
            <dd>
              v{candidate.manifest.version} · <code>{candidate.digest}</code>
            </dd>
          </div>
          <div>
            <dt>内容</dt>
            <dd>
              {candidate.files} 个文件 · {candidate.bytes} 字节
            </dd>
          </div>
        </dl>
      </div>
      <ManagedGithubSource source={update.source} />
      <p className="plugin-dialog-note">
        预览有效至{' '}
        <time dateTime={preview.expiresAt}>{new Date(preview.expiresAt).toLocaleString()}</time>
      </p>
      {expired ? (
        <p className="plugin-dialog-error" role="status">
          预览已到期，请重新检查更新。
        </p>
      ) : null}
      <section aria-label="声明与权限变化">
        <h3>声明与权限变化</h3>
        {changes.length === 0 ? (
          <p className="plugin-note">新版本的能力、贡献与权限声明没有变化</p>
        ) : (
          <ul className="plugin-declaration-list">
            {changes.map(({ label, name, change, impact }) => (
              <li
                key={`${change}:${label}:${name}`}
                className={impact?.level === 'high' ? 'plugin-impact-high' : undefined}
              >
                <strong>{change === 'added' ? '新增' : '移除'}</strong> <span>{label}</span>{' '}
                <code>{name}</code>
                {impact === undefined ? null : <small>{impact.description}</small>}
              </li>
            ))}
          </ul>
        )}
      </section>
      {result === undefined ? null : (
        <p className="plugin-dialog-error" role="alert">
          {result.error.message}（{result.error.code}）
          {result.kind === 'rejected' ? managedRecoveryText(result.recovery) : null}
        </p>
      )}
    </PluginDialog>
  );
}
