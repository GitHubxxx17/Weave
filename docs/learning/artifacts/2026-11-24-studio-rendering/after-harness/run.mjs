import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import process from 'node:process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { performanceSamples, runnerOptionsSchema } from './sample-fixtures.mjs';
import { probeStudio } from './browser-probe.mjs';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    counts: { type: 'string', default: '100,1000,5000' },
    variants: { type: 'string', default: 'markdown,tools' },
    'history-shapes': { type: 'string', default: 'standard' },
    'tools-per-turn': { type: 'string', default: '1' },
    'stream-variants': { type: 'string', default: 'text' },
    repeats: { type: 'string', default: '3' },
    output: { type: 'string', default: 'dist/performance/studio-baseline.json' },
  },
});
const options = runnerOptionsSchema.parse({
  counts: values.counts.split(','),
  variants: values.variants.split(','),
  streamVariants: values['stream-variants'].split(','),
  historyShapes: values['history-shapes'].split(','),
  toolsPerTurn: values['tools-per-turn'],
  repeats: values.repeats,
  output: values.output,
});
const output = resolve(options.output);
const scratch = await mkdtemp(join(tmpdir(), 'weave-studio-benchmark-'));
const session = `weave-benchmark-${process.pid}`;
let opened = false;

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
  schemaVersion: 2,
  harnessHash: createHash('sha256')
    .update(
      (
        await Promise.all(
          [
            'scenario.mjs',
            'fixture.mjs',
            'browser-probe.mjs',
            'sample-fixtures.mjs',
            'run.mjs',
          ].map((name) => readFile(new URL(name, import.meta.url))),
        )
      )
        .map((file) => file.toString())
        .join('\n'),
    )
    .digest('hex'),
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
  for await (const {
    count,
    variant,
    streamVariant,
    historyShape,
    toolsPerTurn,
    repeat,
    fixture,
  } of performanceSamples(options)) {
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
        streamVariant,
        historyShape,
        toolsPerTurn,
        ...fixture.metadata,
      })})`,
    );
    console.log(
      `Measuring ${count} ${variant}/${streamVariant}/${historyShape}/${toolsPerTurn}, repeat ${repeat + 1}/${options.repeats}`,
    );
    const sample = JSON.parse(await cli('run-code', `--filename=${probePath}`));
    await cli('close');
    opened = false;
    report.samples.push({
      count,
      variant,
      streamVariant,
      historyShape,
      toolsPerTurn,
      repeat,
      ...fixture.metadata,
      ...sample,
    });
    await mkdir(resolve(output, '..'), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');

    const cases = report.samples.filter(
      (s) =>
        s.count === count &&
        s.variant === variant &&
        s.streamVariant === streamVariant &&
        s.historyShape === historyShape &&
        s.toolsPerTurn === toolsPerTurn,
    );
    if (repeat + 1 < options.repeats) continue;
    report.summaries.push({
      count,
      variant,
      streamVariant,
      historyShape,
      toolsPerTurn,
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
  await rm(scratch, { recursive: true, force: true });
}
