import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSqliteProviderSettingsStore,
  type ProviderSettingsRecord,
} from '../src/provider-settings-store.js';

const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryFiles.splice(0).map((filename) => rm(filename, { force: true })));
});

function createFilename(): string {
  const filename = join(tmpdir(), `weave-provider-settings-${randomUUID()}.sqlite`);
  temporaryFiles.push(filename);
  return filename;
}

function createRecord(overrides: Partial<ProviderSettingsRecord> = {}): ProviderSettingsRecord {
  const now = new Date().toISOString();
  return {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    encryptedApiKey: 'encrypted-secret',
    defaultModel: 'deepseek-chat',
    isDefault: false,
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

  it('persists per-Provider model params across reopen', async () => {
    const filename = createFilename();
    const record = createRecord({ contextWindowTokens: 64_000, temperature: 0.3, maxTokens: 2048 });
    const store = createSqliteProviderSettingsStore({ filename });

    await store.create(record);
    await store.close();

    const reopened = createSqliteProviderSettingsStore({ filename });
    await expect(reopened.get(record.id)).resolves.toEqual(record);
    await reopened.close();
  });

  it('upgrades a legacy database that lacks the model-param columns', async () => {
    const filename = createFilename();
    const now = new Date().toISOString();
    const seed = new DatabaseSync(filename);
    seed.exec(`
      CREATE TABLE provider_settings (
        id TEXT NOT NULL PRIMARY KEY,
        label TEXT NOT NULL,
        type TEXT NOT NULL,
        base_url TEXT NOT NULL,
        encrypted_api_key TEXT,
        default_model TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    seed
      .prepare(
        `INSERT INTO provider_settings
          (id, label, type, base_url, encrypted_api_key, default_model, is_default,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'deepseek',
        'DeepSeek',
        'openai-compatible',
        'https://api.deepseek.com',
        'cipher',
        'deepseek-chat',
        0,
        now,
        now,
      );
    seed.close();

    const store = createSqliteProviderSettingsStore({ filename });
    const existing = await store.get('deepseek');
    expect(existing?.id).toBe('deepseek');
    expect(existing?.temperature).toBeUndefined();

    await store.update(
      createRecord({
        encryptedApiKey: 'cipher',
        createdAt: now,
        temperature: 0.5,
        maxTokens: 1024,
      }),
    );
    await expect(store.get('deepseek')).resolves.toMatchObject({
      temperature: 0.5,
      maxTokens: 1024,
    });
    await store.close();
  });

  it('adds its columns on a shared database whose user_version another store set', async () => {
    const filename = createFilename();
    const now = new Date().toISOString();
    // Simulate the shared weave.sqlite: the base table exists and another store
    // (e.g. the Session store) already advanced the single user_version to 1.
    const seed = new DatabaseSync(filename);
    seed.exec(`
      CREATE TABLE provider_settings (
        id TEXT NOT NULL PRIMARY KEY,
        label TEXT NOT NULL,
        type TEXT NOT NULL,
        base_url TEXT NOT NULL,
        encrypted_api_key TEXT,
        default_model TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    seed.exec('PRAGMA user_version = 1');
    seed.close();

    const store = createSqliteProviderSettingsStore({ filename });
    await store.create(
      createRecord({ createdAt: now, updatedAt: now, temperature: 0.5, maxTokens: 1024 }),
    );
    await expect(store.get('deepseek')).resolves.toMatchObject({
      temperature: 0.5,
      maxTokens: 1024,
    });
    await store.close();
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
