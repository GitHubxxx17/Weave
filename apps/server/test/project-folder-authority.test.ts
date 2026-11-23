import { mkdtemp, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInMemoryProjectStore, type ProjectStore } from '@weave/workspace';
import {
  createProjectFolderAuthority,
  type ProjectFolderBinding,
} from '../src/project-folder-authority.js';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});
async function fixture(withFolder = true) {
  const temp = await mkdtemp(path.join(tmpdir(), 'weave-project-authority-'));
  folders.push(temp);
  const a = path.join(temp, 'a');
  const b = path.join(temp, 'b');
  await Promise.all([mkdir(a), mkdir(b)]);
  const store = createInMemoryProjectStore();
  const project = await store.createProject({
    name: 'Project',
    folderName: 'project',
    ...(withFolder ? { folderPath: a } : {}),
  });
  await store.attachSession(project.id, 'parent');
  await store.attachSession(project.id, 'child');
  const authority = createProjectFolderAuthority(store);
  return { store, project, authority, a, b };
}

describe('Project folder authority', () => {
  it('pins a child to the captured canonical root and exact Project revision', async () => {
    const { authority, project, a } = await fixture();
    const binding = await authority.capture('parent');
    expect(authority.snapshot(binding)).toMatchObject({
      projectId: project.id,
      folderRevision: 0,
      folderPath: a,
      rootDigest: expect.any(String),
    });
    expect((await authority.resolve(binding, 'child'))?.root).toBe(await realpath(a));
    expect(() => authority.assertCurrentSync(binding)).not.toThrow();
  });

  it('rejects cloned and fabricated bindings', async () => {
    const { authority } = await fixture();
    const binding = await authority.capture('parent');
    await expect(authority.resolve({ ...binding }, 'child')).rejects.toMatchObject({
      code: 'task-project-authority-invalid',
    });
    expect(() => authority.snapshot({} as ProjectFolderBinding)).toThrow();
  });

  it('does not give a no-folder binding a Workspace after the Project gains one', async () => {
    const { authority, project, a } = await fixture(false);
    const binding = await authority.capture('parent');
    expect(await authority.resolve(binding, 'child')).toBeUndefined();
    await authority.updateFolder(project.id, a);
    await expect(authority.resolve(binding, 'child')).rejects.toMatchObject({
      code: 'task-project-folder-changed',
    });
  });

  it.each(['different', 'same', 'clear', 'aba'] as const)(
    'permanently fences an old token after a %s folder update',
    async (mode) => {
      const { authority, project, a, b } = await fixture();
      const binding = await authority.capture('parent');
      await authority.updateFolder(
        project.id,
        mode === 'clear' ? undefined : mode === 'same' ? a : b,
      );
      if (mode === 'aba') await authority.updateFolder(project.id, a);
      expect(authority.signal(binding).aborted).toBe(true);
      expect(() => authority.assertCurrentSync(binding)).toThrow();
      await expect(authority.resolve(binding, 'child')).rejects.toMatchObject({
        code: 'task-project-folder-changed',
      });
      const next = await authority.capture('parent');
      expect(authority.snapshot(next).folderRevision).toBe(mode === 'aba' ? 2 : 1);
    },
  );

  it('keeps authority through a Project rename', async () => {
    const { authority, store, project, a } = await fixture();
    const binding = await authority.capture('parent');
    await store.renameProject(project.id, 'Renamed');
    expect((await authority.resolve(binding, 'child'))?.root).toBe(await realpath(a));
  });

  it('fences before a Store write and never revives authority when the write fails', async () => {
    const { store, project, a, b } = await fixture();
    const faulty: ProjectStore = {
      ...store,
      updateProjectFolder: async () => {
        expect(authority.signal(binding).aborted).toBe(true);
        throw new Error('Store unavailable');
      },
    };
    const authority = createProjectFolderAuthority(faulty);
    const binding = await authority.capture('parent');
    await expect(authority.updateFolder(project.id, b)).rejects.toThrow('Store unavailable');
    expect((await store.getProject(project.id))?.folderPath).toBe(a);
    await expect(authority.resolve(binding, 'child')).rejects.toMatchObject({
      code: 'task-project-folder-changed',
    });
    expect((await authority.resolve(await authority.capture('parent'), 'child'))?.root).toBe(
      await realpath(a),
    );
  });

  it('detects direct Store revision changes and fences synchronous mutation permits', async () => {
    const { authority, store, project, a } = await fixture();
    const binding = await authority.capture('parent');
    await store.updateProjectFolder(project.id, a);
    await expect(authority.checkpoint(binding, 'child')).rejects.toMatchObject({
      code: 'task-project-folder-changed',
    });
    expect(() => authority.assertCurrentSync(binding)).toThrow();
  });

  it('detects replacement of the root directory at the same path', async () => {
    const { authority, a } = await fixture();
    const binding = await authority.capture('parent');
    await rename(a, `${a}-old`);
    await mkdir(a);
    await expect(authority.resolve(binding, 'child')).rejects.toMatchObject({
      code: 'task-project-root-changed',
    });
    expect(authority.signal(binding).aborted).toBe(true);
  });

  it('rejects unrelated and multiply attached Sessions', async () => {
    const { authority, store, b } = await fixture();
    const binding = await authority.capture('parent');
    await expect(authority.resolve(binding, 'unrelated')).rejects.toMatchObject({
      code: 'task-project-relation-changed',
    });
    const other = await store.createProject({ name: 'Other', folderName: 'b', folderPath: b });
    await store.attachSession(other.id, 'child');
    const fresh = await authority.capture('parent');
    await expect(authority.resolve(fresh, 'child')).rejects.toMatchObject({
      code: 'task-project-relation-changed',
    });
  });

  it('serializes capture with folder updates and runs revocation callbacks outside its gate', async () => {
    const { store, project, b } = await fixture();
    const observed: number[] = [];
    const callbacks: Promise<void>[] = [];
    const authority = createProjectFolderAuthority(store, {
      onRevoked: (binding) => {
        expect(authority.signal(binding).aborted).toBe(true);
        callbacks.push(
          authority.capture('parent').then((next) => {
            observed.push(authority.snapshot(next).folderRevision);
          }),
        );
      },
    });
    const old = await authority.capture('parent');
    const change = authority.updateFolder(project.id, b);
    const capture = authority.capture('parent');
    await change;
    const next = await capture;
    await Promise.all(callbacks);
    expect(authority.snapshot(next).folderRevision).toBe(1);
    expect(observed).toEqual([1]);
    expect(authority.signal(old).aborted).toBe(true);
  });

  it('rechecks after an asynchronous exact-operation callback without holding a mutation lock', async () => {
    const { authority, project, b } = await fixture();
    const binding = await authority.capture('parent');
    await authority.withAuthority(binding, 'child', async () => {
      authority.assertCurrentSync(binding);
    });
    await authority.updateFolder(project.id, b);
    let called = false;
    await expect(
      authority.withAuthority(binding, 'child', async () => {
        called = true;
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('releases completed bindings and fences all active ones synchronously at shutdown', async () => {
    const { authority } = await fixture();
    const first = await authority.capture('parent');
    const second = await authority.capture('parent');
    authority.release(first);
    authority.release(first);
    expect(() => authority.assertCurrentSync(first)).toThrow();
    authority.closeSync();
    expect(authority.signal(second).aborted).toBe(true);
    await expect(authority.capture('parent')).rejects.toMatchObject({
      code: 'task-project-authority-closed',
    });
  });

  it('fences the full affected batch before notifying any abort listener', async () => {
    const { authority, project, b } = await fixture();
    const first = await authority.capture('parent');
    const second = await authority.capture('parent');
    let secondRejected = false;
    authority.signal(first).addEventListener('abort', () => {
      try {
        authority.assertCurrentSync(second);
      } catch {
        secondRejected = true;
      }
    });
    await authority.updateFolder(project.id, b);
    expect(secondRejected).toBe(true);
  });
});
