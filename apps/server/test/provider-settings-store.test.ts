import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSqliteProviderSettingsStore,
  type ProviderSettingsRecord,
} from '../src/provider-settings-store.js';

const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryFiles.splice(0).map((filename) => rm(filename, { force: true })),
  );
});

function createFilename(): string {
  const filename = join(tmpdir(), `weave-provider-settings-${randomUUID()}.sqlite`);
  temporaryFiles.push(filename);
  return filename;
}

function createRecord(
  overrides: Partial<ProviderSettingsRecord> = {},
): ProviderSettingsRecord {
  const now = new Date().toISOString();
  return {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    encryptedApiKey: 'encrypted-secret',
    defaultModel: 'deepseek-chat',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Provider Settings SQLite Store', () => {
  it('creates the table idempotently and persists a record across reopen', async () => {
    const filename = createFilename();
    const record = createRecord();
    const store = createSqliteProviderSettingsStore({ filename });

    await store.create(record);
    await store.close();

    const reopened = createSqliteProviderSettingsStore({ filename });
    await expect(reopened.get(record.id)).resolves.toEqual(record);
    await reopened.close();
  });

  it('keeps a cleared API key as null without returning plaintext fields', async () => {
    const filename = createFilename();
    const store = createSqliteProviderSettingsStore({ filename });
    const record = createRecord({ encryptedApiKey: null });

    await store.create(record);

    await expect(store.get(record.id)).resolves.toMatchObject({
      id: record.id,
      encryptedApiKey: null,
    });
    await expect(store.list()).resolves.toHaveLength(1);
    expect(JSON.stringify(await store.list())).not.toContain('apiKey');
    await store.close();
  });

  it('updates and deletes records while repeated close remains safe', async () => {
    const filename = createFilename();
    const store = createSqliteProviderSettingsStore({ filename });
    const record = createRecord({ encryptedApiKey: 'first' });

    await store.create(record);
    await store.update({ ...record, label: 'Changed', encryptedApiKey: null });
    await expect(store.get(record.id)).resolves.toMatchObject({
      label: 'Changed',
      encryptedApiKey: null,
    });

    await store.delete(record.id);
    await expect(store.get(record.id)).resolves.toBeUndefined();
    await store.close();
    await store.close();
  });

  it('lists records in creation order', async () => {
    const filename = createFilename();
    const store = createSqliteProviderSettingsStore({ filename });
    const first = createRecord({ id: 'first', label: 'First' });
    const second = createRecord({ id: 'second', label: 'Second' });

    await store.create(first);
    await store.create(second);

    await expect(store.list()).resolves.toEqual([first, second]);
    await store.close();
  });
});
