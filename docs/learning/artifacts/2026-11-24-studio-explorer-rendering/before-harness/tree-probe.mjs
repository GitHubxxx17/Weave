/* global document, window, performance, requestAnimationFrame */
/** Serialized into Playwright CLI. Works on pre-window full DOM and future data attributes. */
export async function probeTree(page, options) {
  const paint = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const waitRows = async (count) => {
    await page.waitForFunction((expected) => {
      const tree = document.querySelector('.file-tree-list');
      return tree && (tree.hasAttribute('data-logical-count') ? Number(tree.dataset.logicalCount) === expected : tree.querySelectorAll('[role=treeitem]').length === expected);
    }, count, { timeout: 120000 });
    await paint();
  };
  const shape = options.tree.options.shape;
  const timings = {};
  let started = Date.now();
  // Existing panel tab accessible name; confirm snapshot against PR2 main before acceptance.
  await page.getByRole('tab', { name: '文件', exact: true }).click();
  await waitRows(shape === 'wide-src' ? 1 : options.tree.options.fileCount);
  timings.initialTreeReadyMs = Date.now() - started;
  if (shape === 'wide-src') {
    started = Date.now();
    await page.getByRole('treeitem', { name: 'src', exact: true }).click();
    await waitRows(options.tree.options.fileCount + 1);
    timings.expandReadyMs = Date.now() - started;
  }
  const filter = page.getByRole('textbox', { name: '筛选文件', exact: true });
  started = Date.now();
  await filter.fill('.ts');
  await paint();
  timings.filterFillToPaintMs = Date.now() - started;
  await waitRows(options.tree.options.fileCount);
  timings.filterResultsReadyMs = Date.now() - started;
  const broadFilterCounts=await page.locator('.file-tree-list').evaluate(tree=>({mounted:tree.querySelectorAll('[role=treeitem]').length,logical:Number(tree.dataset.logicalCount??tree.querySelectorAll('[role=treeitem]').length),domElements:document.querySelectorAll('*').length}));
  const sentinels = [];
  for (const sentinel of options.tree.sentinels) {
    const tree = page.locator('.file-tree-list');
    const row = tree.getByRole('treeitem', { name: sentinel.path, exact: true });
    if (!(await row.count())) {
      // Fixed row list supports path-independent scroll; data-row-height is the CSS estimate.
      await tree.evaluate((element, index) => {
        const height = Number(element.dataset.rowHeight);
        if (!Number.isFinite(height) || height <= 0) throw Error('Missing fixed-row height contract');
        element.scrollTop = index * height;
      }, sentinel.index);
      await row.waitFor({ timeout: 120000 });
    }
    await row.scrollIntoViewIfNeeded();
    const path = await row.getAttribute('data-file-path') ?? await row.textContent();
    if (path !== sentinel.path) throw Error('Explorer sentinel path mismatch');
    started = Date.now();
    await row.click();
    await page.locator('.file-viewer-path').filter({ hasText: sentinel.path }).waitFor({ state: 'attached' });
    await page.waitForFunction((expected) => document.querySelector('.file-viewer-content')?.textContent.includes(expected), JSON.stringify(['benchmark-project', sentinel.path]));
    await paint();
    const content = await page.locator('.file-viewer-content').textContent();
    sentinels.push({ ...sentinel, selectedPath: await page.locator('.file-viewer-path').textContent(), content, fileReadyMs: Date.now() - started });
  }
  const rare = options.tree.sentinels[1].path;
  started = Date.now();
  await filter.fill(rare);
  await waitRows(1);
  timings.rareReadyMs = Date.now() - started;
  if (await filter.inputValue() !== rare) throw Error('Explorer query changed');
  return { timings, broadFilterCounts, sentinels, finalQuery: rare, ...await page.locator('.file-tree-list').evaluate((tree) => ({
    logicalCount: Number(tree.dataset.logicalCount ?? tree.querySelectorAll('[role=treeitem]').length),
    mountedCount: tree.querySelectorAll('[role=treeitem]').length,
    rowHeight: Number(tree.dataset.rowHeight) || null,
    viewportHeight: tree.clientHeight,
  })) };
}
