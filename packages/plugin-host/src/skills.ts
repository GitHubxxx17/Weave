import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isSkillResourcePath, skillNamePattern } from '@weave/plugin';

import { parseSkillDocument } from './skill-document.js';
import {
  checkSkillAbort,
  decodeSkillText,
  inspectSkillPath,
  inspectSkillRoot,
  isMissingSkillPath,
  readSkillBytes,
  type SkillRootIdentity,
} from './skill-files.js';
import {
  createSkillScanBudget,
  SkillHostError,
  type DiscoveredSkillBundle,
  type DiskSkillHandle,
  type ParsedSkillDocument,
  type PinnedSkillBundle,
  type SkillDiscoveryResult,
  type SkillIoOptions,
  type SkillResourceIdentity,
  type SkillScanBudget,
} from './skill-types.js';

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const maxFiles = 1000;
const maxResourceBytes = 20 * 1024 * 1024;

async function listDirectories(
  root: SkillRootIdentity,
  signal?: AbortSignal,
): Promise<{ names: string[]; truncated: boolean; unsafe: boolean }> {
  const names: string[] = [];
  let truncated = false;
  let unsafe = false;
  let candidates = 0;
  let entries = 0;
  const directory = await fs.opendir(root.directory);
  try {
    for (;;) {
      checkSkillAbort(signal);
      const entry = await directory.read();
      if (entry === null) break;
      if (++entries > 4096) {
        truncated = true;
        break;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (++candidates > 128) {
        truncated = true;
        break;
      }
      if (!skillNamePattern.test(entry.name) || entry.name.length > 64 || entry.isSymbolicLink()) {
        unsafe = true;
        continue;
      }
      names.push(entry.name);
    }
  } finally {
    await directory.close();
  }
  return { names: names.sort(byteOrder), truncated, unsafe };
}

async function readBundle(
  root: SkillRootIdentity,
  name: string,
  rootId: string,
  budget: SkillScanBudget,
  signal?: AbortSignal,
): Promise<{ discovered: DiscoveredSkillBundle; document: ParsedSkillDocument }> {
  if (!skillNamePattern.test(name) || name.length > 64)
    throw new SkillHostError('skill-unsafe-entry');
  await inspectSkillPath(root, name, 'directory');
  const instructionStat = await inspectSkillPath(root, `${name}/SKILL.md`, 'file');
  const bytes = await readSkillBytes({
    root,
    relative: `${name}/SKILL.md`,
    maxBytes: 64 * 1024,
    budget,
    ...(signal === undefined ? {} : { signal }),
  });
  const document = parseSkillDocument(decodeSkillText(bytes, true), name);
  const resources: SkillResourceIdentity[] = [];
  let files = 1;
  let totalBytes = 0;
  let directories = 0;
  const observations: { relative: string; kind: 'file' | 'directory'; stat: Stats }[] = [];
  observations.push({ relative: `${name}/SKILL.md`, kind: 'file', stat: instructionStat });
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 8 || ++directories > 1000) throw new SkillHostError('skill-limit-exceeded');
    const relativeRoot = relative === '' ? name : `${name}/${relative}`;
    const before = await inspectSkillPath(root, relativeRoot, 'directory');
    observations.push({ relative: relativeRoot, kind: 'directory', stat: before });
    const directory = await fs.opendir(path.join(root.directory, ...relativeRoot.split('/')));
    const children: string[] = [];
    try {
      for (;;) {
        checkSkillAbort(signal);
        const entry = await directory.read();
        if (entry === null) break;
        const resourcePath = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (resourcePath === 'SKILL.md') continue;
        if (!isSkillResourcePath(resourcePath) || entry.isSymbolicLink())
          throw new SkillHostError('skill-unsafe-entry');
        if (entry.isDirectory()) {
          if (children.length + directories > 1000)
            throw new SkillHostError('skill-limit-exceeded');
          children.push(resourcePath);
          continue;
        }
        if (!entry.isFile()) throw new SkillHostError('skill-unsafe-entry');
        if (++files > maxFiles) throw new SkillHostError('skill-limit-exceeded');
        const resourceStat = await inspectSkillPath(root, `${name}/${resourcePath}`, 'file');
        const content = await readSkillBytes({
          root,
          relative: `${name}/${resourcePath}`,
          maxBytes: maxResourceBytes - totalBytes,
          budget,
          ...(signal === undefined ? {} : { signal }),
        });
        totalBytes += content.byteLength;
        resources.push(
          Object.freeze({ path: resourcePath, sha256: sha256(content), bytes: content.byteLength }),
        );
        observations.push({
          relative: `${name}/${resourcePath}`,
          kind: 'file',
          stat: resourceStat,
        });
      }
    } finally {
      await directory.close();
    }
    const after = await inspectSkillPath(root, relativeRoot, 'directory');
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new SkillHostError('skill-source-changed');
    for (const child of children.sort(byteOrder)) await walk(child, depth + 1);
  };
  await walk('', 0);
  for (const observation of observations) {
    const current = await inspectSkillPath(root, observation.relative, observation.kind);
    if (
      observation.stat.dev !== current.dev ||
      observation.stat.ino !== current.ino ||
      observation.stat.size !== current.size ||
      observation.stat.mtimeMs !== current.mtimeMs ||
      observation.stat.ctimeMs !== current.ctimeMs
    )
      throw new SkillHostError('skill-source-changed');
  }
  resources.sort((a, b) => byteOrder(a.path, b.path));
  const instructionSha256 = sha256(document.instructions);
  const bundleSha256 = sha256(
    JSON.stringify([
      document.name,
      document.description,
      document.invocation.user,
      document.invocation.model,
      instructionSha256,
      resources.map((resource) => [resource.path, resource.sha256, resource.bytes]),
    ]),
  );
  const handle = Object.freeze({ rootId, name, instructionSha256, bundleSha256 });
  checkSkillAbort(signal);
  return {
    document,
    discovered: Object.freeze({
      handle,
      name,
      description: document.description,
      invocation: document.invocation,
      ...(document.ignoredFields === undefined ? {} : { ignoredFields: document.ignoredFields }),
      resources: Object.freeze(resources),
    }),
  };
}

