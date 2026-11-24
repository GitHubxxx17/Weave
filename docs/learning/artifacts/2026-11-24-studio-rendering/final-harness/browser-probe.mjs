/* global window, PerformanceObserver, requestAnimationFrame, document, performance, navigator */
/** Serialized into Playwright CLI; keep this function free of module dependencies. */
export async function probeStudio(page, options) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.__weaveBenchmark = { longTasks: [], frameGaps: [], lastFrame: 0, streaming: false };
    const state = window.__weaveBenchmark;
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          state.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
    }
    const frame = (time) => {
      if (state.streaming && state.lastFrame) state.frameGaps.push(time - state.lastFrame);
      state.lastFrame = time;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on('pageerror', onError);
  const paint = () =>
    page.evaluate(
      () =>
        new Promise((resolvePaint) => {
          requestAnimationFrame(() => requestAnimationFrame(resolvePaint));
        }),
    );
  const ready = async (count) => {
    await page.waitForFunction(
      (expected) => {
        const timeline = document.querySelector('[data-session-id][data-logical-count]');
        return timeline
          ? Number(timeline.dataset.logicalCount) === expected
          : document.querySelectorAll('.timeline-item').length === expected;
      },
      count,
      { timeout: 120000 },
    );
    await paint();
  };
  try {
    const coldStarted = Date.now();
    await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await ready(options.count);
    const coldReadyMs = Date.now() - coldStarted;
    const readinessMode = (await page.locator('[data-session-id][data-logical-count]').count())
      ? 'logical-selector'
      : 'full-dom';
    const mountedMessageCount = await page.locator('.timeline-item').count();
    const cold = await page.evaluate(() => ({
      domElements: document.querySelectorAll('*').length,
      heapBytes: performance.memory?.usedJSHeapSize ?? null,
      longTasks: [...window.__weaveBenchmark.longTasks],
      userAgent: navigator.userAgent,
    }));
    await page.getByRole('button', { name: '会话：性能对照会话', exact: true }).click();
    await ready(0);
    const switchStarted = Date.now();
    await page
      .getByRole('button', {
        name: `会话：性能基线 ${options.count} ${options.variant}`,
        exact: true,
      })
      .click();
    await ready(options.count);
    const warmSwitchMs = Date.now() - switchStarted;
    const sentinels = [];
    for (const index of [0, Math.floor(options.count / 2), options.count - 1]) {
      const row =
        readinessMode === 'full-dom'
          ? page.locator('.timeline-item').nth(index)
          : page.locator(`[data-message-index="${index}"]`);
      if (readinessMode === 'logical-selector' && !(await row.count())) {
        const query =
          index % 2 === 0 ? `问题 ${Math.floor(index / 2)}：` : `分析 ${Math.floor(index / 2)}`;
        await page.getByRole('textbox', { name: '查找会话内容', exact: true }).fill(query);
        await page
          .getByRole('button', { name: new RegExp(query) })
          .first()
          .click();
      }
      await row.scrollIntoViewIfNeeded();
      const text = await row.textContent();
      const expected =
        index % 2 === 0 ? `问题 ${Math.floor(index / 2)}：` : `分析 ${Math.floor(index / 2)}`;
      if (!text.includes(expected)) throw new Error(`Sentinel ${index} content differs`);
      sentinels.push({ index, text });
    }
    const input = page.getByRole('textbox', { name: '发送消息', exact: true });
    await input.fill('benchmark request');
    await page.evaluate(() => {
      window.__weaveBenchmark.streaming = true;
      window.__weaveBenchmark.frameGaps = [];
      window.__weaveBenchmark.longTasks = [];
    });
    const streamStarted = Date.now();
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(
      () => document.body.textContent.includes('benchmark-stream-000'),
      undefined,
      { timeout: 120000 },
    );
    const fillStarted = Date.now();
    await input.fill('流式输出期间编辑草稿');
    await paint();
    const inputFillToPaintMs = Date.now() - fillStarted;
    if ((await input.inputValue()) !== '流式输出期间编辑草稿')
      throw new Error('Input changed during stream');
    await page.waitForFunction(
      () => document.body.textContent.includes('benchmark-stream-099'),
      undefined,
      { timeout: 120000 },
    );
    await page
      .getByRole('button', { name: '发送', exact: true })
      .waitFor({ state: 'visible', timeout: 120000 });
    await paint();
    const streamReadyMs = Date.now() - streamStarted;
    const stream = await page.evaluate(() => {
      window.__weaveBenchmark.streaming = false;
      const state = window.__weaveBenchmark;
      return {
        frameGapsMs: state.frameGaps,
        longTasks: state.longTasks,
        domElements: document.querySelectorAll('*').length,
        heapBytes: performance.memory?.usedJSHeapSize ?? null,
      };
    });
    const last = await page.locator('.timeline-item-assistant .markdown-body').last().textContent();
    const expected = Array.from(
      { length: 100 },
      (_, index) => `benchmark-stream-${String(index).padStart(3, '0')}`,
    ).join(' ');
    if (last.trim() !== expected)
      throw new Error('Stream content is missing, duplicated or out of order');
    const response = await page.request.get(`${options.url}/sessions/benchmark-history`);
    const durable = await response.json();
    const turn = durable.turns.at(-1);
    const durableMessages = durable.messages.filter((message) => message.turnId === turn.turnId);
    const durableText = durableMessages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) =>
        message.content.filter((part) => part.type === 'text').map((part) => part.text),
      )
      .join('');
    if (durableText.trim() !== expected)
      throw new Error('Durable stream text differs from rendered text');
    const durableCalls = durableMessages.flatMap((message) => message.toolCalls ?? []);
    const toolIds = durableCalls.map((call) => call.id);
    const expectedToolIds =
      options.streamVariant === 'tools'
        ? Array.from({ length: 10 }, (_, index) => `benchmark-stream-call-${index}`)
        : [];
    if (
      JSON.stringify(toolIds) !== JSON.stringify(expectedToolIds) ||
      turn.toolCalls !== expectedToolIds.length ||
      JSON.stringify(turn.toolResults) !==
        JSON.stringify(expectedToolIds.map((toolCallId) => ({ toolCallId, status: 'completed' })))
    )
      throw new Error('Durable tool identities, order or summaries differ');
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    await ready(options.count + 2);
    const visibleMessages = await page.locator('.timeline-item').count();
    if (readinessMode === 'full-dom' && visibleMessages !== options.count + 2)
      throw new Error('Live message count differs from fixture');
    return {
      readinessMode,
      logicalMessageCount: options.count,
      mountedMessageCount,
      sentinels,
      finalText: last,
      durableText,
      toolIds,
      durableToolResults: turn.toolResults,
      coldReadyMs,
      warmSwitchMs,
      inputFillToPaintMs,
      streamReadyMs,
      cold,
      stream,
      visibleMessages,
    };
  } finally {
    page.off('pageerror', onError);
  }
}
