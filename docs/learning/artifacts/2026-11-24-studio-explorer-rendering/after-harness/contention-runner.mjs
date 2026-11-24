import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import process from 'node:process';
import console from 'node:console';
import { z } from 'zod';
import { startPerformanceFixture } from './fixture.mjs';
import { probeContention } from './contention-probe.mjs';
import { benchmarkEnvironment, browserCli, productionDist } from './benchmark-runtime.mjs';
const { values } = parseArgs({
  options: {
    repeats: { type: 'string', default: '3' },
    output: { type: 'string', default: 'dist/performance/explorer-contention.json' },
    dist: { type: 'string', default: productionDist },
  },
});
const options = z
  .strictObject({
    repeats: z.coerce.number().int().min(1).max(5),
    output: z.string().min(1),
    dist: z.string().min(1),
  })
  .parse(values);
const scratch = await mkdtemp(join(tmpdir(), 'weave-contention-probe-'));
const cli = browserCli(`weave-contention-${process.pid}`);
const report = {
  schemaVersion: 1,
  stage: 'explorer-contention',
  ...(await benchmarkEnvironment(options.dist, [
    'contention-runner.mjs',
    'contention-probe.mjs',
    'tree-scenario.mjs',
    'fixture.mjs',
    'scenario.mjs',
    'benchmark-runtime.mjs',
  ])),
  browser: null,
  options,
  samples: [],
};
await mkdir(resolve(options.output, '..'), { recursive: true });
try {
  for (let repeat = 0; repeat < options.repeats; repeat++) {
    const fixture = await startPerformanceFixture({
      count: 5000,
      variant: 'tools',
      streamVariant: 'tools',
      distDirectory: options.dist,
      tree: { fileCount: 50000, shape: 'wide-src' },
    });
    let opened = false;
    let cleanupFailed = false;
    try {
      opened = true;
      await cli('open', 'about:blank', '--browser=chrome');
      const browser = JSON.parse(
        await cli('run-code', 'async page => page.context().browser().version()'),
      );
      if (report.browser !== null && report.browser !== browser) throw Error('Browser changed');
      report.browser = browser;
      console.log(`Measuring Explorer contention, repeat ${repeat + 1}/${options.repeats}`);
      const probe = join(scratch, 'probe.js');
      await writeFile(
        probe,
        `async page => (${probeContention.toString()})(page,${JSON.stringify({ url: fixture.url, selectedPath: fixture.tree.sentinels[1].path })})`,
      );
      const result = JSON.parse(await cli('run-code', `--filename=${probe}`));
      report.samples.push({
        repeat,
        status: 'passed',
        ...fixture.metadata,
        treeFixtureHash: fixture.tree.hash,
        ...result,
      });
    } catch (error) {
      report.samples.push({
        repeat,
        status: 'failed',
        failure: { message: error.message, stack: error.stack },
      });
    } finally {
      const cleanupFailures = [];
      if (opened)
        try {
          await cli('close');
        } catch (error) {
          cleanupFailures.push({ owner: 'browser', message: error.message });
        }
      try {
        await fixture.close();
      } catch (error) {
        cleanupFailures.push({ owner: 'fixture', message: error.message });
      }
      if (cleanupFailures.length) {
        report.samples.at(-1).status = 'failed';
        report.samples.at(-1).cleanupFailures = cleanupFailures;
      }
      await writeFile(resolve(options.output), JSON.stringify(report, null, 2) + '\n');
      cleanupFailed = cleanupFailures.length > 0;
    }
    if (cleanupFailed) throw Error('Sample cleanup failed; subsequent cases stopped');
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
