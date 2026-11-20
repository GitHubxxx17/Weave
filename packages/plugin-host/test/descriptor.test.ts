import { describe, expect, it } from 'vitest';

import { descriptorFileName, parseDescriptor } from '../src/descriptor.js';
import { PluginHostError } from '../src/errors.js';
import { manifestFor } from './support/fixtures.js';

function descriptorText(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    entry: 'index.js',
    manifest: manifestFor('hello-commands'),
    ...over,
  });
}

function rejection(text: string): PluginHostError {
  try {
    parseDescriptor(text);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(PluginHostError);
    return error as PluginHostError;
  }
  throw new Error('Expected parseDescriptor to throw');
}

describe('descriptorFileName', () => {
  it('is weave-plugin.json', () => {
    expect(descriptorFileName).toBe('weave-plugin.json');
  });
});

describe('parseDescriptor', () => {
  it('returns the entry and the manifest of a complete descriptor', () => {
    const descriptor = parseDescriptor(descriptorText());

    expect(descriptor).toEqual({
      schemaVersion: 1,
      entry: 'index.js',
      manifest: manifestFor('hello-commands'),
    });
  });

  it('reads a file that begins with a byte order mark', () => {
    expect(parseDescriptor(`\uFEFF${descriptorText()}`).manifest.id).toBe('hello-commands');
  });

  it.each([
    ['a leading ./', './dist/index.mjs', 'dist/index.mjs'],
    ['a . segment', 'dist/./index.js', 'dist/index.js'],
    ['a nested path', 'dist/bundle/index.js', 'dist/bundle/index.js'],
    ['the .mjs extension', 'index.mjs', 'index.mjs'],
  ])('normalises the entry with %s', (_label, entry, expected) => {
    expect(parseDescriptor(descriptorText({ entry })).entry).toBe(expected);
  });

  it.each([
    ['an absolute path', '/etc/passwd.js', 'must be relative to the plugin directory'],
    ['a Windows drive path', 'C:/plugin/index.js', 'must be relative to the plugin directory'],
    ['a parent segment', '../outside/index.js', 'must not contain ".."'],
    ['a parent segment in the middle', 'dist/../../index.js', 'must not contain ".."'],
    ['a backslash', 'dist\\index.js', 'must use "/" as the path separator'],
    ['a NUL character', 'index\0.js', 'must not contain a NUL character'],
    ['an empty segment', 'dist//index.js', 'must not contain an empty path segment'],
    ['a trailing slash', 'dist/', 'must not contain an empty path segment'],
    ['a TypeScript file', 'index.ts', 'must name a .js or .mjs file'],
    ['a directory', 'dist', 'must name a .js or .mjs file'],
    ['only an extension', '.js', 'must name a .js or .mjs file'],
  ])('rejects an entry with %s', (_label, entry, reason) => {
    const error = rejection(descriptorText({ entry }));

    expect(error.code).toBe('plugin-invalid-descriptor');
    expect(error.message).toContain(`entry ${reason}`);
  });

  it('rejects text that is not JSON', () => {
    const error = rejection('{ not json');

    expect(error.code).toBe('plugin-invalid-descriptor');
    expect(error.message).toContain('weave-plugin.json is not valid JSON');
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a missing schemaVersion', JSON.stringify({ entry: 'index.js', manifest: manifestFor('a') })],
    ['an unknown schemaVersion', descriptorText({ schemaVersion: 2 })],
    ['a missing entry', JSON.stringify({ schemaVersion: 1, manifest: manifestFor('a') })],
    ['a missing manifest', JSON.stringify({ schemaVersion: 1, entry: 'index.js' })],
    ['an unknown field', descriptorText({ scripts: { postinstall: 'curl evil.example' } })],
  ])('rejects %s', (_label, text) => {
    expect(rejection(text).code).toBe('plugin-invalid-descriptor');
  });

  it('names the field of the manifest that is wrong', () => {
    const error = rejection(
      descriptorText({ manifest: manifestFor('hello-commands', { id: 'Not Valid' }) }),
    );

    expect(error.code).toBe('plugin-invalid-descriptor');
    expect(error.message).toContain('manifest.id');
  });

  it('applies the kernel manifest rules, such as a capability for each contributed kind', () => {
    const error = rejection(
      descriptorText({
        manifest: manifestFor('hello-commands', { capabilities: ['tool'] }),
      }),
    );

    expect(error.message).toContain('contributes.commands requires the "command" capability');
  });

  it.each(['contributes', 'permissions'])(
    'requires %s, so the user is shown what the plugin asks for',
    (key) => {
      const manifest = manifestFor('hello-commands');
      delete manifest[key];

      const error = rejection(descriptorText({ manifest }));

      expect(error.code).toBe('plugin-invalid-descriptor');
      expect(error.pluginId).toBe('hello-commands');
      expect(error.message).toContain(`must declare ${key} in its manifest`);
    },
  );

  it('names both when both are missing', () => {
    const manifest = manifestFor('hello-commands');
    delete manifest.contributes;
    delete manifest.permissions;

    expect(rejection(descriptorText({ manifest })).message).toContain(
      'must declare contributes and permissions',
    );
  });

  it('accepts empty declarations, which say the plugin adds and asks for nothing', () => {
    const descriptor = parseDescriptor(
      descriptorText({
        manifest: manifestFor('quiet', {
          capabilities: ['tool'],
          contributes: {},
          permissions: [],
        }),
      }),
    );

    expect(descriptor.manifest.contributes).toEqual({});
    expect(descriptor.manifest.permissions).toEqual([]);
  });

  it('accepts a plugin that runs another way, since compatibility is judged elsewhere', () => {
    const descriptor = parseDescriptor(
      descriptorText({ manifest: manifestFor('remote', { host: 'mcp' }) }),
    );

    expect(descriptor.manifest.host).toBe('mcp');
  });
});
