import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';

import { PluginApiError } from './plugin-api.js';
import { PluginDialog, pluginDialogError } from './plugin-dialog.js';
import { diffManifestDeclarations, pluginImpact, type PluginReview } from './plugin-review.js';

const warning =
  '信任后，这个插件的代码会以和 Weave 相同的权限在你的电脑上运行。它可以读写你能访问的文件、联网、读取所有会话内容。下面是插件自己的声明，Weave 无法限制进程内插件的实际行为。只信任你了解其来源的插件。';

const declarationLabels: Readonly<Record<string, string>> = {
  capabilities: '能力',
  tools: '工具',
  providers: '提供方',
  promptSections: '提示词片段',
  events: '会话事件',
  commands: '命令',
  skills: '技能',
  hooks: '钩子',
  services: '服务',
  permissions: '权限',
};
const impactOrder = { high: 0, medium: 1, low: 2 } as const;

export interface PluginTrustDialogProps {
  readonly review: PluginReview;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onTrust: (review: PluginReview) => Promise<void>;
  readonly getFallbackFocus: () => HTMLElement | null;
}

function declarationRows(review: PluginReview): Array<{
  readonly category: string;
  readonly value: string;
  readonly level?: 'high' | 'medium' | 'low';
  readonly description?: string;
  readonly recognized?: boolean;
}> {
  const rows: Array<{
    category: string;
    value: string;
    level?: 'high' | 'medium' | 'low';
    description?: string;
    recognized?: boolean;
  }> = [];
  for (const category of Object.keys(declarationLabels)) {
    const values =
      category === 'capabilities'
        ? review.manifest.capabilities
        : category === 'permissions'
          ? (review.manifest.permissions ?? [])
          : (review.manifest.contributes?.[
              category as keyof NonNullable<PluginReview['manifest']['contributes']>
            ] ?? []);
    for (const value of new Set(values)) {
      const impact =
        category === 'hooks' || category === 'permissions'
          ? pluginImpact(category === 'hooks' ? 'hook' : 'permission', value)
          : undefined;
      rows.push({ category, value, ...(impact ?? {}) });
    }
  }
  return rows.sort((a, b) => impactOrder[a.level ?? 'low'] - impactOrder[b.level ?? 'low']);
}

export function PluginTrustDialog({
  review: initialReview,
  busy,
  onCancel,
  onTrust,
  getFallbackFocus,
}: PluginTrustDialogProps): ReactElement {
  const [review] = useState(() => initialReview);
  const warningId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [submitting, setSubmitting] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const rows = useMemo(() => declarationRows(review), [review]);
  const changes = useMemo(
    () =>
      review.previousTrusted === undefined
        ? []
        : diffManifestDeclarations(review.previousTrusted.manifest, review.manifest),
    [review],
  );
  const canSubmit = !busy && !submitting && !stale;
  const submit = async (): Promise<void> => {
    if (!canSubmit || submitted.current) return;
    submitted.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onTrust(review);
      if (active.current) onCancel();
    } catch (reason: unknown) {
      if (!active.current) return;
      if (
        reason instanceof PluginApiError &&
        reason.status === 409 &&
        reason.code === 'plugin-digest-mismatch'
      ) {
        setStale(true);
        setError('目录内容已经变化，本次审阅已失效。请关闭后重新审阅。');
      } else setError(pluginDialogError(reason));
      setSubmitting(false);
      submitted.current = false;
    }
  };

  const title =
    review.previousTrusted === undefined
      ? `信任插件「${review.name}」？`
      : `插件「${review.name}」已更新，请重新确认`;
  return (
    <PluginDialog
      title={title}
      descriptionId={warningId}
      cancelRef={cancelRef}
      onCancel={onCancel}
      getFallbackFocus={getFallbackFocus}
      fixedContent={
        <p className="plugin-dialog-warning" id={warningId}>
          {warning}
        </p>
      }
      actions={
        <>
          <button ref={cancelRef} type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" onClick={() => void submit()} disabled={!canSubmit}>
            信任并启用
          </button>
        </>
      }
    >
      <div className="plugin-review-identity">
        <dl>
          <div>
            <dt>ID</dt>
            <dd>{review.id}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>{review.version}</dd>
          </div>
          <div>
            <dt>说明</dt>
            <dd>{review.description ?? '—'}</dd>
          </div>
          <div>
            <dt>来源目录</dt>
            <dd>{review.directory}</dd>
          </div>
          <div>
            <dt>摘要</dt>
            <dd>
              <span aria-hidden="true">{review.digest.slice(0, 12)}</span>
              <input aria-label="完整摘要" readOnly value={review.digest} />
            </dd>
          </div>
        </dl>
      </div>
      {error === undefined ? null : (
        <p role="alert" className="plugin-dialog-error">
          {error}
        </p>
      )}
      {review.previousTrusted === undefined ? null : (
        <section className="plugin-review-differences" aria-label="声明差异">
          <h3>声明差异</h3>
          <p>
            版本：
            <span>
              {review.previousTrusted.manifest.version} → {review.manifest.version}
            </span>
          </p>
          {changes.length === 0 ? (
            <p>声明没有变化，但代码已更新</p>
          ) : (
            changes.map((change) => (
              <div key={change.category}>
                <strong>{declarationLabels[change.category]}</strong>
                {change.added.length === 0 && change.removed.length === 0 ? null : (
                  <>
                    {change.added.length === 0 ? null : (
                      <p>
                        新增：
                        {change.added.map((value) => (
                          <code key={value}>{value}</code>
                        ))}
                      </p>
                    )}
                    {change.removed.length === 0 ? null : (
                      <p>
                        移除：
                        {change.removed.map((value) => (
                          <code key={value}>{value}</code>
                        ))}
                      </p>
                    )}
                  </>
                )}
              </div>
            ))
          )}
        </section>
      )}
      <section aria-label="插件声明">
        <h3>它声明了</h3>
        <ul className="plugin-declaration-list" aria-label="钩子与权限影响">
          {rows.map((row) => (
            <li
              data-category={row.category}
              key={`${row.category}:${row.value}`}
              className={row.level === 'high' ? 'plugin-impact-high' : undefined}
            >
              <span>{declarationLabels[row.category]}</span> <code>{row.value}</code>
              {row.level === undefined ? null : (
                <>
                  <strong>
                    {row.level === 'high' ? '高' : row.level === 'medium' ? '中' : '低'}
                  </strong>
                  {row.recognized === false ? <em>未识别</em> : null}
                  <small>{row.description}</small>
                </>
              )}
              {row.level === 'high' &&
              changes.some(
                (change) => change.category === row.category && change.added.includes(row.value),
              ) ? (
                <strong className="plugin-added-high">新增高影响</strong>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </PluginDialog>
  );
}
