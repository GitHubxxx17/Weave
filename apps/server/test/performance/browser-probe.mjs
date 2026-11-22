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
      (expected) => document.querySelectorAll('.timeline-item').length === expected,
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
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    const visibleMessages = await page.locator('.timeline-item').count();
    if (visibleMessages !== options.count + 2)
      throw new Error('Live message count differs from fixture');
    return {
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
