import { useEffect, useRef, useState, type ReactElement } from 'react';
import { DiffModeEnum, DiffView } from '@git-diff-view/react';
import { generateDiffFile } from '@git-diff-view/file';
import { getDiffViewHighlighter } from '@git-diff-view/shiki';
import '@git-diff-view/react/styles/diff-view-pure.css';

import { fetchFileDiff, type FileDiff } from './file-diff-api.js';
import { languageForPath } from './highlight.js';

/**
 * The "改动" view: one file's current content diffed against its Git base
 * (`HEAD`), rendered GitHub-style via `@git-diff-view` with Shiki syntax
 * highlighting so colors match the content viewer. The whole module (diff
 * component, Shiki highlighter, its CSS) is code-split and only loaded when a
 * file's diff is first opened. Everything runs on data the Server already
 * resolved; the browser never touches Git.
 */

type Status = 'loading' | 'ready' | 'unchanged' | 'error';

type DiffFileInstance = ReturnType<typeof generateDiffFile>;
type DiffHighlighter = Awaited<ReturnType<typeof getDiffViewHighlighter>>;

interface Prepared {
  readonly diffFile: DiffFileInstance;
  readonly highlighter: DiffHighlighter;
  readonly tracked: boolean;
}

export interface FileDiffViewProps {
  readonly projectId: string;
  readonly path: string;
}

/** Builds a highlighted `DiffFile` from the two contents, ready for `DiffView`. */
async function prepareDiff(diff: FileDiff, signal?: AbortSignal): Promise<Prepared> {
  const highlighter = await getDiffViewHighlighter();
  signal?.throwIfAborted();
  const lang = languageForPath(diff.path) ?? 'txt';
  const diffFile = generateDiffFile(
    diff.path,
    diff.oldContent,
    diff.path,
    diff.newContent,
    lang,
    lang,
  );
  diffFile.initTheme('light');
  diffFile.initRaw();
  diffFile.initSyntax({ registerHighlighter: highlighter });
  diffFile.buildSplitDiffLines();
  diffFile.buildUnifiedDiffLines();
  return { diffFile, highlighter, tracked: diff.tracked };
}

export function FileDiffView({ projectId, path }: FileDiffViewProps): ReactElement {
  const requestEpoch = useRef(0);
  const ownerRef = useRef({ projectId, path, epoch: 0 });
  if (ownerRef.current.projectId !== projectId || ownerRef.current.path !== path)
    ownerRef.current = { projectId, path, epoch: ownerRef.current.epoch + 1 };
  const [status, setStatus] = useState<Status>('loading');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [tracked, setTracked] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++requestEpoch.current;
    const owner = ownerRef.current;
    const valid = () =>
      !controller.signal.aborted && epoch === requestEpoch.current && ownerRef.current === owner;
    setStatus('loading');
    setPrepared(null);
    setError('');
    void (async () => {
      try {
        const diff = await fetchFileDiff(projectId, path, {
          signal: controller.signal,
        });
        if (!valid()) {
          return;
        }
        if (diff.path !== path) throw new Error('返回的文件路径不匹配');
        setTracked(diff.tracked);
        if (!diff.changed) {
          setStatus('unchanged');
          return;
        }
        const next = await prepareDiff(diff, controller.signal);
        if (!valid()) {
          return;
        }
        setPrepared(next);
        setStatus('ready');
      } catch (caught) {
        if (valid()) {
          setError(caught instanceof Error ? caught.message : '加载失败');
          setStatus('error');
        }
      }
    })();
    return () => {
      controller.abort();
    };
  }, [projectId, path]);

  if (status === 'loading') {
    return <p className="file-tree-hint">加载改动…</p>;
  }
  if (status === 'error') {
    return (
      <p className="file-tree-error" role="alert">
        {error}
      </p>
    );
  }
  if (status === 'unchanged') {
    return (
      <p className="file-viewer-note">
        {tracked ? '该文件无未提交改动。' : '新文件，基线（HEAD）中尚无内容。'}
      </p>
    );
  }
  return (
    <div className="file-diff">
      {prepared !== null && !prepared.tracked ? (
        <p className="file-viewer-note">新文件：基线（HEAD）中不存在，全部按新增显示。</p>
      ) : null}
      {prepared !== null ? (
        <DiffView
          diffFile={prepared.diffFile}
          registerHighlighter={prepared.highlighter}
          diffViewMode={DiffModeEnum.Unified}
          diffViewTheme="light"
          diffViewHighlight
          diffViewWrap
          diffViewFontSize={12}
        />
      ) : null}
    </div>
  );
}

/** Captured turn contents, independent of the working tree or Git base. */
export function CapturedFileDiffView({
  path,
  oldContent,
  newContent,
  existedBefore,
}: {
  readonly path: string;
  readonly oldContent: string;
  readonly newContent: string;
  readonly existedBefore: boolean;
}): ReactElement {
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPrepared(null);
    setError('');
    void prepareDiff({
      path,
      oldContent,
      newContent,
      changed: oldContent !== newContent,
      tracked: existedBefore,
    })
      .then((next) => {
        if (active) setPrepared(next);
      })
      .catch(() => {
        if (active) setError('无法渲染文件 Diff');
      });
    return () => {
      active = false;
    };
  }, [path, oldContent, newContent, existedBefore]);
  if (error) return <p role="alert">{error}</p>;
  if (!prepared) return <p>加载 Diff…</p>;
  return (
    <div className="file-diff" aria-label={`${path} 本轮 Diff`}>
      <DiffView
        diffFile={prepared.diffFile}
        registerHighlighter={prepared.highlighter}
        diffViewMode={DiffModeEnum.Unified}
        diffViewTheme="light"
        diffViewHighlight
        diffViewWrap
        diffViewFontSize={12}
      />
    </div>
  );
}
