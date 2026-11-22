import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDescriptor } from '@weave/plugin-host';
import {
  assertOfficialMarketplaceEntry,
  reservedMarketplacePluginIds,
} from '../src/official-marketplace-releases.js';

const source = fileURLToPath(
  new URL('../../../plugins/official/weave-web-source/', import.meta.url),
);

describe('official web plugin author source', () => {
  it('reserves discovery attribution until a real content commit is released', () => {
    expect(reservedMarketplacePluginIds).not.toContain('weave-web');
    expect(() => assertOfficialMarketplaceEntry({ id: 'weave-web', releases: [] })).toThrow(
      'Unrecognized official marketplace release',
    );
  });
  it('declares independent protected network tools and a single ESM entry', async () => {
    const descriptor = parseDescriptor(await readFile(source + '/weave-plugin.json', 'utf8'));
    expect(descriptor).toEqual({
      schemaVersion: 1,
      entry: 'index.mjs',
      manifest: {
        id: 'weave-web',
        name: 'Weave 联网',
        version: '0.1.0',
        apiVersion: '1.0.0',
        description: '经共享审批搜索公开网页并读取有来源的有限文本。',
        host: 'in-process',
        capabilities: ['tool'],
        contributes: { tools: ['web_search', 'web_fetch'] },
        permissions: ['network:request'],
      },
    });
    expect(JSON.parse(await readFile(source + '/package.json', 'utf8'))).toEqual({
      name: 'weave-web-source',
      private: true,
      type: 'module',
    });
  });
});
