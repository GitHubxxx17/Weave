import { describe, expect, it } from 'vitest';

import { createDesktopConfig } from '../src/desktop-config.js';

describe('createDesktopConfig', () => {
  it('uses the Electron user data directory for SQLite and the configured Studio URL', () => {
    const config = createDesktopConfig({
      userDataDirectory: '/Users/tester/Library/Application Support/Weave',
      environment: {
        WEAVE_STUDIO_URL: 'http://127.0.0.1:5173',
      },
    });

    expect(config.databaseFile).toBe(
      '/Users/tester/Library/Application Support/Weave/weave.sqlite',
    );
    expect(config.studioUrl).toBe('http://127.0.0.1:5173');
    expect(config.studioOrigin).toBe('http://127.0.0.1:5173');
  });

  it('leaves the Studio URL unset by default so the embedded Server hosts Studio', () => {
    const config = createDesktopConfig({
      userDataDirectory: '/tmp/weave-user-data',
      studioDirectory: '/app/studio/dist',
      environment: {},
    });

    expect(config.studioUrl).toBeUndefined();
    expect(config.studioOrigin).toBeUndefined();
    expect(config.studioDirectory).toBe('/app/studio/dist');
    expect(config.host).toBeUndefined();
  });

  it.each([
    { argv: ['dist/main.js', '--host', '0.0.0.0'], environment: {}, host: '0.0.0.0' },
    { argv: ['--host=10.0.0.5'], environment: { WEAVE_HOST: '0.0.0.0' }, host: '10.0.0.5' },
    { argv: [], environment: { WEAVE_HOST: ' 192.168.1.20 ' }, host: '192.168.1.20' },
    { argv: [], environment: { WEAVE_HOST: '' }, host: undefined },
  ])('reads the listen host from $argv and $environment', ({ argv, environment, host }) => {
    const config = createDesktopConfig({ userDataDirectory: '/tmp/d', argv, environment });
    expect(config.host).toBe(host);
  });

  it('rejects a missing or malformed --host', () => {
    expect(() => createDesktopConfig({ userDataDirectory: '/tmp/d', argv: ['--host'] })).toThrow(
      '--host',
    );
    expect(() =>
      createDesktopConfig({ userDataDirectory: '/tmp/d', argv: ['--host=a b'] }),
    ).toThrow();
  });

  it('allows first binding under the Electron user data directory by default', () => {
    const config = createDesktopConfig({
      userDataDirectory: '/tmp/weave-user-data',
      environment: {},
    });

    expect(config.pluginsDirectory).toBe('/tmp/weave-user-data/plugins');
    expect(config.allowInitialManagedPluginBinding).toBe(true);
  });

  it.each(['/tmp/custom-plugins', './custom/../plugins', ''])(
    'preserves the directory override %j and disables first binding',
    (override) => {
      const config = createDesktopConfig({
        userDataDirectory: '/tmp/weave-user-data',
        environment: { WEAVE_PLUGINS_DIR: override },
      });

      expect(config.pluginsDirectory).toBe(override);
      expect(config.allowInitialManagedPluginBinding).toBe(false);
    },
  );

  it('keeps the database file inside the resolved user data directory', () => {
    const config = createDesktopConfig({
      userDataDirectory: 'relative/weave-user-data',
      environment: {},
    });

    expect(config.databaseFile).toMatch(/^\/.*\/relative\/weave-user-data\/weave\.sqlite$/);
    expect(config.databaseFile.startsWith(config.userDataDirectory)).toBe(true);
  });

  it('rejects an invalid or non-loopback Studio URL', () => {
    expect(() =>
      createDesktopConfig({
        userDataDirectory: '/tmp/weave-user-data',
        environment: {
          WEAVE_STUDIO_URL: 'not-a-url',
        },
      }),
    ).toThrow();

    expect(() =>
      createDesktopConfig({
        userDataDirectory: '/tmp/weave-user-data',
        environment: {
          WEAVE_STUDIO_URL: 'https://studio.example.com',
        },
      }),
    ).toThrow(/loopback/);
  });

  it('rejects an empty user data directory', () => {
    expect(() =>
      createDesktopConfig({
        userDataDirectory: '',
        environment: {},
      }),
    ).toThrow();
  });
});
