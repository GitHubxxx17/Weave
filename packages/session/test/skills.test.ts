import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSqliteSessionEventStore,
  createInMemorySessionEventStore,
  newSessionEventSchema,
  projectSession,
} from '../src/index.js';

const ref = {
  id: 'builtin:weave-planning',
  instructionSha256: 'a'.repeat(64),
  bundleSha256: 'b'.repeat(64),
};
const skill = {
  ...ref,
  name: 'weave-planning',
  description: 'Make a plan',
  source: { kind: 'builtin' as const, label: 'Weave' },
  invocation: { user: true, model: true },
};

describe('durable Skill provenance', () => {
  it('rebinds a legacy inferred user association after an orphaned running turn', async () => {
    const store = createSqliteSessionEventStore({ filename: ':memory:' });
    try {
      await store.append('s', [
        { type: 'session.created', payload: {} },
        { type: 'turn.started', payload: { turnId: 'orphan' } },
        {
          type: 'message.created',
          payload: {
            messageId: 'u',
            message: { role: 'user', content: [{ type: 'text', text: 'Resume' }] },
          },
        },
      ]);
      expect(projectSession(await store.read('s')).messages[0]?.turnId).toBe('orphan');
      await store.append('s', [
        { type: 'turn.started', payload: { turnId: 'new', userMessageId: 'u' } },
        { type: 'skill.requested', payload: { turnId: 'new', userMessageId: 'u', skills: [] } },
        { type: 'turn.completed', payload: { turnId: 'new', status: 'completed' } },
      ]);
      expect(projectSession(await store.read('s')).messages[0]?.turnId).toBe('new');
      await store.append('s', [
        { type: 'turn.started', payload: { turnId: 'duplicate', userMessageId: 'u' } },
      ]);
      const log = await store.read('s');
      expect(() => projectSession(log)).toThrow(/unassigned/);
    } finally {
      await store.close();
    }
  });
  it('rejects repeated explicit empty requests and mismatched source attribution', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('s', [
      { type: 'session.created', payload: {} },
      {
        type: 'message.created',
        payload: {
          messageId: 'u',
          message: { role: 'user', content: [{ type: 'text', text: 'Plan' }] },
        },
      },
      { type: 'turn.started', payload: { turnId: 't', userMessageId: 'u' } },
      { type: 'skill.requested', payload: { turnId: 't', userMessageId: 'u', skills: [] } },
      { type: 'skill.requested', payload: { turnId: 't', userMessageId: 'u', skills: [] } },
    ]);
    expect(() =>
      newSessionEventSchema.parse({
        type: 'skill.applied',
        payload: {
          turnId: 't',
          skill: { ...skill, source: { kind: 'plugin', label: 'Fake owner', pluginId: 'other' } },
          invocation: 'user',
          placement: 0,
        },
      }),
    ).toThrow();
    const log = await store.read('s');
    expect(() => projectSession(log)).toThrow(/already recorded/);
  });
  it('rejects malformed exact identities and unsupported audit facts', () => {
    expect(
      newSessionEventSchema.safeParse({
        type: 'skill.requested',
        payload: {
          turnId: 't',
          userMessageId: 'u',
          skills: [ref],
        },
      }).success,
    ).toBe(true);
    expect(
      newSessionEventSchema.safeParse({
        type: 'skill.applied',
        payload: {
          turnId: 't',
          skill: { ...skill, bundleSha256: 'newest' },
          invocation: 'user',
          placement: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      newSessionEventSchema.safeParse({ type: 'skill.grant-permission', payload: {} }).success,
    ).toBe(false);
  });

  it('restores exact user-to-turn and requested, prepared and failed facts after SQLite restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weave-skill-history-'));
    const filename = join(dir, 'events.sqlite');
    const first = createSqliteSessionEventStore({ filename });
    try {
      await first.append('s', [
        { type: 'session.created', payload: {} },
        {
          type: 'message.created',
          payload: {
            messageId: 'u',
            message: { role: 'user', content: [{ type: 'text', text: 'Plan' }] },
          },
        },
        {
          type: 'turn.started',
          payload: {
            turnId: 't',
            userMessageId: 'u',
            request: { provider: 'mock', model: 'm', permissionMode: 'ask' },
          },
        },
        { type: 'skill.requested', payload: { turnId: 't', userMessageId: 'u', skills: [ref] } },
        {
          type: 'skill.content',
          payload: { sha256: ref.instructionSha256, text: 'Plan carefully.' },
        },
        {
          type: 'skill.applied',
          payload: { turnId: 't', skill, invocation: 'user', placement: 0 },
        },
        {
          type: 'skill.failed',
          payload: { turnId: 't', skill: ref, stage: 'resource', code: 'skill-source-changed' },
        },
        { type: 'turn.completed', payload: { turnId: 't', status: 'completed' } },
      ]);
      await first.close();
      const reopened = createSqliteSessionEventStore({ filename });
      try {
        const events = await reopened.read('s');
        const result = projectSession(events);
        expect(result.messages[0]?.turnId).toBe('t');
        expect(result.messages).toHaveLength(1);
        expect(result.turns[0]).toMatchObject({
          userMessageId: 'u',
          request: { provider: 'mock', model: 'm' },
          skills: {
            requested: [ref],
            applications: [{ skill, invocation: 'user', delivery: 'prepared' }],
            failures: [{ skill: ref, stage: 'resource', code: 'skill-source-changed' }],
          },
        });
        const snapshot = result.turns[0]!.skills!;
        snapshot.requested[0]!.id = 'builtin:mutation';
        expect(projectSession(events).turns[0]?.skills?.requested).toEqual([ref]);
      } finally {
        await reopened.close();
      }
    } finally {
      await first.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not claim model delivery until a matching successful durable EOF exists', async () => {
    const store = createSqliteSessionEventStore({ filename: ':memory:' });
    try {
      await store.append('s', [
        { type: 'session.created', payload: {} },
        { type: 'turn.started', payload: { turnId: 't' } },
        { type: 'step.started', payload: { turnId: 't', stepId: 'step', kind: 'tool' } },
        {
          type: 'tool-call.created',
          payload: {
            turnId: 't',
            stepId: 'step',
            toolCall: { id: 'call', name: 'read_skill', arguments: '{}' },
          },
        },
        {
          type: 'skill.applied',
          payload: { turnId: 't', skill, invocation: 'model', placement: 0, toolCallId: 'call' },
        },
      ]);
      expect(
        projectSession(await store.read('s')).turns[0]?.skills?.applications[0]?.delivery,
      ).toBe('prepared');
      await store.append('s', [
        {
          type: 'tool-result.created',
          payload: {
            turnId: 't',
            stepId: 'step',
            toolCallId: 'call',
            name: 'read_skill',
            content: JSON.stringify({
              skill: ref,
              kind: 'instructions',
              contentSha256: ref.instructionSha256,
              text: 'Plan carefully.',
              offset: 0,
              eof: true,
            }),
            truncated: false,
            status: 'completed',
          },
        },
      ]);
      expect(
        projectSession(await store.read('s')).turns[0]?.skills?.applications[0]?.delivery,
      ).toBe('delivered');
    } finally {
      await store.close();
    }
  });
});
