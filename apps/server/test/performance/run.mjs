import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import process from 'node:process';
import console from 'node:console';
import { z } from 'zod';
import { startPerformanceFixture } from './fixture.mjs';
import { probeStudio } from './browser-probe.mjs';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    counts: { type: 'string', default: '100,1000,5000' },
    variants: { type: 'string', default: 'markdown,tools' },
    repeats: { type: 'string', default: '3' },
    output: { type: 'string', default: 'dist/performance/studio-baseline.json' },
  },
});
const options = z
  .strictObject({
    counts: z
      .array(
        z.coerce
          .number()
          .int()
          .min(2)
          .max(5000)
          .refine((n) => n % 2 === 0),
      )
      .min(1)
      .max(3),
    variants: z
      .array(z.enum(['markdown', 'tools']))
      .min(1)
      .max(2),
    repeats: z.coerce.number().int().min(1).max(5),
    output: z.string().min(1),
  })
  .parse({
    counts: values.counts.split(','),
    variants: values.variants.split(','),
    repeats: values.repeats,
    output: values.output,
  });
const output = resolve(options.output);
const scratch = await mkdtemp(join(tmpdir(), 'weave-studio-benchmark-'));
const session = `weave-benchmark-${process.pid}`;
let opened = false;
let fixture;
const cli = async (...args) => {
  try {
    const result = await execute('playwright-cli', [`-s=${session}`, '--raw', ...args], {
      timeout: 240000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (/^### Error/m.test(result.stdout)) throw new Error(result.stdout);
    return result.stdout.trim();
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(
        'Install Playwright CLI and a Chrome browser before studio:benchmark. See the baseline guide.',
        { cause: error },
      );
    throw error;
  }
};
const git = async (...args) => (await execute('git', args)).stdout.trim();
const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
};
const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  commit: await git('rev-parse', 'HEAD'),
  dirty: Boolean(await git('status', '--porcelain')),
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  node: process.version,
  viewport: { width: 1440, height: 1000 },
  build: 'production',
  browserIsolation: 'fresh-browser-per-sample',
  assetCache: 'no-store',
  synthetic: true,
  stream: { deltas: 100, intervalMs: 20 },
  options,
  browser: null,
  samples: [],
  summaries: [],
};
try {
  for (const variant of options.variants)
    for (const count of options.counts) {
      fixture = await startPerformanceFixture({ count, variant });
      for (let repeat = 0; repeat < options.repeats; repeat++) {
        await cli('open', 'about:blank', '--browser=chrome');
        opened = true;
        const version = JSON.parse(
          await cli('run-code', 'async page => page.context().browser().version()'),
        );
        if (report.browser !== null && report.browser !== version)
          throw new Error('Browser version changed between samples');
        report.browser = version;
        const probePath = join(scratch, 'probe.js');
        await writeFile(
          probePath,
          `async page => (${probeStudio.toString()})(page, ${JSON.stringify({
            url: fixture.url,
            count,
            variant,
          })})`,
        );
        console.log(`Measuring ${count} ${variant}, repeat ${repeat + 1}/${options.repeats}`);
        const sample = JSON.parse(await cli('run-code', `--filename=${probePath}`));
        await cli('close');
        opened = false;
        report.samples.push({ count, variant, repeat, ...sample });
        await mkdir(resolve(output, '..'), { recursive: true });
        await writeFile(output, JSON.stringify(report, null, 2) + '\n');
      }
      await fixture.close();
      fixture = undefined;
      const cases = report.samples.filter((s) => s.count === count && s.variant === variant);
      report.summaries.push({
        count,
        variant,
        coldReadyMedianMs: percentile(
          cases.map((s) => s.coldReadyMs),
          0.5,
        ),
        warmSwitchMedianMs: percentile(
          cases.map((s) => s.warmSwitchMs),
          0.5,
        ),
        inputFillToPaintMedianMs: percentile(
          cases.map((s) => s.inputFillToPaintMs),
          0.5,
        ),
        streamFrameGapP95Ms: percentile(
          cases.flatMap((s) => s.stream.frameGapsMs),
          0.95,
        ),
        streamBlockingMs: cases.map((s) =>
          s.stream.longTasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0),
        ),
        coldDomElements: cases.map((s) => s.cold.domElements),
      });
    }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Raw observations saved to ${output}`);
} finally {
  if (opened)
    await cli('close').catch((error) => console.error(`Browser cleanup: ${error.message}`));
  await fixture?.close();
  await rm(scratch, { recursive: true, force: true });
}
