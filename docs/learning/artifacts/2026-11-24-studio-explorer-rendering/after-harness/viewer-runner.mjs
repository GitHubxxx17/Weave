import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import process from 'node:process';
import console from 'node:console';
import { z } from 'zod';
import { startPerformanceFixture } from './fixture.mjs';
import { viewerSamples } from './viewer-samples.mjs';
import { probeViewer } from './viewer-probe.mjs';
import { validateViewerPayload, diffRowsReady } from './viewer-validation.mjs';
import { benchmarkEnvironment, browserCli, productionDist } from './benchmark-runtime.mjs';
const { values } = parseArgs({
  options: {
    sizes: { type: 'string', default: '102400,409600,1992294' },
    encodings: { type: 'string', default: 'ascii,multibyte' },
    'line-shapes': { type: 'string', default: 'single,multi' },
    repeats: { type: 'string', default: '3' },
    output: { type: 'string', default: 'dist/performance/viewer-diagnostic.json' },
    dist: { type: 'string', default: productionDist },
  },
});
const options = z
  .strictObject({
    sizes: z
      .array(
        z.coerce.number().pipe(z.union([z.literal(102400), z.literal(409600), z.literal(1992294)])),
      )
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length, 'Duplicate sizes'),
    encodings: z
      .array(z.enum(['ascii', 'multibyte']))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length, 'Duplicate matrix values'),
    lineShapes: z
      .array(z.enum(['single', 'multi']))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length, 'Duplicate matrix values'),
    repeats: z.coerce.number().int().min(1).max(5),
    output: z.string().min(1),
    dist: z.string().min(1),
  })
  .parse({
    sizes: values.sizes.split(','),
    encodings: values.encodings.split(','),
    lineShapes: values['line-shapes'].split(','),
    repeats: values.repeats,
    output: values.output,
    dist: values.dist,
  });
const scratch = await mkdtemp(join(tmpdir(), 'weave-viewer-probe-'));
const session = `weave-viewer-${process.pid}`;
const cli = browserCli(session);
const report = {
  schemaVersion: 2,
  stage: 'viewer-diagnostic',
  ...(await benchmarkEnvironment(options.dist, [
    'tree-scenario.mjs',
    'viewer-samples.mjs',
    'viewer-probe.mjs',
    'viewer-validation.mjs',
    'viewer-runner.mjs',
    'fixture.mjs',
    'scenario.mjs',
    'benchmark-runtime.mjs',
  ])),
  browser: null,
  options,
  samples: [],
};
await mkdir(resolve(options.output, '..'), { recursive: true });
const save = () => writeFile(resolve(options.output), JSON.stringify(report, null, 2) + '\n');
try {
  for await (const observation of viewerSamples(options, {
    async startFixture(scenario) {
      const tree = {
        fileCount: 1000,
        shape: 'wide-root',
        viewer: {
          bytes: scenario.bytes,
          encoding: scenario.encoding,
          lineShape: scenario.lineShape,
        },
      };
      const fixture = await startPerformanceFixture({
        count: 100,
        variant: 'markdown',
        distDirectory: options.dist,
        tree,
      });
      return { ...fixture, viewer: fixture.tree.viewer };
    },
    async openBrowser() {
      await cli('open', 'about:blank', '--browser=chrome');
      const browser = JSON.parse(
        await cli('run-code', 'async page => page.context().browser().version()'),
      );
      if (report.browser !== null && report.browser !== browser) throw Error('Browser changed');
      report.browser = browser;
    },
    async probe(fixture, scenario) {
      console.log(
        `Measuring viewer ${scenario.bytes}/${scenario.encoding}/${scenario.lineShape}, repeat ${scenario.repeat + 1}/${options.repeats}`,
      );
      const { oldFirstLine, newFirstLine, ...compactViewer } = fixture.viewer;
      const result = {
        fixture: {
          ...compactViewer,
          oldFirstLineCodeUnits: oldFirstLine.length,
          newFirstLineCodeUnits: newFirstLine.length,
        },
        phases: [],
        failures: [],
        errors: [],
        longTasks: [],
      };
      let initialize = true;
      const phases = ['plain-content', 'typescript-content', 'typescript-diff'];
      for (const phase of phases) {
        const filename = join(scratch, `${phase}.js`);
        await writeFile(
          filename,
          `async page => (${probeViewer.toString()})(page,${JSON.stringify({ url: fixture.url, viewer: fixture.viewer, phase, initialize })},(${validateViewerPayload.toString()}),(${diffRowsReady.toString()}))`,
        );
        try {
          const phaseResult = JSON.parse(await cli('run-code', `--filename=${filename}`));
          result.phases.push(...phaseResult.phases);
          result.failures.push(...phaseResult.failures);
          result.errors.push(...phaseResult.errors);
          result.longTasks = phaseResult.longTasks;
          result.domElements = phaseResult.domElements;
          initialize = false;
          await writeFile(join(scratch, `${phase}-last.json`), JSON.stringify(phaseResult));
        } catch (error) {
          result.failures.push({ phase, message: error.message });
          result.phases.push({ name: phase, status: 'failed', error: error.message });
          for (const skipped of phases.slice(phases.indexOf(phase) + 1))
            result.phases.push({
              name: skipped,
              status: 'skipped',
              reason: 'Previous CLI phase failed',
            });
          break;
        }
      }
      return result;
    },
    async closeBrowser() {
      await cli('close');
    },
  })) {
    report.samples.push(observation);
    await save();
  }
} finally {
  await save();
  await rm(scratch, { recursive: true, force: true });
}
console.log(`Viewer raw observations saved to ${options.output}`);
