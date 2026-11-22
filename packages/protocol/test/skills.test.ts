import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';

const ref = {
  id: 'builtin:weave-planning',
  instructionSha256: 'a'.repeat(64),
  bundleSha256: 'b'.repeat(64),
};

describe('Skill wire boundaries', () => {
  it('validates exact source and content identity and rejects duplicate selections', () => {
    expect(protocol).toHaveProperty('skillRefSchema');
    expect(protocol.skillRefSchema.parse(ref)).toEqual(ref);
    expect(protocol.skillRefSchema.safeParse({ ...ref, bundleSha256: 'latest' }).success).toBe(
      false,
    );
    expect(protocol.skillRefSchema.safeParse({ ...ref, id: '/private/a/skill' }).success).toBe(
      false,
    );
    expect(protocol.skillRefSchema.safeParse({ ...ref, instructions: 'injected' }).success).toBe(
      false,
    );
    expect(protocol.skillRefsSchema.safeParse([ref, ref]).success).toBe(false);
    expect(
      protocol.skillRefsSchema.safeParse(
        Array.from({ length: 33 }, (_, i) => ({
          ...ref,
          id: `builtin:skill-${i}`,
        })),
      ).success,
    ).toBe(false);
  });

  it('requires real plugin attribution and bounded metadata', () => {
    const summary = {
      ...ref,
      name: 'weave-planning',
      description: 'Plan the current task.',
      source: { kind: 'builtin', label: 'Weave' },
      invocation: { user: true, model: true },
    };
    expect(protocol.skillSummarySchema.parse(summary)).toEqual(summary);
    expect(
      protocol.skillSummarySchema.safeParse({
        ...summary,
        source: { kind: 'plugin', label: 'A plugin' },
      }).success,
    ).toBe(false);
    expect(
      protocol.skillSummarySchema.safeParse({
        ...summary,
        source: { kind: 'project', label: 'Project', pluginId: 'fake' },
      }).success,
    ).toBe(false);
    expect(
      protocol.skillSummarySchema.safeParse({ ...summary, description: 'x'.repeat(1025) }).success,
    ).toBe(false);
  });

  it('distinguishes incomplete discovery from complete absence and verifies page continuation', () => {
    const catalog = {
      schemaVersion: 1,
      generation: 1,
      fingerprint: 'c'.repeat(64),
      entries: [],
      complete: false,
      truncated: false,
      issues: [{ source: 'Project', code: 'unreadable' }],
    };
    expect(protocol.skillCatalogSchema.parse(catalog)).toEqual(catalog);
    const page = {
      skill: ref,
      kind: 'instructions',
      contentSha256: ref.instructionSha256,
      text: 'first',
      offset: 0,
      eof: false,
      nextCursor: 'opaque',
    };
    expect(protocol.skillPageSchema.parse(page)).toEqual(page);
    expect(protocol.skillPageSchema.safeParse({ ...page, nextCursor: undefined }).success).toBe(
      false,
    );
    expect(protocol.skillPageSchema.safeParse({ ...page, eof: true }).success).toBe(false);
    expect(
      protocol.skillPageSchema.safeParse({ ...page, kind: 'resource', path: '../secret' }).success,
    ).toBe(false);
  });
});
