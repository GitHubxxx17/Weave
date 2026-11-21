import { describe, expect, it } from 'vitest';

import { createMcpReview, diffMcpConfig } from '../src/features/mcp/mcp-review.js';

function config() {
  return {
    schemaVersion: 1 as const,
    id: 'example',
    label: 'Example',
    transport: 'stdio' as const,
    command: '/usr/local/bin/node',
    args: ['', ' two spaces ', 'a\\b'],
    cwd: '/workspace',
    env: Object.fromEntries([
      ['TOKEN', { fromHostEnv: 'HOST_TOKEN' }],
      ['__proto__', { fromHostEnv: 'HOST_SPECIAL' }],
    ]),
  };
}

describe('MCP review snapshots', () => {
  it('captures a deeply frozen canonical configuration and history before later edits', () => {
    const current = config();
    const previous = { ...config(), command: '/previous/node' };
    const record = {
      config: current,
      configDigest: 'a'.repeat(64),
      reviewedConfig: previous,
      enabled: false,
      state: 'changed' as const,
      stale: false,
      drainingGenerations: [],
      tools: [],
    };
    const review = createMcpReview(record, 17, 8);

    current.args[0] = 'changed';
    current.env['TOKEN']!.fromHostEnv = 'REPLACED';
    current.label = 'Later title';
    previous.args.push('new');
    record.configDigest = 'b'.repeat(64);

    expect(review.authoritySequence).toBe(17);
    expect(review.reviewEpoch).toBe(8);
    expect(review.configDigest).toBe('a'.repeat(64));
    expect(review.config.label).toBe('Example');
    expect(review.config.args).toEqual(['', ' two spaces ', 'a\\b']);
    expect(review.config.env).toEqual({
      TOKEN: { fromHostEnv: 'HOST_TOKEN' },
      ['__proto__']: { fromHostEnv: 'HOST_SPECIAL' },
    });
    expect(Object.hasOwn(review.config.env, '__proto__')).toBe(true);
    expect(review.reviewedConfig?.args).toHaveLength(3);
    for (const value of [
      review,
      review.config,
      review.config.args,
      review.config.env,
      review.config.env['TOKEN'],
      review.reviewedConfig,
      review.reviewedConfig?.args,
      review.reviewedConfig?.env,
      review.reviewedConfig?.env['__proto__'],
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it('does not manufacture previously reviewed configuration', () => {
    const review = createMcpReview(
      {
        config: config(),
        configDigest: 'c'.repeat(64),
        enabled: false,
        state: 'untrusted',
        stale: false,
        drainingGenerations: [],
        tools: [],
      },
      1,
      0,
    );
    expect(Object.hasOwn(review, 'reviewedConfig')).toBe(false);
  });
});

describe('MCP configuration review differences', () => {
  it('compares env as an own-key mapping while retaining ordered literal argv', () => {
    const before = config();
    const after = {
      ...config(),
      env: Object.fromEntries(Object.entries(before.env).reverse()),
    };
    expect(diffMcpConfig(before, after)).toEqual([]);
    after.args = [' two spaces ', '', 'a\\b'];
    expect(diffMcpConfig(before, after)).toEqual([
      { field: 'args', before: JSON.stringify(before.args), after: JSON.stringify(after.args) },
    ]);
  });

  it('shows each changed field with exact text and safe special environment keys', () => {
    const before = config();
    const after = {
      ...config(),
      label: '<script>name</script>',
      command: '/other/node',
      cwd: '/other/workspace',
      env: Object.fromEntries([['__proto__', { fromHostEnv: 'NEW_HOST_REFERENCE' }]]),
    };
    const differences = diffMcpConfig(before, after);
    expect(differences.map((change) => change.field)).toEqual(['label', 'command', 'cwd', 'env']);
    expect(differences[0]).toEqual({
      field: 'label',
      before: 'Example',
      after: '<script>name</script>',
    });
    expect(JSON.parse(differences.at(-1)!.before)).toEqual({
      TOKEN: { fromHostEnv: 'HOST_TOKEN' },
      ['__proto__']: { fromHostEnv: 'HOST_SPECIAL' },
    });
    expect(JSON.parse(differences.at(-1)!.after)).toEqual({
      ['__proto__']: { fromHostEnv: 'NEW_HOST_REFERENCE' },
    });
  });
});
