import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import process from 'node:process';
import console from 'node:console';
import { z } from 'zod';
import { startPerformanceFixture } from './fixture.mjs';
import { probeTree } from './tree-probe.mjs';
import { benchmarkEnvironment, browserCli, productionDist } from './benchmark-runtime.mjs';
const { values } = parseArgs({
  options: {
    'tree-counts': { type: 'string', default: '1000,10000,50000' },
    'tree-shapes': { type: 'string', default: 'wide-root,wide-src' },
    repeats: { type: 'string', default: '3' },
    output: { type: 'string', default: 'dist/performance/explorer-after.json' },
    dist: { type: 'string', default: productionDist },
  },
});
const options = z
  .strictObject({
    counts: z
      .array(z.coerce.number().pipe(z.union([z.literal(1000), z.literal(10000), z.literal(50000)])))
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length, 'Duplicate counts'),
    shapes: z
      .array(z.enum(['wide-root', 'wide-src']))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length, 'Duplicate shapes'),
    repeats: z.coerce.number().int().min(1).max(5),
    output: z.string().min(1),
    dist: z.string().min(1),
  })
  .parse({
    counts: values['tree-counts'].split(','),
    shapes: values['tree-shapes'].split(','),
    repeats: values.repeats,
    output: values.output,
    dist: values.dist,
  });
const scratch = await mkdtemp(join(tmpdir(), 'weave-explorer-probe-'));
const session = `weave-explorer-${process.pid}`;
const cli = browserCli(session);
const report = {
  schemaVersion: 2,
  ...(await benchmarkEnvironment(options.dist, [
    'tree-scenario.mjs',
    'tree-probe.mjs',
    'fixture.mjs',
    'scenario.mjs',
    'explorer-runner.mjs',
    'benchmark-runtime.mjs',
  ])),
  browser: null,
  stage: 'explorer',
  options,
  samples: [],
};
await mkdir(resolve(options.output, '..'), { recursive: true });
let activeCell;
let opened = false;
try {
  for (const fileCount of options.counts)
    for (const shape of options.shapes)
      for (let repeat = 0; repeat < options.repeats; repeat++) {
        const fixture = await startPerformanceFixture({
          count: 100,
          variant: 'markdown',
          distDirectory: options.dist,
          tree: { fileCount, shape },
        });
        activeCell = { fileCount, shape, repeat, fixtureHash: fixture.tree.hash };
        try {
          opened = true;
          await cli('open', 'about:blank', '--browser=chrome');
          const browser = JSON.parse(
            await cli('run-code', 'async page => page.context().browser().version()'),
          );
          if (report.browser !== null && report.browser !== browser) throw Error('Browser changed');
          report.browser = browser;
          console.log(
            `Measuring Explorer ${fileCount}/${shape}, repeat ${repeat + 1}/${options.repeats}`,
          );
          const filename = join(scratch, 'probe.js');
          await writeFile(
            filename,
            `async page => { const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.setViewportSize({width:1440,height:1000}); await page.goto(${JSON.stringify(fixture.url)},{waitUntil:'domcontentloaded'}); const value=await (${probeTree.toString()})(page,${JSON.stringify({ tree: fixture.tree })});if(errors.length)throw Error(errors.join('; '));return value; }`,
          );
          const sample = JSON.parse(await cli('run-code', `--filename=${filename}`));
          report.samples.push({
            fileCount,
            shape,
            repeat,
            fixtureHash: fixture.tree.hash,
            ...sample,
          });
          await cli('close');
          opened = false;
          await mkdir(resolve(options.output, '..'), { recursive: true });
          await writeFile(resolve(options.output), JSON.stringify(report, null, 2) + '\n');
        } finally {
          await fixture.close();
        }
      }
} catch (error) {
  report.failure = { message: error.message, ...activeCell };
  report.samples.push({ ...activeCell, status: 'failed', failure: { message: error.message } });
  report.skippedRemaining =
    options.counts.length * options.shapes.length * options.repeats - report.samples.length;
  await writeFile(resolve(options.output), JSON.stringify(report, null, 2) + '\n');
  throw error;
} finally {
  if (opened) await cli('close').catch(console.error);
  await rm(scratch, { recursive: true, force: true });
}
