import { describe, expect, it } from 'vitest';
import { pluginApiVersion } from '../src/index.js';

describe('@weave/plugin package', () => {
  it('exports the current Plugin API version', () => {
    expect(pluginApiVersion).toBe('1.0.0');
  });
});
