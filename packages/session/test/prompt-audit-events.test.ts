import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInMemorySessionEventStore,
  createSqliteSessionEventStore,
  newSessionEventSchema,
  projectSession,
  sessionEventSchema,
} from '../src/index.js';

const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryFiles
      .splice(0)
      .flatMap((filename) => [
        rm(filename, { force: true }),
        rm(`${filename}-wal`, { force: true }),
        rm(`${filename}-shm`, { force: true }),
      ]),
  );
});

const digest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);

const appliedPayload = {
  turnId: 'turn-1',
  sections: [
    { id: 'tone', pluginId: 'style-kit', sha256: digest, bytes: 9 },
    { id: 'care', pluginId: 'safety-kit', sha256: otherDigest, bytes: 10 },
  ],
};

const applied = { type: 'prompt.sections-applied' as const, payload: appliedPayload };

const content = {
  type: 'prompt.section-content' as const,
  payload: { sha256: digest, text: 'Be brief.' },
};

describe('prompt audit events', () => {
  it('accepts the applied set and the content of a section from a caller', () => {
    expect(newSessionEventSchema.parse(applied)).toEqual(applied);
    expect(newSessionEventSchema.parse(content)).toEqual(content);
  });

  it('accepts an applied set with no sections, which records that none apply any more', () => {
    const none = { type: 'prompt.sections-applied', payload: { turnId: 'turn-2', sections: [] } };

    expect(newSessionEventSchema.parse(none)).toEqual(none);
  });

  it('keeps fields it does not know, as the other core events do', () => {
    const parsed = newSessionEventSchema.parse({
      ...applied,
      payload: { ...applied.payload, note: 'later' },
    });

    expect(parsed.payload).toMatchObject({ note: 'later' });
  });

  it.each([
    ['a missing turn', { ...applied.payload, turnId: undefined }],
    ['an empty turn id', { ...applied.payload, turnId: '' }],
    ['sections that are not a list', { ...applied.payload, sections: 'tone' }],
    [
      'a section without a plugin',
      { ...applied.payload, sections: [{ id: 'tone', sha256: digest, bytes: 9 }] },
    ],
    [
      'a digest that is not 64 lowercase hex digits',
      { ...applied.payload, sections: [{ id: 'tone', pluginId: 'a', sha256: 'ABC', bytes: 9 }] },
    ],
    [
      'an uppercase digest',
      {
        ...applied.payload,
        sections: [{ id: 'tone', pluginId: 'a', sha256: 'A'.repeat(64), bytes: 9 }],
      },
    ],
    [
      'a negative size',
      { ...applied.payload, sections: [{ id: 'tone', pluginId: 'a', sha256: digest, bytes: -1 }] },
    ],
    [
      'a size with a fraction',
      { ...applied.payload, sections: [{ id: 'tone', pluginId: 'a', sha256: digest, bytes: 1.5 }] },
    ],
  ])('rejects an applied set with %s', (_label, payload) => {
    expect(
      newSessionEventSchema.safeParse({ type: 'prompt.sections-applied', payload }).success,
    ).toBe(false);
  });

  it.each([
    ['a bad digest', { sha256: 'nope', text: 'Be brief.' }],
    ['no text', { sha256: digest }],
    ['empty text', { sha256: digest, text: '' }],
  ])('rejects section content with %s', (_label, payload) => {
    expect(
      newSessionEventSchema.safeParse({ type: 'prompt.section-content', payload }).success,
    ).toBe(false);
  });

  it('reads back as stored events, with the Store assigning identity and order', async () => {
    const store = createInMemorySessionEventStore();

    const stored = await store.append('session-1', [content, applied]);
    const read = await store.read('session-1');

    expect(read).toEqual(stored);
    expect(read.map((event) => [event.sequence, event.type])).toEqual([
      [1, 'prompt.section-content'],
      [2, 'prompt.sections-applied'],
    ]);
    for (const event of read) {
      expect(sessionEventSchema.safeParse(event).success).toBe(true);
    }
    await store.close();
  });

  it('survives a SQLite store being closed and opened again', async () => {
    const filename = join(tmpdir(), `weave-prompt-audit-${randomUUID()}.sqlite`);
    temporaryFiles.push(filename);
    const store = createSqliteSessionEventStore({ filename });
    await store.append('session-1', [content, applied]);
    await store.close();

    const reopened = createSqliteSessionEventStore({ filename });
    try {
      expect(
        (await reopened.read('session-1')).map((event) => [event.type, event.payload]),
      ).toEqual([
        ['prompt.section-content', content.payload],
        ['prompt.sections-applied', applied.payload],
      ]);
    } finally {
      await reopened.close();
    }
  });

  it('refuses a malformed applied set without writing anything', async () => {
    const store = createInMemorySessionEventStore();

    await expect(
      store.append('session-1', [
        content,
        { type: 'prompt.sections-applied', payload: { turnId: 'turn-1', sections: 'tone' } },
      ] as never),
    ).rejects.toMatchObject({ code: 'session-store-invalid-input' });
    expect(await store.read('session-1')).toEqual([]);
    await store.close();
  });

  it('is left out of the Session projection, which only reads what it understands', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('session-1', [
      { type: 'session.created', payload: { title: 'Audit' } },
      content,
      applied,
    ]);

    const projection = projectSession(await store.read('session-1'));

    expect(projection.title).toBe('Audit');
    expect(projection.messages).toEqual([]);
    expect(projection.lastSequence).toBe(3);
    await store.close();
  });
});
