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

  it('uses the local Studio URL by default', () => {
    const config = createDesktopConfig({
      userDataDirectory: '/tmp/weave-user-data',
      environment: {},
    });

    expect(config.studioUrl).toBe('http://127.0.0.1:5173');
    expect(config.studioOrigin).toBe('http://127.0.0.1:5173');
  });

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
