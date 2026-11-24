/* global document, window, requestAnimationFrame, PerformanceObserver, performance */
/** Same-page tree/filter/composer contention, through the real execution fixture. */
export async function probeContention(page, options) {
  const paint = () =>
    page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on('pageerror', onError);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(options.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        Number(
          document.querySelector('[data-session-id][data-logical-count]')?.dataset.logicalCount,
        ) === 5000,
      undefined,
      { timeout: 120000 },
    );
    await page.getByRole('tab', { name: '文件', exact: true }).click();
    const filter = page.getByRole('textbox', { name: '筛选文件', exact: true });
    await filter.fill(options.selectedPath);
    await page.getByRole('treeitem', { name: options.selectedPath, exact: true }).click();
    await page.waitForFunction(
      (path) =>
        document.querySelector('.file-viewer-path')?.textContent === path &&
        document.querySelector('.file-viewer-content')?.textContent.includes(path),
      options.selectedPath,
      { timeout: 120000 },
    );
    await filter.fill('');
    const folder = page.getByRole('treeitem', { name: 'src', exact: true });
    if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click();
    await page.waitForFunction(
      () => Number(document.querySelector('.file-tree-list')?.dataset.logicalCount) === 50001,
      undefined,
      { timeout: 120000 },
    );
    await page.evaluate(() => {
      const state = (window.__explorerContention = {
        streaming: false,
        frames: [],
        longTasks: [],
        last: 0,
      });
      if (PerformanceObserver.supportedEntryTypes.includes('longtask'))
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            state.longTasks.push({ start: entry.startTime, duration: entry.duration });
        }).observe({ type: 'longtask', buffered: false });
      const frame = (time) => {
        if (state.streaming && state.last) state.frames.push(time - state.last);
        state.last = time;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const input = page.getByRole('textbox', { name: '发送消息', exact: true });
    await input.fill('benchmark contention request');
    await page.evaluate(() => {
      window.__explorerContention.streaming = true;
      window.__explorerContention.startedAt = performance.now();
    });
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(
      () => document.body.textContent.includes('benchmark-stream-000'),
      undefined,
      { timeout: 120000 },
    );
    const executionAtEditStart = await (
      await page.request.get(`${options.url}/sessions/benchmark-history/executions`)
    ).json();
    if (executionAtEditStart.at(-1)?.status !== 'running')
      throw Error('Stream already terminal before contention edits');
    const started = Date.now();
    await input.fill('stream composer identity preserved');
    const composerFilledMs = Date.now() - started;
    await filter.fill('.ts');
    const filterFilledMs = Date.now() - started;
    const executionAfterEdits = await (
      await page.request.get(`${options.url}/sessions/benchmark-history/executions`)
    ).json();
    if (executionAfterEdits.at(-1)?.status !== 'running')
      throw Error('Stream terminal before contention edits finished');
    await paint();
    const concurrentFillToPaintMs = Date.now() - started;
    await page.waitForFunction(
      () => Number(document.querySelector('.file-tree-list')?.dataset.logicalCount) === 50000,
      undefined,
      { timeout: 120000 },
    );
    const filterReadyMs = Date.now() - started;
    await page.waitForFunction(
      () => document.body.textContent.includes('benchmark-stream-099'),
      undefined,
      { timeout: 120000 },
    );
    await page
      .getByRole('button', { name: '发送', exact: true })
      .waitFor({ state: 'visible', timeout: 120000 });
    await paint();
    const stream = await page.evaluate(() => {
      const state = window.__explorerContention;
      state.streaming = false;
      state.endedAt = performance.now();
      return state;
    });
    const expected = Array.from(
      { length: 100 },
      (_, index) => `benchmark-stream-${String(index).padStart(3, '0')}`,
    ).join(' ');
    const finalText = await page
      .locator('.timeline-item-assistant .markdown-body')
      .last()
      .textContent();
    if (finalText.trim() !== expected) throw Error('Contention rendered stream changed');
    const durable = await (
      await page.request.get(`${options.url}/sessions/benchmark-history`)
    ).json();
    const turn = durable.turns.at(-1);
    const messages = durable.messages.filter((message) => message.turnId === turn.turnId);
    const durableText = messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) =>
        message.content.filter((part) => part.type === 'text').map((part) => part.text),
      )
      .join('');
    const toolIds = messages.flatMap((message) => message.toolCalls ?? []).map((call) => call.id);
    const expectedTools = Array.from(
      { length: 10 },
      (_, index) => `benchmark-stream-call-${index}`,
    );
    if (
      durableText.trim() !== expected ||
      JSON.stringify(toolIds) !== JSON.stringify(expectedTools) ||
      turn.toolCalls !== 10 ||
      JSON.stringify(turn.toolResults) !==
        JSON.stringify(expectedTools.map((toolCallId) => ({ toolCallId, status: 'completed' })))
    )
      throw Error('Contention durable text/tool summary changed');
    const draft = await input.inputValue(),
      query = await filter.inputValue(),
      selectedPath = await page.locator('.file-viewer-path').textContent();
    if (
      draft !== 'stream composer identity preserved' ||
      query !== '.ts' ||
      selectedPath !== options.selectedPath
    )
      throw Error('Contention draft/query/selected path changed');
    if (
      !(await page
        .locator('.file-viewer-content')
        .textContent()
        .then((text) => text.includes(JSON.stringify(['benchmark-project', options.selectedPath]))))
    )
      throw Error('Contention selected Project/path content changed');
    const tree = await page.locator('.file-tree-list').evaluate((element) => ({
      mounted: element.querySelectorAll('[role=treeitem]').length,
      logical: Number(element.dataset.logicalCount),
      rowHeight: Number(element.dataset.rowHeight),
      viewportHeight: element.clientHeight,
    }));
    if (
      tree.logical !== 50000 ||
      tree.rowHeight !== 28 ||
      tree.mounted > Math.ceil(tree.viewportHeight / 28) + 18
    )
      throw Error('Contention tree window bound failed');
    const beforeReload = {
      draft,
      query,
      selected: { projectId: 'benchmark-project', path: selectedPath },
    };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        Number(
          document.querySelector('[data-session-id][data-logical-count]')?.dataset.logicalCount,
        ) === 5002,
      undefined,
      { timeout: 120000 },
    );
    await page.getByRole('button', { name: '完整文本', exact: true }).click();
    const reloadedTranscript = await page
      .getByRole('textbox', { name: '完整会话文本内容', exact: true })
      .inputValue();
    if (!reloadedTranscript.includes(expected)) throw Error('Reload lost exact durable stream');
    const reloaded = await (
      await page.request.get(`${options.url}/sessions/benchmark-history`)
    ).json();
    if (JSON.stringify(reloaded.turns.at(-1).toolResults) !== JSON.stringify(turn.toolResults))
      throw Error('Reload lost tool summary');
    if (errors.length) throw Error(errors.join('; '));
    return {
      concurrentFillToPaintMs,
      composerFilledMs,
      filterFilledMs,
      inputActionOrder: ['composer', 'filter'],
      executionAtEditStart: executionAtEditStart.at(-1),
      executionAfterEdits: executionAfterEdits.at(-1),
      beforeReload,
      reloadedTranscriptLength: reloadedTranscript.length,
      filterReadyMs,
      finalText,
      durableText,
      toolIds,
      durableToolResults: turn.toolResults,
      draft,
      query,
      selected: { projectId: 'benchmark-project', path: selectedPath },
      tree,
      stream,
      errors,
    };
  } finally {
    page.off('pageerror', onError);
  }
}
