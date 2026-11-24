import { ListFilter } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { createMemoryClient } from '../memory/client.js';
import type { MemoryRef, MemorySummary } from '../memory/types.js';
import { BuildPreview } from './BuildPreview.js';
import { RetrievalApiError, retrievalErrorMessage, type RetrievalClient } from './client.js';
import { splitPrefixes } from './SearchForm.js';
import type {
  RetrievalCapabilities,
  RetrievalMode,
  RetrievalPreview,
  RetrievalReceipt,
} from './types.js';
import { useLatestRequest } from './useLatestRequest.js';

const memoryClient = createMemoryClient();
const retryCodes = new Set([
  'retrieval-api-network',
  'retrieval-api-protocol',
  'retrieval-persistence-uncertain',
]);

export function BuildForm({
  client,
  capabilities,
  projectId,
  busy,
  onAccepted,
}: {
  client: RetrievalClient;
  capabilities: RetrievalCapabilities | undefined;
  projectId: string;
  busy: boolean;
  onAccepted: (receipt: RetrievalReceipt) => void;
}) {
  const [mode, setMode] = useState<RetrievalMode>('lexical');
  const [workspace, setWorkspace] = useState(true);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [selectedFiles, setSelectedFiles] = useState('');
  const [memoryRefs, setMemoryRefs] = useState<MemoryRef[]>([]);
  const [memories, setMemories] = useState<{ records: MemorySummary[]; cursor?: string }>();
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState('');
  const [preview, setPreview] = useState<RetrievalPreview>();
  const [pending, setPending] = useState<'prepare' | 'build'>();
  const [retry, setRetry] = useState(false);
  const [error, setError] = useState('');
  const buildRequest = useLatestRequest();
  const memoryRequest = useLatestRequest();
  const canEmbed = capabilities?.embedding.configured;

  function change(): void {
    buildRequest.clear();
    setPreview(undefined);
    setPending(undefined);
    setRetry(false);
    setError('');
  }
  async function loadMemory(cursor?: string): Promise<void> {
    const signal = memoryRequest.start();
    setMemoryLoading(true);
    setMemoryError('');
    try {
      const page = await memoryClient.list(
        { kind: 'project', projectId },
        {
          limit: 50,
          includeAgentAuthored: false,
          ...(cursor ? { cursor } : {}),
        },
        signal,
      );
      if (!signal.aborted)
        setMemories((current) => ({
          records: [
            ...(cursor ? (current?.records ?? []) : []),
            ...page.records.filter((record) => record.review === 'user-reviewed'),
          ],
          ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
        }));
    } catch {
      if (!signal.aborted) setMemoryError('无法加载已审阅记忆，请重试。');
    } finally {
      if (!signal.aborted) setMemoryLoading(false);
    }
  }
  async function prepare(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      pending ||
      busy ||
      !capabilities?.lexical.available ||
      (!workspace && memoryRefs.length === 0) ||
      (mode === 'hybrid' && !canEmbed)
    )
      return;
    change();
    const signal = buildRequest.start();
    const exactPaths = workspace ? splitPrefixes(selectedFiles) : [];
    setPending('prepare');
    try {
      const value = await client.prepare(
        {
          requestId: crypto.randomUUID(),
          intent: {
            mode,
            workspace: {
              enabled: workspace,
              paths: {
                include: workspace ? splitPrefixes(include) : [],
                exclude: workspace ? splitPrefixes(exclude) : [],
              },
              ...(exactPaths.length > 0 ? { selectedPaths: exactPaths } : {}),
            },
            memoryRefs,
          },
        },
        signal,
      );
      if (!signal.aborted) setPreview(value);
    } catch (cause) {
      if (!signal.aborted) setError(retrievalErrorMessage(cause));
    } finally {
      if (!signal.aborted) setPending(undefined);
    }
  }
  async function confirm(): Promise<void> {
    if (!preview || pending || (busy && !retry)) return;
    const signal = buildRequest.start();
    const { requestId, previewId, mode, manifestDigest } = preview;
    setPending('build');
    setError('');
    try {
      const receipt = await client.build({ requestId, previewId, mode, manifestDigest }, signal);
      if (!signal.aborted) {
        setPreview(undefined);
        setRetry(false);
        onAccepted(receipt);
      }
    } catch (cause) {
      if (signal.aborted) return;
      setError(retrievalErrorMessage(cause));
      setRetry(cause instanceof RetrievalApiError && retryCodes.has(cause.code));
      if (
        cause instanceof RetrievalApiError &&
        [
          'retrieval-stale-preview',
          'retrieval-root-changed',
          'retrieval-request-conflict',
        ].includes(cause.code)
      )
        setPreview(undefined);
    } finally {
      if (!signal.aborted) setPending(undefined);
    }
  }

  return (
    <section className="retrieval-build" aria-label="索引构建">
      <h2>索引构建</h2>
      <form aria-label="索引构建设置" onSubmit={(event) => void prepare(event)}>
        <fieldset
          className="retrieval-segmented"
          aria-label="索引类型"
          disabled={pending === 'build'}
        >
          <label>
            <input
              type="radio"
              name="retrieval-build-mode"
              checked={mode === 'lexical'}
              onChange={() => {
                change();
                setMode('lexical');
              }}
            />
            本地索引
          </label>
          <label>
            <input
              type="radio"
              name="retrieval-build-mode"
              checked={mode === 'hybrid'}
              disabled={!canEmbed}
              onChange={() => {
                change();
                setMode('hybrid');
              }}
            />
            混合索引
          </label>
        </fieldset>
        {capabilities && !canEmbed && <p className="retrieval-muted">语义向量服务未配置。</p>}
        <fieldset
          className="retrieval-build-fields"
          aria-label="构建来源"
          disabled={pending === 'build'}
        >
          <label className="retrieval-checkbox">
            <input
              type="checkbox"
              checked={workspace}
              onChange={(event) => {
                change();
                setWorkspace(event.currentTarget.checked);
              }}
            />
            纳入项目文件
          </label>
          <label>
            纳入构建的路径前缀
            <textarea
              rows={2}
              placeholder="src"
              value={include}
              disabled={!workspace}
              onChange={(event) => {
                change();
                setInclude(event.currentTarget.value);
              }}
            />
          </label>
          <details>
            <summary>更多路径条件</summary>
            <label>
              排除构建的路径前缀
              <textarea
                rows={2}
                placeholder="fixtures"
                value={exclude}
                disabled={!workspace}
                onChange={(event) => {
                  change();
                  setExclude(event.currentTarget.value);
                }}
              />
            </label>
            <label>
              仅构建指定文件
              <textarea
                rows={2}
                placeholder="src/main.ts"
                value={selectedFiles}
                disabled={!workspace}
                onChange={(event) => {
                  change();
                  setSelectedFiles(event.currentTarget.value);
                }}
              />
            </label>
          </details>
          <details
            onToggle={(event) => {
              if (event.currentTarget.open && !memories && !memoryLoading && !memoryError)
                void loadMemory();
            }}
          >
            <summary>已审阅记忆 · 已选 {memoryRefs.length}/48</summary>
            {memoryLoading && <p role="status">正在加载记忆…</p>}
            {memoryError && <p role="alert">{memoryError}</p>}
            {memories?.records.length === 0 && (
              <p className="retrieval-muted">没有已审阅的项目记忆。</p>
            )}
            <ul className="retrieval-compact-list">
              {memories?.records.map(({ ref, title }) => {
                const selected = memoryRefs.some((value) => value.memoryId === ref.memoryId);
                return (
                  <li key={ref.memoryId}>
                    <label className="retrieval-checkbox">
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={!selected && memoryRefs.length >= 48}
                        onChange={(event) => {
                          change();
                          setMemoryRefs(
                            event.currentTarget.checked
                              ? [...memoryRefs, ref]
                              : memoryRefs.filter((value) => value.memoryId !== ref.memoryId),
                          );
                        }}
                      />
                      {title}
                    </label>
                  </li>
                );
              })}
            </ul>
            {memories?.cursor && (
              <button
                type="button"
                disabled={memoryLoading}
                onClick={() => void loadMemory(memories.cursor)}
              >
                加载更多记忆
              </button>
            )}
            {memoryError && !memories && (
              <button type="button" onClick={() => void loadMemory()}>
                重试加载记忆
              </button>
            )}
          </details>
        </fieldset>
        <button
          type="submit"
          disabled={
            busy ||
            pending !== undefined ||
            !capabilities?.lexical.available ||
            (!workspace && memoryRefs.length === 0) ||
            (mode === 'hybrid' && !canEmbed)
          }
        >
          <ListFilter aria-hidden="true" />
          生成构建预览
        </button>
      </form>
      {pending && <p role="status">{pending === 'prepare' ? '正在准备预览…' : '正在提交构建…'}</p>}
      {error && <p role="alert">{error}</p>}
      {preview && (
        <BuildPreview
          key={preview.previewId}
          client={client}
          preview={preview}
          pending={pending === 'build'}
          busy={busy}
          retry={retry}
          onConfirm={() => void confirm()}
        />
      )}
    </section>
  );
}
