/* global document, requestAnimationFrame */
/** Real layout acceptance, separate from timed performance samples. */
export async function acceptConversationWindow(page, options) {
  const paint = () =>
    page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  const failures = [];
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(options.url);
  await page.waitForFunction(
    () => Number(document.querySelector('[data-logical-count]')?.dataset.logicalCount) === 100,
  );
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-logical-count]');
    return (
      element !== null &&
      Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight) <= 2 &&
      Number(element.dataset.rangeEnd) === 99
    );
  });
  await paint();
  const initial = await page.locator('[data-logical-count]').evaluate((el) => ({
    logical: Number(el.dataset.logicalCount),
    mounted: el.querySelectorAll('[data-message-id]').length,
    bottom: el.scrollHeight - el.scrollTop - el.clientHeight,
  }));
  check(
    initial.logical === 100 && initial.mounted <= 64 && Math.abs(initial.bottom) <= 2,
    'initial window count/following',
  );
  const search = page.getByRole('searchbox', { name: '查找会话内容' });
  const go = async (query) => {
    await search.fill(query);
    await page
      .getByRole('button', { name: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
      .first()
      .click();
    await paint();
    await paint();
  };
  await go('src/component-24-499.tsx');
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-tool-parameters'));
  await paint();
  const tool500 = await page.evaluate(() => {
    const focus = document.activeElement;
    const view = document.querySelector('[data-logical-count]');
    const rect = focus.getBoundingClientRect(),
      bounds = view.getBoundingClientRect();
    return {
      text: focus.textContent,
      top: rect.top,
      bottom: rect.bottom,
      viewportTop: bounds.top,
      viewportBottom: bounds.bottom,
      row: focus.closest('[data-message-id]')?.dataset.messageIndex,
      bodies: document.querySelectorAll('.tool-step-body').length,
      mounted: document.querySelectorAll('[data-message-id]').length,
    };
  });
  check(
    tool500.text.includes('src/component-24-499.tsx') &&
      tool500.row === '49' &&
      tool500.top >= tool500.viewportTop &&
      tool500.top < tool500.viewportBottom,
    'exact tool500 focus and visibility',
  );
  await search.fill('');
  await page.getByRole('button', { name: '回到底部', exact: true }).click();
  await paint();
  const pins = await page.evaluate(() => ({
    focused: document.activeElement?.hasAttribute('data-tool-parameters'),
    rowRetained: Boolean(document.querySelector('[data-message-index="49"]')),
  }));
  // The bottom button takes focus; the old row may now detach, with disclosure
  // state retained by its pane rather than by the DOM.
  await go('src/component-24-499.tsx');
  const restored = await page.locator('[data-message-index="49"] .tool-step[open]').count();
  check(restored === 1, 'tool disclosure survives row detachment');
  await search.fill('');
  await page.getByRole('button', { name: '回到底部', exact: true }).click();
  await paint();
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('acceptance stream');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => document.body.textContent.includes('benchmark-stream-005'));
  await go('分析 20');
  await search.fill('');
  await paint();
  const capture = () =>
    page.locator('[data-logical-count]').evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll('[data-message-id]')].find((n) => {
        const r = n.getBoundingClientRect();
        return r.bottom > top && r.top < top + el.clientHeight;
      });
      return {
        id: row?.dataset.messageId,
        offset: row?.getBoundingClientRect().top - top,
        scroll: el.scrollTop,
      };
    });
  const anchorBefore = await capture();
  await page.waitForFunction(() =>
    document.querySelector('[role="status"][aria-live="polite"]')?.textContent.includes('回复完成'),
  );
  await paint();
  const anchorAfter = await capture();
  check(
    anchorBefore.id === anchorAfter.id && Math.abs(anchorBefore.offset - anchorAfter.offset) <= 2,
    'reading anchor during stream',
  );
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.waitForTimeout(250);
  await paint();
  await paint();
  const widthAfter = await capture();
  check(
    anchorAfter.id === widthAfter.id && Math.abs(anchorAfter.offset - widthAfter.offset) <= 2,
    'reading anchor after width change',
  );
  await page.getByRole('button', { name: '回到底部', exact: true }).click();
  await paint();
  await paint();
  const followed = await page.locator('[data-logical-count]').evaluate((el) => ({
    gap: el.scrollHeight - el.scrollTop - el.clientHeight,
    text: el.textContent,
    mounted: el.querySelectorAll('[data-message-id]').length,
  }));
  check(
    Math.abs(followed.gap) <= 2 && followed.text.includes('benchmark-stream-099'),
    'resumed bottom follows complete stream',
  );
  await page.getByRole('button', { name: '完整文本', exact: true }).click();
  const transcript = await page.getByRole('textbox', { name: '完整会话文本内容' }).inputValue();
  check(
    transcript.includes('问题 0：') &&
      transcript.includes('分析 49') &&
      transcript.includes('src/component-24-499.tsx') &&
      transcript.includes('benchmark-stream-099'),
    'full transcript contains all logical records',
  );
  return {
    initial,
    tool500,
    pins,
    restored,
    anchorBefore,
    anchorAfter,
    widthAfter,
    followed: { gap: followed.gap, mounted: followed.mounted },
    transcriptLength: transcript.length,
    errors,
    failures,
    passed: failures.length === 0,
  };
}
