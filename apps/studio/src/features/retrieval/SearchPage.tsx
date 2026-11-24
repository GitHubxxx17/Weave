import { Search as SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { BuildForm } from './BuildForm.js';
import { createRetrievalClient, retrievalErrorMessage } from './client.js';
import { JobStatus } from './JobStatus.js';
import { SearchForm } from './SearchForm.js';
import {
  id,
  type RetrievalCapabilities,
  type RetrievalJob,
  type RetrievalReceipt,
  type RetrievalStatus,
} from './types.js';
import { useLatestRequest } from './useLatestRequest.js';
import './retrieval.css';

type Project = { id: string; name: string };

function ProjectSearch({ projectId }: { projectId: string }) {
  const client = useMemo(() => createRetrievalClient(projectId), [projectId]);
  const [capabilities, setCapabilities] = useState<RetrievalCapabilities>();
  const [status, setStatus] = useState<RetrievalStatus>();
  const [jobs, setJobs] = useState<{ jobs: RetrievalJob[]; nextCursor?: string | undefined }>();
  const [older, setOlder] = useState<{ jobs: RetrievalJob[]; nextCursor?: string | undefined }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [accepted, setAccepted] = useState<RetrievalReceipt>();
  const [reload, setReload] = useState(0);
  const [capabilitiesError, setCapabilitiesError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [actionError, setActionError] = useState('');
  const [cancelPending, setCancelPending] = useState<string>();
  const cancelRequest = useLatestRequest();
  const historyRequest = useLatestRequest();

  useEffect(() => {
    const controller = new AbortController();
    void client.capabilities(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setCapabilities(value);
          setCapabilitiesError('');
        }
      },
      (cause) => {
        if (!controller.signal.aborted) setCapabilitiesError(retrievalErrorMessage(cause));
      },
    );
    return () => controller.abort();
  }, [client, reload]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: AbortController | undefined;
    function suspend(): void {
      clearTimeout(timer);
      current?.abort();
      current = undefined;
    }
    function visibility(): void {
      suspend();
      if (!document.hidden) void poll();
    }
    async function poll(): Promise<void> {
      const controller = new AbortController();
      current = controller;
      const { signal } = controller;
      try {
        const [next, recent, watched] = await Promise.all([
          client.status(signal),
          client.jobs(undefined, signal),
          accepted ? client.job(accepted.jobId, signal).catch(() => undefined) : undefined,
        ]);
        if (signal.aborted) return;
        setStatus(
          watched && !watched.job.terminal
            ? { ...next, activeJob: next.activeJob ?? watched }
            : next,
        );
        setJobs(recent);
        if (
          watched?.job.terminal ||
          recent.jobs.some(({ job }) => job.receipt.jobId === accepted?.jobId && job.terminal)
        )
          setAccepted(undefined);
        setStatusError('');
      } catch (cause) {
        if (!signal.aborted) setStatusError(retrievalErrorMessage(cause));
      } finally {
        if (!signal.aborted && !document.hidden) timer = setTimeout(() => void poll(), 1000);
      }
    }
    document.addEventListener('visibilitychange', visibility);
    visibility();
    return () => {
      suspend();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [accepted, client, reload]);

  async function cancel(jobId: string): Promise<void> {
    const signal = cancelRequest.start();
    setCancelPending(jobId);
    setActionError('');
    try {
      await client.cancel(jobId, signal);
      if (!signal.aborted) setReload((value) => value + 1);
    } catch (cause) {
      if (!signal.aborted) setActionError(retrievalErrorMessage(cause));
    } finally {
      if (!signal.aborted) setCancelPending(undefined);
    }
  }

  async function loadMore(cursor: string): Promise<void> {
    const signal = historyRequest.start();
    setLoadingOlder(true);
    setActionError('');
    try {
      const page = await client.jobs(cursor, signal);
      if (!signal.aborted)
        setOlder((value) => ({ ...page, jobs: [...(value?.jobs ?? []), ...page.jobs] }));
    } catch (cause) {
      if (!signal.aborted) setActionError(retrievalErrorMessage(cause));
    } finally {
      if (!signal.aborted) setLoadingOlder(false);
    }
  }

  const ready = status?.availability === 'ready';
  const historyCursor = older === undefined ? jobs?.nextCursor : older.nextCursor;
  const history = [...(jobs?.jobs ?? []), ...(older?.jobs ?? [])].filter(
    (entry, i, all) =>
      all.findIndex((other) => other.job.receipt.jobId === entry.job.receipt.jobId) === i,
  );
  const rootKey = status
    ? `${status.project.folderRevision}:${status.project.rootDigest}`
    : undefined;
  const error = capabilitiesError || statusError;
  return (
    <>
      {(!capabilities || !status) && !error && <p role="status">正在连接检索服务…</p>}
      {capabilities && !capabilities.lexical.available && (
        <p role="alert">此运行时的 SQLite 缺少 FTS5，无法构建或搜索索引。</p>
      )}
      {error && (
        <div className="retrieval-alert">
          <p role="alert">{error}</p>
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            刷新状态
          </button>
        </div>
      )}
      {actionError && <p role="alert">{actionError}</p>}
      {status && (
        <div className="retrieval-layout" key={rootKey}>
          <SearchForm
            client={client}
            capabilities={capabilities}
            ready={ready}
            hybridReady={ready && status.active?.mode === 'hybrid'}
          />
          <aside className="retrieval-sidebar">
            <JobStatus
              status={status}
              jobs={history}
              cancelPending={cancelPending}
              onCancel={(jobId) => void cancel(jobId)}
              onMore={
                historyCursor && !loadingOlder ? () => void loadMore(historyCursor) : undefined
              }
            />
            {accepted && !status?.activeJob && <p role="status">已接受构建，正在读取进度…</p>}
            <BuildForm
              client={client}
              projectId={projectId}
              capabilities={capabilities}
              busy={Boolean(accepted || status?.activeJob)}
              onAccepted={setAccepted}
            />
          </aside>
        </div>
      )}
    </>
  );
}

export function SearchPage({
  selectedProjectId,
  projectName,
  projects,
}: {
  selectedProjectId: string;
  projectName?: string;
  projects?: readonly Project[];
}) {
  const [selection, setSelection] = useState<{ base: string; projectId: string }>();
  const projectId =
    selection?.base === selectedProjectId && projects?.some(({ id }) => id === selection.projectId)
      ? selection.projectId
      : selectedProjectId;
  const valid = id.safeParse(projectId).success;
  return (
    <section className="retrieval-page" aria-labelledby="retrieval-title">
      <header className="retrieval-header">
        <div>
          <SearchIcon aria-hidden="true" />
          <h1 id="retrieval-title">项目搜索</h1>
        </div>
        {projects && projects.length > 0 ? (
          <label className="retrieval-field-inline">
            项目
            <select
              value={projectId}
              onChange={(event) =>
                setSelection({ base: selectedProjectId, projectId: event.currentTarget.value })
              }
            >
              {!valid && <option value={projectId}>选择项目</option>}
              {projects.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          projectName && <span className="retrieval-muted">{projectName}</span>
        )}
      </header>
      {valid ? (
        <ProjectSearch key={projectId} projectId={projectId} />
      ) : (
        <p className="retrieval-muted">请选择一个本地项目。</p>
      )}
    </section>
  );
}
