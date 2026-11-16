import fs from 'node:fs';
import path from 'node:path';

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const workspacePackageNames = new Set([
  '@weave/protocol',
  '@weave/llm',
  '@weave/session',
  '@weave/workspace',
  '@weave/runtime',
  '@weave/server',
]);

const packageLayers = new Map([
  [
    '@weave/protocol',
    {
      allowedDependencies: [],
      layer: 'protocol',
    },
  ],
  [
    '@weave/llm',
    {
      allowedDependencies: ['@weave/protocol'],
      layer: 'llm',
    },
  ],
  [
    '@weave/session',
    {
      allowedDependencies: ['@weave/protocol'],
      layer: 'session',
    },
  ],
  [
    '@weave/workspace',
    {
      allowedDependencies: [],
      layer: 'workspace',
    },
  ],
  [
    '@weave/runtime',
    {
      allowedDependencies: ['@weave/protocol', '@weave/llm', '@weave/session'],
      layer: 'runtime',
    },
  ],
  [
    '@weave/server',
    {
      allowedDependencies: [
        '@weave/protocol',
        '@weave/llm',
        '@weave/session',
        '@weave/runtime',
        '@weave/workspace',
      ],
      layer: 'server',
    },
  ],
]);

const runtimeForbiddenImportPatterns = [
  /^hono(?:\/|$)/,
  /^@hono\/node-server(?:\/|$)/,
  /^react(?:\/|$)/,
  /^react-dom(?:\/|$)/,
  /^(?:node:)?(?:http|https|http2)(?:\/|$)/,
];

const packageManifestCache = new Map();

function readPackageManifest(packageRoot) {
  const cached = packageManifestCache.get(packageRoot);
  if (cached !== undefined) {
    return cached;
  }

  const manifestPath = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    packageManifestCache.set(packageRoot, null);
    return null;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.name !== 'string') {
      packageManifestCache.set(packageRoot, null);
      return null;
    }

    const dependencyNames = new Set();
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const dependencies = manifest[field];
      if (dependencies && typeof dependencies === 'object') {
        for (const dependencyName of Object.keys(dependencies)) {
          dependencyNames.add(dependencyName);
        }
      }
    }

    const result = {
      dependencies: dependencyNames,
      name: manifest.name,
      root: packageRoot,
    };
    packageManifestCache.set(packageRoot, result);
    return result;
  } catch {
    packageManifestCache.set(packageRoot, null);
    return null;
  }
}

function findPackageManifest(startPath) {
  let currentPath = path.resolve(startPath);

  while (true) {
    const manifest = readPackageManifest(currentPath);
    if (manifest !== null) {
      return manifest;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }
}

function getPackageName(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }

  return specifier.split('/')[0];
}

function isRelativeSpecifier(specifier) {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

function isWorkspaceUnit(manifest) {
  return manifest !== null && workspacePackageNames.has(manifest.name);
}

function findTargetPackage(filePath) {
  const resolvedPath = path.resolve(filePath);
  return readPackageManifest(resolvedPath) ?? findPackageManifest(path.dirname(resolvedPath));
}

function createBoundaryRule() {
  return {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Keep Weave package imports aligned with the protocol -> llm -> runtime -> server direction.',
      },
      schema: [],
      messages: {
        forbiddenDependency:
          'Package boundary violation: {{currentPackage}} cannot import {{specifier}}. Allowed workspace dependencies for the {{layer}} layer: {{allowedDependencies}}. Keep the dependency direction protocol -> llm -> runtime -> server.',
        undeclaredDependency:
          'Package boundary violation: {{currentPackage}} imports {{packageName}}, but it is not a declared workspace dependency. Add the package to the current package manifest only when the dependency direction allows it.',
        forbiddenRuntimeImport:
          'Runtime boundary violation: @weave/runtime must remain independent of HTTP frameworks, React, and Node HTTP servers; do not import {{specifier}}. Keep adapters in apps/server.',
        relativeWorkspaceImport:
          'Package boundary violation: {{currentPackage}} reaches {{targetPackage}} through relative import {{specifier}}. Import the published workspace package name instead of another package source path.',
      },
    },
    create(context) {
      const currentPackage = findPackageManifest(path.dirname(context.filename));
      if (!isWorkspaceUnit(currentPackage)) {
        return {};
      }

      const layer = packageLayers.get(currentPackage.name);
      if (layer === undefined) {
        return {};
      }

      const reportImport = (node, specifier) => {
        if (typeof specifier !== 'string') {
          return;
        }

        if (
          layer.layer === 'runtime' &&
          runtimeForbiddenImportPatterns.some((pattern) => pattern.test(specifier))
        ) {
          context.report({
            node,
            messageId: 'forbiddenRuntimeImport',
            data: { specifier },
          });
          return;
        }

        if (isRelativeSpecifier(specifier)) {
          const targetPackage = findTargetPackage(
            path.resolve(path.dirname(context.filename), specifier),
          );
          if (
            targetPackage !== null &&
            isWorkspaceUnit(targetPackage) &&
            targetPackage.root !== currentPackage.root
          ) {
            context.report({
              node,
              messageId: 'relativeWorkspaceImport',
              data: {
                currentPackage: currentPackage.name,
                specifier,
                targetPackage: targetPackage.name,
              },
            });
          }
          return;
        }

        if (specifier === 'apps/server' || specifier.startsWith('apps/server/')) {
          context.report({
            node,
            messageId: 'forbiddenDependency',
            data: {
              allowedDependencies:
                layer.allowedDependencies.length === 0
                  ? 'none'
                  : layer.allowedDependencies.join(', '),
              currentPackage: currentPackage.name,
              layer: layer.layer,
              specifier,
            },
          });
          return;
        }

        const packageName = getPackageName(specifier);
        if (!workspacePackageNames.has(packageName)) {
          return;
        }

        if (!currentPackage.dependencies.has(packageName)) {
          context.report({
            node,
            messageId: 'undeclaredDependency',
            data: {
              currentPackage: currentPackage.name,
              packageName,
            },
          });
          return;
        }

        if (!layer.allowedDependencies.includes(packageName)) {
          context.report({
            node,
            messageId: 'forbiddenDependency',
            data: {
              allowedDependencies:
                layer.allowedDependencies.length === 0
                  ? 'none'
                  : layer.allowedDependencies.join(', '),
              currentPackage: currentPackage.name,
              layer: layer.layer,
              specifier,
            },
          });
        }
      };

      return {
        ExportAllDeclaration(node) {
          reportImport(node, node.source.value);
        },
        ExportNamedDeclaration(node) {
          if (node.source !== null) {
            reportImport(node, node.source.value);
          }
        },
        ImportDeclaration(node) {
          reportImport(node, node.source.value);
        },
        ImportExpression(node) {
          if (node.source.type === 'Literal') {
            reportImport(node, node.source.value);
          }
        },
      };
    },
  };
}

const weaveBoundaryPlugin = {
  rules: {
    'package-boundaries': createBoundaryRule(),
  },
};

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      weave: weaveBoundaryPlugin,
    },
    rules: {
      // Keep architectural constraints close to the package lint entry point so new packages inherit them.
      'weave/package-boundaries': 'error',
    },
  },
);
