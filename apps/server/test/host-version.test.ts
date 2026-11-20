import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverHostVersion } from '../src/host-version.js';

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
});

describe('serverHostVersion', () => {
  it('uses the Server package product version accepted by plugin engine constraints', () => {
    const metadata = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      readonly version: string;
    };

    expect(serverHostVersion).toBe(metadata.version);
    expect(serverHostVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each([{ apiVersion: '1.0.0' }, { version: '1.0', apiVersion: '1.0.0' }, { version: 100 }])(
    'rejects invalid product metadata instead of falling back to an API version',
    async (metadata) => {
      vi.resetModules();
      vi.doMock('node:fs', () => ({ readFileSync: () => JSON.stringify(metadata) }));

      await expect(import('../src/host-version.js')).rejects.toThrow();
    },
  );
});
