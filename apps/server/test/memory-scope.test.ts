import { createInMemorySessionEventStore } from '@weave/session';
import { createInMemoryProjectStore } from '@weave/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryScopeResolver } from '../src/memory-scope.js';
import { createSessionService } from '../src/session-service.js';

const resources: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});
function fixture() {
  const sessionStore = createInMemorySessionEventStore();
  const projectStore = createInMemoryProjectStore();
  resources.push(sessionStore, projectStore);
  const scopes = createMemoryScopeResolver({ sessionStore, projectStore });
  const sessions = createSessionService({
    sessionStore,
    projectStore,
    withMemoryMembershipMutation: scopes.withMemoryMembershipMutation,
  });
  return { sessionStore, projectStore, scopes, sessions };
}

describe('Memory Session scope evidence', () => {
  it('distinguishes existing unbound, unique and ambiguous Sessions and ignores folder renames', async () => {
    const { sessionStore, projectStore, scopes, sessions } = fixture();
    await sessionStore.append('unbound', [{ type: 'session.created', payload: {} }]);
    expect((await scopes.captureMemorySessionScope('unbound')).membership).toEqual({
      kind: 'none',
    });
    const first = await projectStore.createProject({ name: 'First', folderName: 'first' });
    const session = await sessions.create(first.id);
    const unique = await scopes.captureMemorySessionScope(session.id);
    expect(unique.membership).toEqual({ kind: 'unique', projectId: first.id });
    await projectStore.renameProject(first.id, 'Renamed');
    await projectStore.updateProjectFolder(first.id, '/renamed');
    expect(() => unique.assertCurrentSync()).not.toThrow();
    const second = await projectStore.createProject({ name: 'Second', folderName: 'second' });
    await scopes.withMemoryMembershipMutation(session.id, () =>
      projectStore.attachSession(second.id, session.id),
    );
    expect(() => unique.assertCurrentSync()).toThrowError(
      expect.objectContaining({ code: 'memory-scope-forbidden' }),
    );
    expect((await scopes.captureMemorySessionScope(session.id)).membership).toEqual({
      kind: 'ambiguous',
    });
  });

  it('invalidates evidence before mutation starts, after failed settle and through nested mutations', async () => {
    const { sessionStore, scopes } = fixture();
    await sessionStore.append('root', [{ type: 'session.created', payload: {} }]);
    const before = await scopes.captureMemorySessionScope('root');
    const gate = Promise.withResolvers<void>();
    const mutation = scopes.withMemoryMembershipMutation('root', async () => {
      expect(() => before.assertCurrentSync()).toThrow();
      await scopes.withMemoryMembershipMutation('root', async () => {});
      await gate.promise;
      throw new Error('attach failed');
    });
    await expect(scopes.captureMemorySessionScope('root')).rejects.toMatchObject({
      code: 'memory-scope-forbidden',
    });
    gate.resolve();
    await expect(mutation).rejects.toThrow('attach failed');
    expect(() => before.assertCurrentSync()).toThrow();
    expect((await scopes.captureMemorySessionScope('root')).membership).toEqual({ kind: 'none' });
  });

  it('rejects a capture raced by membership changes while Project reads are suspended', async () => {
    const { sessionStore, projectStore, scopes } = fixture();
    await sessionStore.append('root', [{ type: 'session.created', payload: {} }]);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const list = projectStore.listProjects.bind(projectStore);
    vi.spyOn(projectStore, 'listProjects').mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return list();
    });
    const capture = scopes.captureMemorySessionScope('root');
    await entered.promise;
    await scopes.withMemoryMembershipMutation('root', async () => {});
    gate.resolve();
    await expect(capture).rejects.toMatchObject({ code: 'memory-scope-forbidden' });
  });

  it('refuses unknown and deleted Sessions and invalidates deletion before the append settles', async () => {
    const { projectStore, sessionStore, scopes, sessions } = fixture();
    await expect(scopes.captureMemorySessionScope('unknown')).rejects.toMatchObject({
      code: 'memory-scope-forbidden',
    });
    const project = await projectStore.createProject({ name: 'Test', folderName: 'test' });
    const session = await sessions.create(project.id);
    const evidence = await scopes.captureMemorySessionScope(session.id);
    const append = sessionStore.append.bind(sessionStore);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    vi.spyOn(sessionStore, 'append').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return append(...args);
    });
    const deletion = sessions.delete(session.id);
    await entered.promise;
    expect(() => evidence.assertCurrentSync()).toThrow();
    await expect(scopes.captureMemorySessionScope(session.id)).rejects.toMatchObject({
      code: 'memory-scope-forbidden',
    });
    gate.resolve();
    await deletion;
    await expect(scopes.captureMemorySessionScope(session.id)).rejects.toMatchObject({
      code: 'memory-scope-forbidden',
    });
  });

  it('does not capture a Session between ordinary creation and attachment', async () => {
    const { projectStore, sessionStore, scopes, sessions } = fixture();
    const project = await projectStore.createProject({ name: 'Test', folderName: 'test' });
    const append = sessionStore.append.bind(sessionStore);
    const entered = Promise.withResolvers<string>();
    const gate = Promise.withResolvers<void>();
    vi.spyOn(sessionStore, 'append').mockImplementationOnce(async (sessionId, events) => {
      await append(sessionId, events);
      entered.resolve(sessionId);
      await gate.promise;
      return [];
    });
    const created = sessions.create(project.id);
    const sessionId = await entered.promise;
    await expect(scopes.captureMemorySessionScope(sessionId)).rejects.toMatchObject({
      code: 'memory-scope-forbidden',
    });
    gate.resolve();
    await created;
    expect((await scopes.captureMemorySessionScope(sessionId)).membership).toEqual({
      kind: 'unique',
      projectId: project.id,
    });
  });
});

describe('Memory local scope authority', () => {
  it('allows explicit user scope and only projects that currently exist', async () => {
    const { scopes, projectStore } = fixture();
    const project = await projectStore.createProject({ name: 'Actual', folderName: 'actual' });
    await expect(
      scopes.resolveLocalScope({ kind: 'project', projectId: project.id }),
    ).resolves.toHaveProperty('assertCurrentSync');
    await expect(scopes.resolveLocalScope({ kind: 'user' })).resolves.toHaveProperty(
      'assertCurrentSync',
    );
    await expect(
      scopes.resolveLocalScope({ kind: 'project', projectId: 'missing' }),
    ).rejects.toMatchObject({ code: 'memory-not-found' });
  });

  it('rejects caller JSON even when its claimed Session exists', async () => {
    const { scopes, sessionStore } = fixture();
    await sessionStore.append('root', [{ type: 'session.created', payload: {} }]);
    const caller = {
      identity: {
        sessionId: 'root',
        executionId: 'execution',
        turnId: 'turn',
        userMessageId: 'message',
      },
      settings: {},
      tools: [],
      toolCallId: 'call',
      toolName: 'read_memory',
    };
    await expect(scopes.resolveAgentScope(caller as never)).rejects.toMatchObject({
      code: 'memory-scope-forbidden',
    });
  });
});
