/* global Element, HTMLImageElement, HTMLElement, document, requestAnimationFrame, ResizeObserver, Event */
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';

/**
 * Untimed acceptance only. Run on its own fresh Playwright page after timing.
 *
 * Production supports image content only as data URLs; network routing cannot
 * delay their load. This harness injects a valid PNG into the existing HTTP
 * SessionDetail contract, then defers assignment of only that exact data URL.
 * The image receives its native src after the reading anchor is captured. Its
 * browser load, decode, intrinsic dimensions and ResizeObserver/layout path are
 * real. This is controlled src assignment, not a simulated slow image network.
 * No production source, window state, business hook or test API is required.
 */

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(name, bytes) {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
  return Buffer.concat([length, type, bytes, checksum]);
}

/** A deterministic 300x180 RGB PNG gives the row a material intrinsic height. */
export function createAcceptancePng() {
  const width = 300;
  const height = 180;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const offset = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      rows[offset + 1 + x * 3] = (x * 13 + y * 7) % 256;
      rows[offset + 2 + x * 3] = (x * 3 + y * 17) % 256;
      rows[offset + 3 + x * 3] = (x * 11 + y * 5 + 71) % 256;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

export async function acceptConversationImageLoad(page, options) {
  const png = createAcceptancePng();
  const dataUrl = `data:image/png;base64,${png}`;
  const releaseEvent = 'weave-acceptance-release-exact-image-src';
  const failures = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(/\/sessions\/benchmark-history(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    const user = detail.messages?.find(
      (message) => message.role === 'user' && message.turnId === 'benchmark-turn-19',
    );
    if (!user || !Array.isArray(user.content))
      throw new Error('Image acceptance requires benchmark turn19 user content');
    user.content.push({ type: 'image', mediaType: 'image/png', data: png });
    await route.fulfill({ response, json: detail });
  });
  await page.addInitScript(
    ({ exactUrl, release }) => {
      const setAttribute = Element.prototype.setAttribute;
      const source = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      const deferred = new WeakMap();
      const defer = (image, value, assign) => {
        if (value !== exactUrl) return false;
        const previous = deferred.get(image);
        if (previous) return !previous.released;
        const state = { released: false };
        deferred.set(image, state);
        setAttribute.call(image, 'data-acceptance-image-src', 'deferred');
        image.addEventListener(
          release,
          () => {
            state.released = true;
            setAttribute.call(image, 'data-acceptance-image-src', 'released');
            assign();
          },
          { once: true },
        );
        return true;
      };
      Element.prototype.setAttribute = function (name, value) {
        if (
          this instanceof HTMLImageElement &&
          name.toLowerCase() === 'src' &&
          defer(this, value, () => setAttribute.call(this, name, value))
        )
          return;
        return setAttribute.call(this, name, value);
      };
      if (source?.set && source.get)
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          ...source,
          set(value) {
            if (defer(this, value, () => source.set.call(this, value))) return;
            source.set.call(this, value);
          },
        });
    },
    { exactUrl: dataUrl, release: releaseEvent },
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(options.url);
  await page.waitForFunction(
    () => Number(document.querySelector('[data-logical-count]')?.dataset.logicalCount) === 100,
  );
  const search = page.getByRole('searchbox', { name: '查找会话内容' });
  await search.fill('分析 20');
  await page
    .getByRole('button', { name: /分析 20/ })
    .first()
    .click();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('data-message-index') === '41',
  );
  await search.fill('');
  await page.waitForFunction(() =>
    Boolean(
      document.querySelector('[data-message-index="38"] img[data-acceptance-image-src="deferred"]'),
    ),
  );
  const measured = await page.evaluate(
    async ({ release }) => {
      const view = document.querySelector('[data-logical-count]');
      const imageRow = view?.querySelector('[data-message-index="38"]');
      const image = imageRow?.querySelector('img[data-acceptance-image-src="deferred"]');
      if (!(view instanceof HTMLElement) || !(image instanceof HTMLImageElement) || !imageRow)
        throw new Error('Deferred image row must remain mounted above the reading anchor');
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      await frame();
      await frame();
      const capture = () => {
        const top = view.getBoundingClientRect().top;
        const row = [...view.querySelectorAll('[data-message-id]')].find((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          return bounds.bottom > top && bounds.top < top + view.clientHeight;
        });
        return {
          id: row?.dataset.messageId,
          index: Number(row?.dataset.messageIndex),
          offset: row?.getBoundingClientRect().top - top,
          scroll: view.scrollTop,
        };
      };
      const before = capture();
      const imageRowMountedBefore = imageRow.isConnected;
      const viewTop = view.getBoundingClientRect().top;
      const rowBefore = imageRow.getBoundingClientRect();
      const imageBefore = image.getBoundingClientRect();
      const resizeHeights = [];
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) resizeHeights.push(entry.contentRect.height);
      });
      observer.observe(imageRow);
      await frame();
      await frame();
      const deferred = image.naturalHeight === 0 && !image.hasAttribute('src');
      const loaded = new Promise((resolve, reject) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', () => reject(new Error('Acceptance PNG failed')), {
          once: true,
        });
      });
      image.dispatchEvent(new Event(release));
      await loaded;
      await image.decode();
      let stableFrames = 0;
      let previous = '';
      for (let index = 0; index < 120 && stableFrames < 5; index++) {
        await frame();
        const anchor = capture();
        const state = `${anchor.id}:${anchor.offset}:${view.scrollTop}:${view.scrollHeight}`;
        stableFrames = state === previous ? stableFrames + 1 : 0;
        previous = state;
      }
      observer.disconnect();
      const after = capture();
      return {
        deferred,
        before,
        after,
        imageRowMountedBefore,
        imageRowMountedAfter: imageRow.isConnected,
        imageRowIndex: Number(imageRow.dataset.messageIndex),
        imageRowBefore: { top: rowBefore.top, bottom: rowBefore.bottom, height: rowBefore.height },
        imageRowAfterHeight: imageRow.getBoundingClientRect().height,
        imageBeforeHeight: imageBefore.height,
        imageAfterHeight: image.getBoundingClientRect().height,
        imageComplete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        resizeHeights,
        viewportTop: viewTop,
        stableFrames,
        mountedRows: view.querySelectorAll('[data-message-id]').length,
      };
    },
    { release: releaseEvent },
  );
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };
  check(measured.deferred, 'exact data URL source was deferred until anchor capture');
  check(
    measured.imageRowMountedBefore &&
      measured.imageRowIndex < measured.before.index &&
      measured.imageRowBefore.bottom <= measured.viewportTop,
    'mounted image row was entirely above the first visible anchor',
  );
  check(
    measured.imageComplete && measured.naturalWidth === 300 && measured.naturalHeight === 180,
    'real browser image load produced expected intrinsic dimensions',
  );
  check(
    measured.imageAfterHeight - measured.imageBeforeHeight > 50 &&
      measured.imageRowAfterHeight - measured.imageRowBefore.height > 50 &&
      Math.max(...measured.resizeHeights) - Math.min(...measured.resizeHeights) > 50,
    'real image growth resized the mounted row through ResizeObserver',
  );
  check(
    measured.before.id !== undefined &&
      measured.before.id === measured.after.id &&
      Math.abs(measured.before.offset - measured.after.offset) <= 2,
    'same reading anchor retained within two pixels after image load',
  );
  check(errors.length === 0, 'no page errors');
  return {
    methodology: 'test-only exact-data-URL src assignment deferred until anchor capture',
    measured,
    errors,
    failures,
    passed: failures.length === 0,
  };
}
