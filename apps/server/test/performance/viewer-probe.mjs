/* global document, window, requestAnimationFrame, PerformanceObserver, performance */
/** production click-to-paint phases; library-stage diagnostics stay separate. */
export async function probeViewer(page, options, validateViewerPayload, diffRowsReady) {
  const phaseTimeout = 120000;
  const observations = {
    phases: [],
    failures: [],
    errors: [],
    fixture: {
      bytes: options.viewer.bytes,
      codeUnits: options.viewer.codeUnits,
      lineCount: options.viewer.lineCount,
      contentHash: options.viewer.contentHash,
    },
  };
  const paint = () =>
    page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  const assert = (value, message) => {
    if (!value) throw Error(message);
  };
  const onPageError = (error) => observations.errors.push(error.message);
  page.on('pageerror', onPageError);
  try {
    if (options.initialize) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(options.url, { waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: '文件', exact: true }).click();
      await page
        .locator('.file-tree-list [role=treeitem]')
        .first()
        .waitFor({ timeout: phaseTimeout });
    }
    await page.evaluate(() => {
      if (window.__viewerProbe) return;
      window.__viewerProbe = { phase: null, longTasks: [] };
      if (PerformanceObserver.supportedEntryTypes.includes('longtask'))
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            window.__viewerProbe.longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
            });
        }).observe({ type: 'longtask', buffered: false });
    });
    const filter = page.getByRole('textbox', { name: '筛选文件', exact: true });
    const selected = page.locator('.file-viewer-path');
    const content = page.locator('.file-viewer-content');
    const phase = async (name, run) => {
      const started = Date.now();
      const startedAt = await page.evaluate((name) => {
        window.__viewerProbe.phase = name;
        return performance.now();
      }, name);
      try {
        const result = await run(started);
        observations.phases.push({
          name,
          status: 'passed',
          startedAt,
          endedAt: await page.evaluate(() => performance.now()),
          elapsedMs: Date.now() - started,
          ...result,
        });
      } catch (error) {
        observations.phases.push({
          name,
          status: 'failed',
          startedAt,
          endedAt: await page.evaluate(() => performance.now()),
          elapsedMs: Date.now() - started,
          error: error.message,
        });
        observations.failures.push({ phase: name, message: error.message });
      }
    };
    const openContent = async (path) => {
      await filter.fill(path);
      const row = page.getByRole('treeitem', { name: path, exact: true });
      await row.waitFor({ timeout: phaseTimeout });
      const clickStarted = Date.now();
      const renderStartedAt = await page.evaluate(() => performance.now());
      const responsePromise = page.waitForResponse(
        (response) => {
          return (
            response.url() ===
            `${options.url}/projects/benchmark-project/file?path=${encodeURIComponent(path)}`
          );
        },
        { timeout: phaseTimeout },
      );
      await row.click();
      const response = await responsePromise;
      const fetchHeadersMs = Date.now() - clickStarted;
      const file = await response.json();
      const fetchJsonMs = Date.now() - clickStarted;
      assert(file.path === path, 'HTTP file identity changed');
      assert(file.bytes === options.viewer.bytes, 'HTTP byte metadata changed');
      assert(file.content.length === options.viewer.codeUnits, 'HTTP code units changed');
      assert(file.truncated === false, 'Unexpected synthetic truncation');
      await page.waitForFunction(
        ({ path, units }) =>
          document.querySelector('.file-viewer-path')?.textContent === path &&
          document.querySelector('.file-viewer-content')?.textContent.length === units,
        { path, units: options.viewer.codeUnits },
        { timeout: phaseTimeout },
      );
      await paint();
      const plainOrHighlightedReadyMs = Date.now() - clickStarted;
      const readyAt = await page.evaluate(() => performance.now());
      const initialRenderMode = await content.evaluate((element) =>
        element.classList.contains('file-viewer-highlight') ? 'highlighted' : 'plain',
      );
      return {
        file,
        clickStarted,
        renderStartedAt,
        readyAt,
        fetchHeadersMs,
        fetchJsonMs,
        plainOrHighlightedReadyMs,
        initialRenderMode,
      };
    };
    if (options.phase === 'plain-content')
      await phase('plain-content', async (started) => {
        const result = await openContent(options.viewer.plainPath, started);
        assert(
          (await selected.textContent()) === options.viewer.plainPath,
          'Plain selected path changed',
        );
        assert(
          (await content.textContent()) === result.file.content,
          'Plain rendered content changed',
        );
        assert(result.initialRenderMode === 'plain', 'Unknown extension highlighted');
        const validationStartedAt = await page.evaluate(() => performance.now());
        await page.evaluate(validateViewerPayload, {
          file: result.file,
          expected: {
            ...options.viewer,
            path: options.viewer.plainPath,
          },
        });
        return {
          ...result,
          validationStartedAt,
          validationEndedAt: await page.evaluate(() => performance.now()),
          file: undefined,
          clickStarted: undefined,
          path: options.viewer.plainPath,
          paintedBytes: options.viewer.bytes,
          paintedCodeUnits: options.viewer.codeUnits,
        };
      });
    if (options.phase === 'typescript-content')
      await phase('typescript-content', async (started) => {
        const result = await openContent(options.viewer.highlightPath, started);
        let highlightReadyMs = null;
        if (options.viewer.expectedHighlight) {
          await page
            .locator('.file-viewer-highlight')
            .waitFor({ state: 'attached', timeout: phaseTimeout });
          await paint();
          highlightReadyMs = Date.now() - result.clickStarted;
        }
        const highlightReadyAt = await page.evaluate(() => performance.now());
        const renderMode = await content.evaluate((element) =>
          element.classList.contains('file-viewer-highlight') ? 'highlighted' : 'plain',
        );
        assert(
          (await selected.textContent()) === options.viewer.highlightPath,
          'Highlighted selected path changed',
        );
        assert(
          (await content.textContent()) === result.file.content,
          'Highlighted rendered content changed',
        );
        assert(
          renderMode === (options.viewer.expectedHighlight ? 'highlighted' : 'plain'),
          'Highlight gate/fallback mode changed',
        );
        const validationStartedAt = await page.evaluate(() => performance.now());
        await page.evaluate(validateViewerPayload, {
          file: result.file,
          expected: {
            ...options.viewer,
            path: options.viewer.highlightPath,
          },
        });
        return {
          ...result,
          validationStartedAt,
          validationEndedAt: await page.evaluate(() => performance.now()),
          file: undefined,
          clickStarted: undefined,
          path: options.viewer.highlightPath,
          highlightReadyMs,
          readyAt: highlightReadyAt,
          renderMode,
          highlightGateUnits: options.viewer.highlightGateUnits,
        };
      });
    if (options.phase === 'typescript-diff')
      await phase('typescript-diff', async (started) => {
        assert(
          (await selected.textContent()) === options.viewer.highlightPath,
          'Cannot diff unrelated selected path',
        );
        const renderStartedAt = await page.evaluate(() => performance.now());
        const responsePromise = page.waitForResponse(
          (response) => {
            return (
              response.url() ===
              `${options.url}/projects/benchmark-project/file-diff?path=${encodeURIComponent(options.viewer.highlightPath)}`
            );
          },
          { timeout: phaseTimeout },
        );
        await page.getByRole('button', { name: '改动', exact: true }).click();
        const response = await responsePromise;
        const fetchHeadersMs = Date.now() - started;
        const diff = await response.json();
        const fetchJsonMs = Date.now() - started;
        assert(
          diff.path === options.viewer.highlightPath &&
            diff.changed === true &&
            diff.tracked === true,
          'Diff response identity changed',
        );
        await page.locator('.file-diff').waitFor({ state: 'attached', timeout: phaseTimeout });
        await page.waitForFunction(
          ({ oldFirstLine, newFirstLine }) => {
            const rows = [
              ...document.querySelectorAll(
                '.file-diff [data-component="git-diff-view"] .unified-diff-table tbody tr[data-state="diff"]',
              ),
            ];
            return (
              rows.some(
                (row) =>
                  row.querySelector('[data-line-old-num="1"]') &&
                  row.querySelector('.diff-line-content-raw,.diff-line-syntax-raw')?.textContent ===
                    oldFirstLine,
              ) &&
              rows.some(
                (row) =>
                  row.querySelector('[data-line-new-num="1"]') &&
                  row.querySelector('.diff-line-content-raw,.diff-line-syntax-raw')?.textContent ===
                    newFirstLine,
              )
            );
          },
          { oldFirstLine: options.viewer.oldFirstLine, newFirstLine: options.viewer.newFirstLine },
          { timeout: phaseTimeout },
        );
        await paint();
        const paintReadyMs = Date.now() - started;
        const readyAt = await page.evaluate(() => performance.now());
        const rows = await page
          .locator('.file-diff .unified-diff-table tbody tr[data-state="diff"]')
          .evaluateAll((rows) =>
            rows
              .filter((row) => row.querySelector('[data-line-old-num="1"],[data-line-new-num="1"]'))
              .map((row) => ({
                state: row.dataset.state,
                plainText: row.querySelector('.diff-line-content-raw')?.textContent,
                syntaxText: row.querySelector('.diff-line-syntax-raw')?.textContent,
                old:
                  row.querySelector('[data-line-old-num]')?.getAttribute('data-line-old-num') ??
                  null,
                next:
                  row.querySelector('[data-line-new-num]')?.getAttribute('data-line-new-num') ??
                  null,
              })),
          );
        assert(diffRowsReady(rows, options.viewer), 'Diff real old/new first lines missing');
        const validateDiff = async (content, contentHash) =>
          page.evaluate(validateViewerPayload, {
            file: { path: diff.path, content, bytes: options.viewer.bytes, truncated: false },
            expected: { ...options.viewer, path: diff.path, contentHash },
          });
        const validationStartedAt = await page.evaluate(() => performance.now());
        await validateDiff(diff.oldContent, options.viewer.oldContentHash);
        await validateDiff(diff.newContent, options.viewer.newContentHash);
        const counts = await page.locator('.file-diff').evaluate((element) => ({
          domElements: element.querySelectorAll('*').length,
          renderedTextCodeUnits: element.textContent.length,
        }));
        return {
          fetchHeadersMs,
          fetchJsonMs,
          paintReadyMs,
          renderStartedAt,
          readyAt,
          validationStartedAt,
          validationEndedAt: await page.evaluate(() => performance.now()),
          path: diff.path,
          oldCodeUnits: diff.oldContent.length,
          newCodeUnits: diff.newContent.length,
          diffTruncationFieldAvailable: Object.hasOwn(diff, 'truncated'),
          ...counts,
        };
      });
    await page.evaluate(() => {
      window.__viewerProbe.phase = null;
    });
    observations.longTasks = await page.evaluate(() => window.__viewerProbe.longTasks);
    for (const phase of observations.phases) {
      if (phase.renderStartedAt !== undefined && phase.readyAt !== undefined)
        phase.renderLongTasks = observations.longTasks.filter(
          (task) =>
            task.startTime < phase.readyAt &&
            task.startTime + task.duration > phase.renderStartedAt,
        );
      if (phase.validationStartedAt !== undefined)
        phase.validationLongTasks = observations.longTasks.filter(
          (task) =>
            task.startTime < phase.validationEndedAt &&
            task.startTime + task.duration > phase.validationStartedAt,
        );
    }
    observations.domElements = await page
      .locator('body')
      .evaluate(() => document.querySelectorAll('*').length);
    if (observations.errors.length)
      observations.failures.push({ phase: 'page', message: observations.errors.join('; ') });
    return observations;
  } finally {
    page.off('pageerror', onPageError);
  }
}