function issueField(error: unknown): { readonly field: string } | Record<string, never> {
  return error instanceof SkillHostError && error.field !== undefined ? { field: error.field } : {};
}

function issue(error: unknown): SkillDiscoveryResult['issues'][number]['code'] {
  if (error instanceof SkillHostError)
    return error.code.slice('skill-'.length) as SkillDiscoveryResult['issues'][number]['code'];
  return 'unreadable';
}

export async function discoverSkillBundles(input: SkillIoOptions): Promise<SkillDiscoveryResult> {
  checkSkillAbort(input.signal);
  const budget = input.budget ?? createSkillScanBudget();
  const bundles: DiscoveredSkillBundle[] = [];
  const issues: SkillDiscoveryResult['issues'][number][] = [];
  let truncated = false;
  let inspectedRoot = false;
  try {
    const root = await inspectSkillRoot(input.root.directory, input.signal);
    inspectedRoot = true;
    const listed = await listDirectories(root, input.signal);
    truncated = listed.truncated;
    if (listed.unsafe) issues.push(Object.freeze({ code: 'unsafe-entry' }));
    if (truncated) issues.push(Object.freeze({ code: 'limit-exceeded' }));
    for (const name of listed.names) {
      try {
        bundles.push(
          (await readBundle(root, name, input.root.id, budget, input.signal)).discovered,
        );
      } catch (error: unknown) {
        checkSkillAbort(input.signal);
        const code = issue(error);
        if (issues.length < 64) issues.push(Object.freeze({ code, name, ...issueField(error) }));
        if (code === 'limit-exceeded') {
          truncated = true;
          if (budget.remainingBytes === 0) break;
        }
      }
    }
    const after = await fs.lstat(root.directory);
    if (
      after.dev !== root.dev ||
      after.ino !== root.ino ||
      after.mtimeMs !== root.mtimeMs ||
      after.ctimeMs !== root.ctimeMs
    ) {
      bundles.length = 0;
      if (issues.length < 64) issues.push(Object.freeze({ code: 'source-changed' }));
    }
  } catch (error: unknown) {
    checkSkillAbort(input.signal);
    if (inspectedRoot || !isMissingSkillPath(error)) {
      bundles.length = 0;
      if (issues.length < 64)
        issues.push(
          Object.freeze({ code: isMissingSkillPath(error) ? 'source-changed' : issue(error) }),
        );
    }
  }
  checkSkillAbort(input.signal);
  return Object.freeze({
    bundles: Object.freeze(bundles),
    complete: issues.length === 0 && !truncated,
    truncated,
    issues: Object.freeze(issues),
  });
}

export async function pinSkillBundle(
  input: SkillIoOptions & { readonly handle: DiskSkillHandle },
): Promise<PinnedSkillBundle> {
  checkSkillAbort(input.signal);
  if (input.root.id !== input.handle.rootId) throw new SkillHostError('skill-source-changed');
  try {
    const root = await inspectSkillRoot(input.root.directory, input.signal);
    const { document, discovered } = await readBundle(
      root,
      input.handle.name,
      input.root.id,
      input.budget ?? createSkillScanBudget(),
      input.signal,
    );
    if (
      discovered.handle.instructionSha256 !== input.handle.instructionSha256 ||
      discovered.handle.bundleSha256 !== input.handle.bundleSha256
    )
      throw new SkillHostError('skill-source-changed');
    checkSkillAbort(input.signal);
    return Object.freeze({
      handle: discovered.handle,
      instructions: document.instructions,
      resources: discovered.resources,
    });
  } catch (error: unknown) {
    checkSkillAbort(input.signal);
    if (error instanceof SkillHostError && error.code === 'skill-limit-exceeded') throw error;
    throw new SkillHostError('skill-source-changed', { cause: error });
  }
}

export async function readPinnedSkillResource(
  input: SkillIoOptions & { readonly bundle: PinnedSkillBundle; readonly path: string },
): Promise<{ readonly text: string; readonly sha256: string }> {
  checkSkillAbort(input.signal);
  if (input.root.id !== input.bundle.handle.rootId)
    throw new SkillHostError('skill-source-changed');
  const expected = input.bundle.resources.find((resource) => resource.path === input.path);
  if (!isSkillResourcePath(input.path) || expected === undefined)
    throw new SkillHostError('skill-unsafe-entry');
  let content: Buffer;
  try {
    const root = await inspectSkillRoot(input.root.directory, input.signal);
    content = await readSkillBytes({
      root,
      relative: `${input.bundle.handle.name}/${input.path}`,
      maxBytes: expected.bytes,
      budget: input.budget ?? createSkillScanBudget(),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error: unknown) {
    checkSkillAbort(input.signal);
    throw new SkillHostError('skill-source-changed', { cause: error });
  }
  if (content.byteLength !== expected.bytes || sha256(content) !== expected.sha256)
    throw new SkillHostError('skill-source-changed');
  const text = decodeSkillText(content, false);
  checkSkillAbort(input.signal);
  return Object.freeze({ text, sha256: expected.sha256 });
}
