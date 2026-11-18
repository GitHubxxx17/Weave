// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyWindowChrome,
  getRuntimeServerUrl,
  runtimeApiUrl,
} from '../src/features/runtime/runtime-bridge.js';

afterEach(() => {
  delete window.weaveDesktop;
});

describe('runtime bridge', () => {
  it('uses relative paths in the browser', () => {
    expect(getRuntimeServerUrl()).toBe('');
    expect(runtimeApiUrl('/projects')).toBe('/projects');
  });

  it('uses the desktop Server URL for API paths', () => {
    window.weaveDesktop = {
      isDesktop: true,
      serverUrl: 'http://127.0.0.1:46321',
    };

    expect(getRuntimeServerUrl()).toBe('http://127.0.0.1:46321');
    expect(runtimeApiUrl('/projects')).toBe('http://127.0.0.1:46321/projects');
  });

  it('normalizes duplicate boundary slashes while preserving the query string', () => {
    window.weaveDesktop = {
      isDesktop: true,
      serverUrl: 'http://127.0.0.1:46321///',
    };

    expect(runtimeApiUrl('//projects?includeArchived=true')).toBe(
      'http://127.0.0.1:46321/projects?includeArchived=true',
    );
  });

  it('keeps a relative path valid when the desktop Server URL is empty', () => {
    window.weaveDesktop = {
      isDesktop: true,
      serverUrl: '',
    };

    expect(runtimeApiUrl('//projects?includeArchived=true')).toBe('/projects?includeArchived=true');
  });

  it('marks the document root with the desktop title bar style', () => {
    const root = document.createElement('div');

    applyWindowChrome(root);
    expect(root.dataset.windowChrome).toBeUndefined();

    window.weaveDesktop = {
      isDesktop: true,
      serverUrl: 'http://127.0.0.1:46321',
      windowChrome: 'hidden-inset',
    };
    applyWindowChrome(root);
    expect(root.dataset.windowChrome).toBe('hidden-inset');

    window.weaveDesktop = { isDesktop: true, serverUrl: 'http://127.0.0.1:46321' };
    applyWindowChrome(root);
    expect(root.dataset.windowChrome).toBeUndefined();
  });
});
