import path from 'node:path';
import ts from 'typescript';

import { PluginCliError } from './errors.js';
import { inspectSourceSnapshot, sourceText } from './import-policy.js';
import type { DirectorySnapshot, ResolvedPluginSdk } from './types.js';

export async function checkPluginSource(
  snapshot: DirectorySnapshot,
  sdk: ResolvedPluginSdk,
  signal?: AbortSignal,
): Promise<void> {
  inspectSourceSnapshot(snapshot, signal);
  const directory = path.resolve(snapshot.directory);
  const absolute = new Map(
    [...snapshot.files].map(([name, bytes]) => [
      path.join(directory, ...name.split('/')),
      sourceText(bytes),
    ]),
  );
  const virtual = path.join(directory, 'src', '.weave-cli-factory-guard.ts');
  if (absolute.has(virtual))
    throw new PluginCliError(
      'plugin-cli-source-policy',
      'Source uses a reserved CLI guard filename',
    );
  absolute.set(
    virtual,
    "import factory from './index.js';\nimport type {PluginFactory} from '@weave/plugin';\nconst checkedFactory:PluginFactory=factory;\nvoid checkedFactory;\n",
  );
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
  const inSource = (file: string) => file === directory || file.startsWith(directory + path.sep);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (file) => {
    signal?.throwIfAborted();
    const normalized = path.resolve(file);
    return absolute.get(normalized) ?? (inSource(normalized) ? undefined : readFile(file));
  };
  host.fileExists = (file) => {
    signal?.throwIfAborted();
    const normalized = path.resolve(file);
    return absolute.has(normalized) || (!inSource(normalized) && fileExists(file));
  };
  const directoryExists = host.directoryExists?.bind(host);
  const directories = new Set(
    snapshot.directories.map((name) => path.join(directory, ...name.split('/'))),
  );
  directories.add(directory);
  directories.add(path.join(directory, 'src'));
  host.directoryExists = (value) => {
    const normalized = path.resolve(value);
    return (
      directories.has(normalized) || (!inSource(normalized) && (directoryExists?.(value) ?? false))
    );
  };
  host.getCurrentDirectory = () => directory;
  const realpath = host.realpath?.bind(host);
  host.realpath = (file) => {
    const normalized = path.resolve(file);
    return inSource(normalized) ? normalized : (realpath?.(file) ?? file);
  };
  const program = ts.createProgram(
    [...absolute.keys()].filter((name) => name.endsWith('.ts')),
    options,
    host,
  );
  signal?.throwIfAborted();
  const diagnostics = ts.getPreEmitDiagnostics(program);
  signal?.throwIfAborted();
  if (diagnostics.length > 0) {
    const formatted = ts.formatDiagnostics(diagnostics, {
      getCurrentDirectory: () => directory,
      getCanonicalFileName: (value) => value,
      getNewLine: () => '\n',
    });
    throw new PluginCliError('plugin-cli-typecheck', formatted);
  }
}
