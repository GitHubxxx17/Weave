import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';

import { PluginDialog, pluginDialogError } from '../plugins/plugin-dialog.js';
import { McpApiError } from './mcp-api.js';
import { unboundArgumentPaths } from './mcp-review.js';
import { mcpServerConfigSchema, type McpServerConfig } from './mcp-types.js';

import './mcp-dialog.css';

export interface McpConfigDialogProps {
  readonly initial?: McpServerConfig | undefined;
  readonly expectedSequence: number;
  readonly busy: boolean;
  readonly stale: boolean;
  readonly onSave: (config: McpServerConfig, expectedSequence: number) => Promise<void>;
  readonly onCancel: () => void;
  readonly getFallbackFocus: () => HTMLElement | null;
}

interface EnvironmentRow {
  readonly key: number;
  readonly target: string;
  readonly reference: string;
}

const fieldNames: Readonly<Record<string, string>> = {
  id: '服务 ID',
  label: '显示名称',
  command: '启动程序',
  args: '参数',
  cwd: '工作目录',
  env: '环境引用',
  contentPaths: '绑定内容路径',
  callTimeoutMs: '调用超时',
};
const staleMessage = '配置或授权已变化，本次配置已失效。请关闭后重新打开，保留草稿供你复制。';

/** Owns only the draft and captured CAS token; saving never authorizes launch. */
export function McpConfigDialog({
  initial,
  expectedSequence,
  busy,
  stale,
  onSave,
  onCancel,
  getFallbackFocus,
}: McpConfigDialogProps): ReactElement {
  const [captured] = useState(() => ({ initial, expectedSequence }));
  const [id, setId] = useState(() => initial?.id ?? '');
  const [label, setLabel] = useState(() => initial?.label ?? '');
  const [command, setCommand] = useState(() => initial?.command ?? '');
  const [cwd, setCwd] = useState(() => initial?.cwd ?? '');
  const [argsText, setArgsText] = useState(() => JSON.stringify(initial?.args ?? [], null, 2));
  const [pathsText, setPathsText] = useState(() => (initial?.contentPaths ?? []).join('\n'));
  const [timeoutText, setTimeoutText] = useState(() =>
    initial?.callTimeoutMs === undefined ? '' : String(initial.callTimeoutMs / 1000),
  );
  const [rows, setRows] = useState<readonly EnvironmentRow[]>(() =>
    Object.entries(initial?.env ?? {}).map(([target, value], key) => ({
      key,
      target,
      reference: value.fromHostEnv,
    })),
  );
  const nextRowKey = useRef(rows.length);
  const targetRefs = useRef(new Map<number, HTMLInputElement>());
  const focusTarget = useRef<number | 'add' | undefined>(undefined);
  const addRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const active = useRef(true);
  const [submitting, setSubmitting] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const [error, setError] = useState<{ readonly field?: string; readonly message: string }>();
  const errorId = useId();
  const hintId = useId();

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    const target = focusTarget.current;
    if (target === undefined) return;
    focusTarget.current = undefined;
    if (target === 'add') addRef.current?.focus();
    else targetRefs.current.get(target)?.focus();
  }, [rows]);

  const contentPaths = pathsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const suggestedPaths = (() => {
    try {
      const parsed = JSON.parse(argsText) as unknown;
      return Array.isArray(parsed)
        ? unboundArgumentPaths(
            parsed.filter((value): value is string => typeof value === 'string'),
            contentPaths,
          )
        : [];
    } catch {
      return [];
    }
  })();
  const expired = stale || invalidated;
  const canSubmit = !busy && !submitting && !expired;
  const fieldProps = (field: string) => ({
    'aria-invalid': error?.field === field ? true : undefined,
    'aria-describedby': error?.field === field ? errorId : undefined,
  });
  const updateRow = (key: number, patch: Partial<Pick<EnvironmentRow, 'target' | 'reference'>>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };
  const addRow = () => {
    if (rows.length >= 32) return;
    const key = nextRowKey.current++;
    focusTarget.current = key;
    setRows((current) => [...current, { key, target: '', reference: '' }]);
  };
  const removeRow = (key: number) => {
    const index = rows.findIndex((row) => row.key === key);
    focusTarget.current = rows[index + 1]?.key ?? rows[index - 1]?.key ?? 'add';
    setRows((current) => current.filter((row) => row.key !== key));
  };
  const submit = async (): Promise<void> => {
    if (!canSubmit || submitted.current) return;
    let args: unknown;
    try {
      args = JSON.parse(argsText) as unknown;
    } catch {
      setError({ field: 'args', message: '参数必须是 JSON 字符串数组，例如 ["--stdio", ""]。' });
      return;
    }
    if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
      setError({
        field: 'args',
        message: '参数必须是 JSON 字符串数组，每个元素都是一个完整参数。',
      });
      return;
    }
    const targets = new Set<string>();
    for (const row of rows) {
      if (targets.has(row.target)) {
        setError({ field: 'env', message: '环境目标变量重复，请为每个目标只保留一个引用。' });
        return;
      }
      targets.add(row.target);
    }
    const env = Object.fromEntries(rows.map((row) => [row.target, { fromHostEnv: row.reference }]));
    const timeoutSeconds = timeoutText.trim() === '' ? undefined : Number(timeoutText.trim());
    if (
      timeoutSeconds !== undefined &&
      (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600)
    ) {
      setError({ field: 'callTimeoutMs', message: '调用超时必须是 1 到 600 之间的整数秒。' });
      return;
    }
    const result = mcpServerConfigSchema.safeParse({
      schemaVersion: 1,
      id,
      label,
      transport: 'stdio',
      command,
      args,
      cwd,
      env,
      ...(contentPaths.length === 0 ? {} : { contentPaths }),
      ...(timeoutSeconds === undefined ? {} : { callTimeoutMs: timeoutSeconds * 1000 }),
    });
    if (!result.success) {
      const field = String(result.error.issues[0]?.path[0] ?? '');
      setError({
        field,
        message: `${fieldNames[field] ?? '配置'}格式或长度不符合要求，请检查后重试。`,
      });
      return;
    }
    submitted.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onSave(result.data, captured.expectedSequence);
      if (active.current) onCancel();
    } catch (reason: unknown) {
      if (!active.current) return;
      if (reason instanceof McpApiError && reason.status === 409) {
        setInvalidated(true);
        setError({ message: staleMessage });
      } else setError({ message: pluginDialogError(reason) });
      setSubmitting(false);
      submitted.current = false;
    }
  };

  return (
    <PluginDialog
      title={
        captured.initial === undefined
          ? '添加本地 MCP 服务'
          : `编辑「${captured.initial.label}」的配置`
      }
      descriptionId={hintId}
      cancelRef={cancelRef}
      onCancel={onCancel}
      getFallbackFocus={getFallbackFocus}
      actions={
        <>
          <button ref={cancelRef} type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            保存配置
          </button>
        </>
      }
    >
      <p className="plugin-dialog-note" id={hintId}>
        保存只维护启动配置。新配置或启动字段变化后，需要另行审阅并信任才会启动程序。
      </p>
      <div className="mcp-config-fields">
        <label>
          服务 ID
          <input
            value={id}
            readOnly={captured.initial !== undefined}
            disabled={busy || submitting}
            onChange={(event) => setId(event.target.value)}
            {...fieldProps('id')}
          />
        </label>
        <small>最多 24 个小写字母、数字和连字符；保存后不可修改。</small>
        <label>
          显示名称
          <input
            value={label}
            disabled={busy || submitting}
            onChange={(event) => setLabel(event.target.value)}
            {...fieldProps('label')}
          />
        </label>
        <label>
          启动程序
          <input
            value={command}
            disabled={busy || submitting}
            onChange={(event) => setCommand(event.target.value)}
            {...fieldProps('command')}
          />
        </label>
        <small>填写 Weave Server 电脑上的程序绝对路径，不是整条命令。</small>
        <label>
          工作目录
          <input
            value={cwd}
            disabled={busy || submitting}
            onChange={(event) => setCwd(event.target.value)}
            {...fieldProps('cwd')}
          />
        </label>
        <small>填写 Weave Server 电脑上的绝对目录。Server 会核对并返回规范路径。</small>
        <label>
          参数（JSON 字符串数组）
          <textarea
            value={argsText}
            rows={4}
            disabled={busy || submitting}
            onChange={(event) => setArgsText(event.target.value)}
            {...fieldProps('args')}
          />
        </label>
        <small>
          每个字符串是一个原样传入的参数，保留空字符串、空格及顺序；不进行 shell 拆分或展开。最多 64
          项，每项最多 4096 UTF-8 字节。
        </small>
        <label>
          绑定内容路径（每行一个绝对路径）
          <textarea
            value={pathsText}
            rows={3}
            disabled={busy || submitting}
            onChange={(event) => setPathsText(event.target.value)}
            {...fieldProps('contentPaths')}
          />
        </label>
        <small>
          启动程序文件本身总会被绑定。这里可以再加入脚本文件或项目目录（最多 16 项，目录最多 1000
          个文件、20 MB，不能含符号链接）；这些内容变化后，信任失效，需要重新保存并信任。
        </small>
        <label>
          调用超时（秒）
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={600}
            step={1}
            placeholder="120"
            value={timeoutText}
            disabled={busy || submitting}
            onChange={(event) => setTimeoutText(event.target.value)}
            {...fieldProps('callTimeoutMs')}
          />
        </label>
        <small>
          单次工具调用的最长等待时间，1 到 600 秒，留空为 120 秒。修改后需要重新审阅并信任。
        </small>
        {suggestedPaths.length === 0 ? null : (
          <div className="mcp-content-suggestions" aria-label="建议绑定的路径">
            <p className="plugin-dialog-note">参数中出现了下列绝对路径，是否加入绑定内容？</p>
            <ul>
              {suggestedPaths.map((value) => (
                <li key={value}>
                  <code>{value}</code>{' '}
                  <button
                    type="button"
                    disabled={busy || submitting || contentPaths.length >= 16}
                    onClick={() =>
                      setPathsText((current) =>
                        current.trim() === '' ? value : `${current}\n${value}`,
                      )
                    }
                  >
                    加入绑定内容
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <fieldset className="mcp-environment-fields" disabled={busy || submitting}>
        <legend>环境变量引用</legend>
        <p className="plugin-dialog-note">
          只填写变量名称，凭据值由 Server 在启动时从宿主环境读取。不要在参数或这里填写秘密值。
        </p>
        {rows.map((row, index) => (
          <div className="mcp-environment-row" key={row.key}>
            <label>
              目标变量 {index + 1}
              <input
                ref={(element) => {
                  if (element) targetRefs.current.set(row.key, element);
                  else targetRefs.current.delete(row.key);
                }}
                value={row.target}
                onChange={(event) => updateRow(row.key, { target: event.target.value })}
                {...fieldProps('env')}
              />
            </label>
            <label>
              宿主变量引用 {index + 1}
              <input
                value={row.reference}
                onChange={(event) => updateRow(row.key, { reference: event.target.value })}
                {...fieldProps('env')}
              />
            </label>
            <button
              type="button"
              aria-label={`移除环境引用 ${index + 1}`}
              onClick={() => removeRow(row.key)}
            >
              移除
            </button>
          </div>
        ))}
        <button ref={addRef} type="button" onClick={addRow} disabled={rows.length >= 32}>
          添加环境引用
        </button>
        <small>最多 32 项；变量名使用字母、数字和下划线，不能以数字开头或使用 WEAVE_ 前缀。</small>
      </fieldset>
      {error === undefined && !expired ? null : (
        <p role="alert" id={errorId} className="plugin-dialog-error">
          {expired ? staleMessage : error?.message}
        </p>
      )}
    </PluginDialog>
  );
}
