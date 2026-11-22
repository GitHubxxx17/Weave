import { isBuiltin } from 'node:module';
import * as esbuild from 'esbuild';

import { PluginCliError } from './errors.js';
import { checkPluginSource } from './compiler.js';
import {
  inspectModuleSyntax,
  inspectSourceSnapshot,
  resolveLocalSource,
  sourceText,
} from './import-policy.js';
import type { DirectorySnapshot, ResolvedPluginSdk } from './types.js';
export { checkPluginSource } from './compiler.js';

export function validateEsmArtifact(bytes: Uint8Array): void {
  inspectModuleSyntax(sourceText(bytes), 'index.mjs');
}

export async function bundlePluginSource(
  snapshot: DirectorySnapshot,
  sdk: ResolvedPluginSdk,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  inspectSourceSnapshot(snapshot, signal);
  await checkPluginSource(snapshot, sdk, signal);
  signal?.throwIfAborted();
  let context: esbuild.BuildContext | undefined;
  let onAbort: (() => void) | undefined;
  try {
    context = await esbuild.context({
      absWorkingDir: snapshot.directory,
      entryPoints: ['src/index.ts'],
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outfile: 'index.mjs',
      write: false,
      metafile: true,
      splitting: false,
      sourcemap: false,
      packages: 'bundle',
      // Source policy ran before tree shaking. Erase named `import { type X }`
      // too, so no empty runtime SDK import survives TypeScript erasure.
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: false } },
      logLevel: 'silent',
      plugins: [
        {
          name: 'weave-checked-snapshot',
          setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
              signal?.throwIfAborted();
              if (isBuiltin(args.path)) return { path: args.path, external: true };
              const relative =
                args.kind === 'entry-point'
                  ? 'src/index.ts'
                  : resolveLocalSource(snapshot, args.importer, args.path);
              return { path: relative, namespace: 'weave-source' };
            });
            build.onLoad({ filter: /.*/, namespace: 'weave-source' }, (args) => {
              signal?.throwIfAborted();
              const bytes = snapshot.files.get(args.path);
              if (bytes === undefined)
                throw new PluginCliError(
                  'plugin-cli-source-policy',
                  'Bundler requested a source outside the snapshot',
                );
              return { contents: sourceText(bytes), loader: 'ts', resolveDir: snapshot.directory };
            });
          },
        },
      ],
    });
    const active = context;
    onAbort = () => {
      void active.cancel().catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    signal?.throwIfAborted();
    const result = await active.rebuild();
    signal?.throwIfAborted();
    if (result.outputFiles?.length !== 1 || result.metafile === undefined)
      throw new PluginCliError('plugin-cli-bundle', 'Expected exactly one bundled ESM output');
    for (const name of Object.keys(result.metafile.inputs)) {
      if (
        !name.startsWith('weave-source:') ||
        !snapshot.files.has(name.slice('weave-source:'.length))
      )
        throw new PluginCliError(
          'plugin-cli-bundle',
          'Bundler input was not part of the checked snapshot',
        );
    }
    for (const output of Object.values(result.metafile.outputs))
      for (const imported of output.imports) {
        if (!imported.external || !isBuiltin(imported.path) || imported.kind === 'require-call')
          throw new PluginCliError(
            'plugin-cli-bundle',
            'Bundle contains unsupported external imports',
          );
      }
    const bytes = result.outputFiles[0]!.contents;
    validateEsmArtifact(bytes);
    signal?.throwIfAborted();
    return new Uint8Array(bytes);
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    if (cause instanceof PluginCliError) throw cause;
    throw new PluginCliError('plugin-cli-bundle', 'Failed to create a single checked ESM bundle', {
      cause,
    });
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    await context?.dispose();
  }
}
