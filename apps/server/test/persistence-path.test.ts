import { describe, expect, it } from 'vitest';
import { resolveDatabaseFile, resolveDefaultDataDirectory } from '../src/persistence-path.js';

describe('resolveDefaultDataDirectory', () => {
  it('resolves the macOS application data directory', () => {
    expect(resolveDefaultDataDirectory({ HOME: '/Users/tester' }, 'darwin', '/Users/tester')).toBe(
      '/Users/tester/Library/Application Support/Weave',
    );
  });

  it('resolves the Windows application data directory from APPDATA', () => {
    expect(
      resolveDefaultDataDirectory({ APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }, 'win32'),
    ).toBe('C:\\Users\\tester\\AppData\\Roaming\\Weave');
  });

  it('resolves the Linux application data directory from XDG_DATA_HOME', () => {
    expect(
      resolveDefaultDataDirectory(
        { XDG_DATA_HOME: '/tmp/data', HOME: '/home/tester' },
        'linux',
        '/home/tester',
      ),
    ).toBe('/tmp/data/weave');
  });

  it('falls back to the platform default when no environment data directory exists', () => {
    expect(resolveDefaultDataDirectory({}, 'linux', '/home/tester')).toBe(
      '/home/tester/.local/share/weave',
    );
  });

  it('throws a stable error when the home directory is missing', () => {
    expect(() => resolveDefaultDataDirectory({}, 'darwin')).toThrow(
      'Unable to resolve Weave data directory: home directory is required',
    );
  });
});

describe('resolveDatabaseFile', () => {
  it('prefers an explicit database file over all environment settings', () => {
    expect(
      resolveDatabaseFile({
        databaseFile: '/tmp/custom.sqlite',
        dataDirectory: '/tmp/ignored',
        environment: {
          WEAVE_DATABASE_FILE: '/tmp/env.sqlite',
          WEAVE_DATA_DIR: '/tmp/env-data',
        },
        platform: 'darwin',
        homeDirectory: '/Users/tester',
      }),
    ).toBe('/tmp/custom.sqlite');
  });

  it('prefers WEAVE_DATABASE_FILE over WEAVE_DATA_DIR', () => {
    expect(
      resolveDatabaseFile({
        environment: {
          WEAVE_DATABASE_FILE: '/tmp/env.sqlite',
          WEAVE_DATA_DIR: '/tmp/env-data',
        },
        platform: 'darwin',
        homeDirectory: '/Users/tester',
      }),
    ).toBe('/tmp/env.sqlite');
  });

  it('prefers an explicit data directory over environment database settings', () => {
    expect(
      resolveDatabaseFile({
        dataDirectory: '/tmp/explicit-data',
        environment: {
          WEAVE_DATABASE_FILE: '/tmp/env.sqlite',
          WEAVE_DATA_DIR: '/tmp/env-data',
        },
        platform: 'darwin',
        homeDirectory: '/Users/tester',
      }),
    ).toBe('/tmp/explicit-data/weave.sqlite');
  });

  it('uses WEAVE_DATA_DIR before the operating system default', () => {
    expect(
      resolveDatabaseFile({
        environment: {
          WEAVE_DATA_DIR: '/tmp/env-data',
        },
        platform: 'darwin',
        homeDirectory: '/Users/tester',
      }),
    ).toBe('/tmp/env-data/weave.sqlite');
  });

  it('uses Windows path separators for Windows data directories', () => {
    expect(
      resolveDatabaseFile({
        dataDirectory: 'C:\\Users\\tester\\Weave',
        platform: 'win32',
        homeDirectory: 'C:\\Users\\tester',
      }),
    ).toBe('C:\\Users\\tester\\Weave\\weave.sqlite');
  });
});
