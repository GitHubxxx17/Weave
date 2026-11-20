import { describe, expect, it } from 'vitest';
import { resolvePluginsDirectory } from '../src/plugin-path.js';

describe('resolvePluginsDirectory', () => {
  it('keeps explicit disablement ahead of every configured path', () => {
    expect(
      resolvePluginsDirectory({
        pluginsDirectory: false,
        dataDirectory: '/tmp/weave',
        environment: { WEAVE_PLUGINS_DIR: '/tmp/env-plugins' },
      }),
    ).toBe(false);
  });

  it('prefers the explicit plugin directory over the environment and custom database', () => {
    expect(
      resolvePluginsDirectory({
        pluginsDirectory: '/tmp/explicit-plugins',
        databaseFile: '/tmp/test.sqlite',
        environment: { WEAVE_PLUGINS_DIR: '/tmp/env-plugins' },
      }),
    ).toBe('/tmp/explicit-plugins');
  });

  it('allows the environment to enable plugins beside an explicit database', () => {
    expect(
      resolvePluginsDirectory({
        databaseFile: '/tmp/test.sqlite',
        environment: { WEAVE_PLUGINS_DIR: '/tmp/env-plugins' },
      }),
    ).toBe('/tmp/env-plugins');
  });

  it('disables default plugin loading when only a database file is explicit', () => {
    expect(
      resolvePluginsDirectory({
        databaseFile: '/tmp/test.sqlite',
        environment: { WEAVE_DATA_DIR: '/tmp/env-data' },
      }),
    ).toBe(false);
  });

  it('uses the explicit data directory with a custom database', () => {
    expect(
      resolvePluginsDirectory({
        databaseFile: '/tmp/test.sqlite',
        dataDirectory: '/tmp/desktop-data',
        environment: { WEAVE_DATA_DIR: '/tmp/env-data' },
        platform: 'darwin',
      }),
    ).toBe('/tmp/desktop-data/plugins');
  });

  it('uses WEAVE_DATA_DIR before the operating system default', () => {
    expect(
      resolvePluginsDirectory({
        environment: { WEAVE_DATA_DIR: '/tmp/env-data' },
        platform: 'linux',
        homeDirectory: '/home/tester',
      }),
    ).toBe('/tmp/env-data/plugins');
  });

  it.each([
    ['darwin', {}, '/Users/tester', '/Users/tester/Library/Application Support/Weave/plugins'],
    ['linux', {}, '/home/tester', '/home/tester/.local/share/weave/plugins'],
    ['linux', { XDG_DATA_HOME: '/tmp/xdg' }, '/home/tester', '/tmp/xdg/weave/plugins'],
    [
      'win32',
      { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
      'C:\\Users\\tester',
      'C:\\Users\\tester\\AppData\\Roaming\\Weave\\plugins',
    ],
  ] as const)('uses %s platform defaults', (platform, environment, homeDirectory, expected) => {
    expect(resolvePluginsDirectory({ platform, environment, homeDirectory })).toBe(expected);
  });

  it('uses Windows separators for an explicit data directory', () => {
    expect(
      resolvePluginsDirectory({
        dataDirectory: 'C:\\Weave',
        platform: 'win32',
        environment: {},
      }),
    ).toBe('C:\\Weave\\plugins');
  });

  it.each([
    { pluginsDirectory: '', environment: {} },
    { environment: { WEAVE_PLUGINS_DIR: '' } },
    { dataDirectory: '', environment: {} },
    { environment: { WEAVE_DATA_DIR: '' } },
  ])('rejects an empty configured path instead of falling through', (options) => {
    expect(() => resolvePluginsDirectory(options)).toThrow();
  });
});
