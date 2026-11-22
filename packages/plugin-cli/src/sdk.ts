import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import ts from 'typescript';

import { PluginCliError } from './errors.js';
import type { ResolvedPluginSdk } from './types.js';

const localRequire = createRequire(import.meta.url);
const sdkPathSchema = z
  .string()
  .refine((value) => path.isAbsolute(value) && !value.includes('\0'))
  .optional();
const metadataSchema = z.object({
  name: z.literal('@weave/plugin'),
  exports: z.object({
    '.': z.object({ types: z.literal('./dist/index.d.ts'), import: z.literal('./dist/index.js') }),
  }),
});

function checkPublicDeclarations(sdk: ResolvedPluginSdk, signal?: AbortSignal): void {
  const probePath = path.join(sdk.directory, '.weave-cli-sdk-probe.mts');
  const probe =
    "import type { PluginFactory, PluginSdk, PluginManifest } from '@weave/plugin';\n" +
    'export type WeaveCliSdkProbe = [PluginFactory, PluginSdk, PluginManifest];\n';
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    verbatimModuleSyntax: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    lib: ['lib.es2022.d.ts'],
    paths: { '@weave/plugin': [sdk.typesPath] },
    types: ['node'],
    typeRoots: [...sdk.typeRoots],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (file) => {
    signal?.throwIfAborted();
    return path.resolve(file) === probePath ? probe : readFile(file);
  };
  host.fileExists = (file) => {
    signal?.throwIfAborted();
    return path.resolve(file) === probePath || fileExists(file);
  };
  host.getCurrentDirectory = () => sdk.directory;
  const program = ts.createProgram([probePath], options, host);
  signal?.throwIfAborted();
  const diagnostics = ts.getPreEmitDiagnostics(program);
  signal?.throwIfAborted();
  if (diagnostics.length > 0)
    throw new Error(
      ts.formatDiagnostics(diagnostics, {
        getCurrentDirectory: () => sdk.directory,
        getCanonicalFileName: (value) => value,
        getNewLine: () => '\n',
      }),
    );
}

/** Resolve declarations only; the selected SDK's JavaScript is never evaluated. */
export async function resolvePluginSdk(
  sdkDirectory?: string,
  signal?: AbortSignal,
): Promise<ResolvedPluginSdk> {
  signal?.throwIfAborted();
  try {
    sdkPathSchema.parse(sdkDirectory);
    const directory = await fs.realpath(
      sdkDirectory ??
        path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@weave/plugin'))), '..'),
    );
    signal?.throwIfAborted();
    const metadataPath = path.join(directory, 'package.json');
    const handle = await fs.open(
      metadataPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024)
        throw new Error('SDK package metadata must be a regular file within64KiB');
      const buffer = Buffer.alloc(64 * 1024 + 1);
      let offset = 0;
      while (offset < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > 64 * 1024) throw new Error('SDK package metadata exceeds64KiB');
      metadataSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))),
      );
    } finally {
      await handle.close();
    }
    const typesPath = await fs.realpath(path.join(directory, 'dist/index.d.ts'));
    if (!typesPath.startsWith(directory + path.sep) || !(await fs.stat(typesPath)).isFile())
      throw new Error('SDK public declarations must be a built local file');
    const nodeTypes = localRequire.resolve('@types/node/package.json');
    signal?.throwIfAborted();
    const sdk = Object.freeze({
      directory,
      typesPath,
      typeRoots: Object.freeze([path.dirname(path.dirname(nodeTypes))]),
    });
    checkPublicDeclarations(sdk, signal);
    return sdk;
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    throw new PluginCliError(
      'plugin-cli-sdk-invalid',
      'Cannot resolve the built local Plugin SDK and CLI Node declarations; build the CLI dependency graph first',
      { cause },
    );
  }
}
