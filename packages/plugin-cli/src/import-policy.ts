import { isBuiltin } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

import { PluginCliError } from './errors.js';
import type { DirectorySnapshot } from './types.js';

export function sourceText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause: unknown) {
    throw new PluginCliError('plugin-cli-source-policy', 'Source must be valid UTF-8', { cause });
  }
}
const reject = (message: string): never => {
  throw new PluginCliError('plugin-cli-source-policy', message);
};

export function resolveLocalSource(
  snapshot: DirectorySnapshot,
  importer: string,
  specifier: string,
): string {
  if (!specifier.startsWith('./') && !specifier.startsWith('../'))
    reject('Only src-contained relative modules are supported');
  if (/[\\\0?#]/.test(specifier)) reject('Module paths must be plain relative POSIX paths');
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (!relative.startsWith('src/')) reject('Local imports must remain inside src');
  const resolved = relative.endsWith('.js') ? relative.slice(0, -3) + '.ts' : relative;
  if (!resolved.endsWith('.ts') || resolved.endsWith('.d.ts') || !snapshot.files.has(resolved))
    reject(`Local TypeScript module is missing: ${specifier}`);
  return resolved;
}

/** A compatibility profile, not confinement of trusted Node code. */
export function inspectModuleSyntax(
  text: string,
  fileName: string,
  snapshot?: DirectorySnapshot,
): ts.SourceFile {
  const artifact = snapshot === undefined;
  const file = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.ES2022,
    true,
    artifact ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const parsed = file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
  if ((parsed.parseDiagnostics?.length ?? 0) > 0) reject('Invalid module syntax');
  if (artifact) {
    const diagnostics = ts.transpileModule(text, {
      fileName: 'index.mjs',
      reportDiagnostics: true,
      compilerOptions: {
        allowJs: true,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).diagnostics;
    if ((diagnostics?.length ?? 0) > 0)
      reject('Artifacts must contain JavaScript ESM, not TypeScript syntax');
  }
  if (
    file.referencedFiles.length > 0 ||
    file.typeReferenceDirectives.length > 0 ||
    file.libReferenceDirectives.length > 0 ||
    file.hasNoDefaultLib
  )
    reject('Author triple-slash references are outside the CLI source profile');
  function specifier(value: string, typeOnly: boolean): void {
    if (value === '@weave/plugin' && typeOnly && !artifact) return;
    if (isBuiltin(value)) return;
    if (value.startsWith('node:')) reject(`Unknown Node builtin: ${value}`);
    if (artifact) reject('An artifact must contain one ESM file and only Node builtin imports');
    resolveLocalSource(snapshot!, fileName, value);
  }
  function visit(node: ts.Node): void {
    if (
      ts.isModuleDeclaration(node) &&
      (ts.isStringLiteral(node.name) ||
        (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0 ||
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
    )
      reject('Ambient modules and global augmentations are outside the CLI source profile');
    if (ts.isImportEqualsDeclaration(node) || (ts.isExportAssignment(node) && node.isExportEquals))
      reject('CommonJS import/export syntax is outside the ESM profile');
    if (ts.isImportDeclaration(node)) {
      if (node.attributes !== undefined)
        reject('Import attributes are outside the CLI source profile');
      if (!ts.isStringLiteral(node.moduleSpecifier))
        return reject('Import specifier must be literal');
      const clause = node.importClause;
      const typeOnly =
        clause?.isTypeOnly === true ||
        (clause?.name === undefined &&
          clause?.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((item) => item.isTypeOnly));
      specifier(node.moduleSpecifier.text, typeOnly);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      if (node.attributes !== undefined)
        reject('Export attributes are outside the CLI source profile');
      if (!ts.isStringLiteral(node.moduleSpecifier))
        return reject('Export specifier must be literal');
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((item) => item.isTypeOnly));
      specifier(node.moduleSpecifier.text, typeOnly);
    }
    if (ts.isImportTypeNode(node)) {
      if (node.attributes !== undefined)
        reject('Import type attributes are outside the CLI source profile');
      if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal))
        return reject('Import types must be literal');
      specifier(node.argument.literal.text, true);
    }
    if (ts.isIdentifier(node) && ['require', 'createRequire'].includes(node.text))
      reject('Use ESM imports; require and createRequire are outside this build profile');
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      ['require', 'createRequire'].includes(node.argumentExpression.text)
    )
      reject('Dynamic CommonJS loading is outside this ESM profile');
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]!))
        reject('Dynamic import must use one literal without attributes');
      specifier((node.arguments[0] as ts.StringLiteral).text, false);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return file;
}

export function inspectSourceSnapshot(snapshot: DirectorySnapshot, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (!snapshot.files.has('src/index.ts')) reject('Source entry src/index.ts is missing');
  for (const [name, bytes] of snapshot.files) {
    if (!name.startsWith('src/')) continue;
    signal?.throwIfAborted();
    if (!name.endsWith('.ts') || name.endsWith('.d.ts'))
      reject('Only TypeScript source, without declaration shims, is supported');
    inspectModuleSyntax(sourceText(bytes), name, snapshot);
  }
  signal?.throwIfAborted();
}
