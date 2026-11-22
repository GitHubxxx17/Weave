import { describe, expect, it } from 'vitest';
import {
  attributedPanelSchema,
  cloneDeclarativePanel,
  declarativePanelSchema,
  panelLimits,
} from '../src/index.js';

const staticPanel = {
  schemaVersion: 1,
  id: 'report',
  title: 'Quality',
  icon: 'checklist',
  placement: 'right',
  sources: [],
  blocks: [{ id: 'summary', type: 'text', value: { literal: 'Ready' } }],
} as const;
const binding = () => ({ source: 'report', path: ['summary'] });
function fullPanel() {
  return {
    ...structuredClone(staticPanel),
    description: 'Current report',
    sources: [{ id: 'report', eventType: 'quality-report/report', payloadVersion: 1 }],
    blocks: [
      { id: 'heading', type: 'heading', text: ' Report ' },
      { id: 'summary', type: 'text', value: { binding: binding() } },
      { id: 'status', type: 'status', label: 'Status', value: { literal: true } },
      { id: 'metric', type: 'metric', label: 'Score', unit: '%', value: { literal: 80 } },
      { id: 'details', type: 'key-value', rows: [{ label: 'Summary', value: { literal: null } }] },
      {
        id: 'checks',
        type: 'table',
        rows: { source: 'report', path: ['checks'] },
        columns: [{ id: 'name', title: 'Name', path: ['name'] }],
      },
      {
        id: 'review',
        type: 'form',
        fields: [
          { id: 'target', type: 'text', label: 'Target', required: true, default: 'src' },
          { id: 'tests', type: 'boolean', label: 'Tests', default: true },
          {
            id: 'mode',
            type: 'select',
            label: 'Mode',
            required: false,
            options: [{ value: 'quick', label: 'Quick' }],
            default: 'quick',
          },
        ],
        submit: { type: 'prepare-command', command: 'quality-report', label: 'Prepare' },
      },
    ],
  };
}
function errorFor(input: unknown): unknown {
  try {
    cloneDeclarativePanel(input);
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}
function nodes(value: unknown): number {
  if (value === null || typeof value !== 'object') return 1;
  return 1 + Object.entries(value).reduce((sum, [, child]) => sum + 1 + nodes(child), 0);
}
function panelAtBytes(bytes: number, character: string) {
  const panel = {
    ...structuredClone(staticPanel),
    blocks: [] as { id: string; type: 'text'; value: { literal: string } }[],
  };
  for (let index = 0; index < 32; index += 1)
    panel.blocks.push({ id: `b-${index}`, type: 'text', value: { literal: '' } });
  let remaining = bytes - new TextEncoder().encode(JSON.stringify(panel)).byteLength;
  const cost = new TextEncoder().encode(JSON.stringify(character)).byteLength - 2;
  for (const block of panel.blocks) {
    const count = Math.min(4096, Math.floor(remaining / cost));
    block.value.literal = character.repeat(count);
    remaining -= count * cost;
  }
  if (remaining > 0) {
    const block = panel.blocks.find(
      (candidate) => candidate.value.literal.length + remaining <= 4096,
    )!;
    block.value.literal += 'a'.repeat(remaining);
  }
  expect(new TextEncoder().encode(JSON.stringify(panel)).byteLength).toBe(bytes);
  return panel;
}

describe('declarative panel schema and detached clone', () => {
  it('publishes exact immutable work limits', () => {
    expect(panelLimits).toEqual({
      definitionBytes: 65536,
      sources: 8,
      blocks: 32,
      depth: 16,
      nodes: 4096,
    });
    expect(Object.isFrozen(panelLimits)).toBe(true);
  });
  it('accepts all seven block kinds and three literal-default field kinds without trimming', () => {
    const panel = fullPanel();
    expect(cloneDeclarativePanel(panel)).toEqual(panel);
    expect(declarativePanelSchema.parse(panel)).toEqual(panel);
  });
  it('detaches and recursively freezes accepted host JSON without freezing author values', () => {
    const input = structuredClone(staticPanel);
    const result = cloneDeclarativePanel(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result.blocks).not.toBe(input.blocks);
    expect(Object.isFrozen(result.blocks[0])).toBe(true);
    expect(Object.isFrozen(result.blocks[0]?.type === 'text' && result.blocks[0].value)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
  });
  it('rejects an ordinary accessor before getter execution', () => {
    let calls = 0;
    const input = { ...staticPanel };
    Object.defineProperty(input, 'title', {
      enumerable: true,
      get() {
        calls += 1;
        return 'unsafe';
      },
    });
    expect(() => cloneDeclarativePanel(input)).toThrow();
    expect(calls).toBe(0);
  });
  it('rejects nested accessors, hidden indices and toJSON without invoking author code', () => {
    let calls = 0;
    const value = Object.defineProperty({}, 'literal', {
      enumerable: true,
      get() {
        calls += 1;
        return 'unsafe';
      },
    });
    const blocks = [{ id: 'x', type: 'text', value }];
    const hidden = Object.defineProperty([{ ...staticPanel.blocks[0] }], '0', {
      enumerable: false,
    });
    const setter = Object.defineProperty({ ...staticPanel }, 'title', {
      enumerable: true,
      set(value: unknown) {
        void value;
        calls += 1;
      },
    });
    const serializer = {
      ...staticPanel,
      toJSON() {
        calls += 1;
        return staticPanel;
      },
    };
    for (const input of [
      { ...staticPanel, blocks },
      { ...staticPanel, blocks: hidden },
      setter,
      serializer,
    ])
      expect(() => cloneDeclarativePanel(input)).toThrow();
    expect(calls).toBe(0);
  });
  it('accepts null-prototype records and safely copies own property data', () => {
    const input: unknown = Object.assign(
      Object.create(null) as object,
      structuredClone(staticPanel),
    );
    expect(cloneDeclarativePanel(input)).toEqual(staticPanel);
  });
  it('turns a throwing Proxy reflection trap into a controlled error', () => {
    const input = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('author trap');
        },
      },
    );
    expect(errorFor(input)).toBeInstanceOf(TypeError);
    expect(errorFor(input)).toMatchObject({ message: 'Invalid panel JSON' });
  });
  it.each([
    ['undefined optional', { ...staticPanel, description: undefined }],
    ['unknown root', { ...staticPanel, url: 'https://example.com' }],
    ['spoofed owner', { ...staticPanel, pluginId: 'other' }],
    ['empty blocks', { ...staticPanel, blocks: [] }],
    ['blank title', { ...staticPanel, title: '  ' }],
    ['long title', { ...staticPanel, title: 'a'.repeat(81) }],
    ['invalid icon', { ...staticPanel, icon: 'image' }],
    ['invalid placement', { ...staticPanel, placement: 'left' }],
    ['invalid id', { ...staticPanel, id: 'Bad' }],
    ['long id', { ...staticPanel, id: 'a'.repeat(65) }],
    ['undefined', undefined],
    ['function', () => undefined],
    ['symbol', Symbol('x')],
    ['bigint', 1n],
    ['nonfinite', { ...staticPanel, title: Number.NaN }],
    ['custom prototype', Object.assign(Object.create({ custom: true }) as object, staticPanel)],
  ])('rejects %s', (_label, input) => {
    expect(() => cloneDeclarativePanel(input)).toThrow();
  });
  it.each(['__proto__', 'prototype', 'constructor', '', '.', '..', '123'])(
    'rejects forbidden path %j',
    (part) => {
      const panel = {
        ...staticPanel,
        sources: [{ id: 'report', eventType: 'quality/report', payloadVersion: 1 }],
        blocks: [{ id: 'x', type: 'text', value: { binding: { source: 'report', path: [part] } } }],
      };
      expect(() => cloneDeclarativePanel(panel)).toThrow();
    },
  );
  it.each([
    [
      'undeclared source',
      (panel: ReturnType<typeof fullPanel>) => {
        panel.sources = [];
      },
    ],
    [
      'duplicate source',
      (panel: ReturnType<typeof fullPanel>) => {
        panel.sources.push({ ...panel.sources[0]! });
      },
    ],
    [
      'invalid source version',
      (panel: ReturnType<typeof fullPanel>) => {
        panel.sources[0]!.payloadVersion = 0;
      },
    ],
    [
      'unsafe source version',
      (panel: ReturnType<typeof fullPanel>) => {
        panel.sources[0]!.payloadVersion = 2 ** 53;
      },
    ],
    [
      'duplicate block',
      (panel: ReturnType<typeof fullPanel>) => {
        panel.blocks.push(structuredClone(panel.blocks[0]!));
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const panel = fullPanel();
    mutate(panel);
    expect(() => cloneDeclarativePanel(panel)).toThrow();
  });
  it('rejects duplicate field IDs across forms, columns and select choices/defaults', () => {
    const panel = fullPanel();
    const form = structuredClone(panel.blocks[6]!);
    panel.blocks.push({ ...form, id: 'again' });
    expect(() => cloneDeclarativePanel(panel)).toThrow();
    const table = {
      id: 'x',
      type: 'table',
      rows: binding(),
      columns: [
        { id: 'x', title: 'X', path: ['x'] },
        { id: 'x', title: 'Y', path: ['y'] },
      ],
    };
    expect(() =>
      cloneDeclarativePanel({ ...staticPanel, sources: fullPanel().sources, blocks: [table] }),
    ).toThrow();
    const select = {
      id: 'x',
      type: 'select',
      label: 'X',
      required: false,
      options: [{ value: 'a', label: 'A' }],
      default: 'missing',
    };
    const block = {
      id: 'f',
      type: 'form',
      fields: [select],
      submit: { type: 'prepare-command', command: 'go', label: 'Go' },
    };
    expect(() => cloneDeclarativePanel({ ...staticPanel, blocks: [block] })).toThrow();
    select.default = 'a';
    select.options.push({ value: 'a', label: 'Again' });
    expect(() => cloneDeclarativePanel({ ...staticPanel, blocks: [block] })).toThrow();
  });
  it.each(['text', 'status', 'metric'])(
    'rejects unknown keys and nonfinite %s literals',
    (type) => {
      expect(() =>
        cloneDeclarativePanel({
          ...staticPanel,
          blocks: [
            {
              id: 'x',
              type,
              ...(type === 'text' ? {} : { label: 'X' }),
              value: { literal: Infinity },
            },
          ],
        }),
      ).toThrow();
    },
  );
  it('allows metric null/finite literals but rejects other metric scalar kinds', () => {
    for (const literal of [null, 3])
      expect(() =>
        cloneDeclarativePanel({
          ...staticPanel,
          blocks: [{ id: 'x', type: 'metric', label: 'X', value: { literal } }],
        }),
      ).not.toThrow();
    for (const literal of ['', true])
      expect(() =>
        cloneDeclarativePanel({
          ...staticPanel,
          blocks: [{ id: 'x', type: 'metric', label: 'X', value: { literal } }],
        }),
      ).toThrow();
  });
  it('rejects aliases and cycles', () => {
    const shared = { literal: 'x' };
    expect(() =>
      cloneDeclarativePanel({
        ...staticPanel,
        blocks: [
          { id: 'a', type: 'text', value: shared },
          { id: 'b', type: 'text', value: shared },
        ],
      }),
    ).toThrow();
    const input: Record<string, unknown> = { ...staticPanel };
    input['cycle'] = input;
    expect(() => cloneDeclarativePanel(input)).toThrow();
  });
  it('rejects sparse arrays, extra array properties, symbol keys and hidden records', () => {
    const sparse = new Array(1);
    const extra = Object.assign([], { extra: 1 });
    const hidden = Object.defineProperty({ ...staticPanel }, 'hidden', { value: 1 });
    for (const input of [
      { ...staticPanel, sources: sparse },
      { ...staticPanel, sources: extra },
      { ...staticPanel, [Symbol('x')]: 1 },
      hidden,
    ])
      expect(() => cloneDeclarativePanel(input)).toThrow();
  });
  it('bounds depth before schema parsing, with root depth zero', () => {
    const atDepth = (depth: number) => {
      let child: unknown = 'x';
      for (let index = 1; index < depth; index += 1) child = { x: child };
      return { ...staticPanel, extra: child };
    };
    expect(errorFor(atDepth(16))).not.toMatchObject({
      message: 'Panel JSON exceeds its depth limit',
    });
    expect(errorFor(atDepth(17))).toMatchObject({ message: 'Panel JSON exceeds its depth limit' });
  });
  it('counts property keys, array index keys and all values toward the node limit', () => {
    // Complete JSON trees have an odd node count. A final key is node4096;
    // its data value would be node4097, while an accessor must reject before it.
    const panel: Record<string, unknown> = {};
    for (let index = 0; index < 2047; index += 1) panel[`k${index}`] = null;
    expect(nodes(panel)).toBe(4095);
    Object.defineProperty(panel, 'last', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('getter');
      },
    });
    expect(errorFor(panel)).toMatchObject({ message: 'Invalid panel JSON' });
    Object.defineProperty(panel, 'last', { enumerable: true, value: null });
    expect(nodes(panel)).toBe(4097);
    expect(errorFor(panel)).toMatchObject({ message: 'Panel JSON exceeds its node limit' });
  });
  it.each(['\0', '中'])(
    'measures exact serialized UTF-8 including escaping for %j',
    (character) => {
      expect(() => cloneDeclarativePanel(panelAtBytes(65536, character))).not.toThrow();
      expect(() => cloneDeclarativePanel(panelAtBytes(65537, character))).toThrow(
        'Panel definition exceeds its byte limit',
      );
    },
  );
  it('caps keys and prevalidation strings before escaping', () => {
    expect(() => cloneDeclarativePanel({ ...staticPanel, ['x'.repeat(129)]: 1 })).toThrow();
    expect(() => cloneDeclarativePanel({ ...staticPanel, title: '\0'.repeat(4097) })).toThrow();
  });
  it('enforces exact per-panel collection limits', () => {
    const sources = Array.from({ length: 8 }, (_, index) => ({
      id: `s-${index}`,
      eventType: `quality/s-${index}`,
      payloadVersion: 1,
    }));
    const blocks = Array.from({ length: 32 }, (_, index) => ({
      id: `b-${index}`,
      type: 'heading',
      text: 'X',
    }));
    expect(() => cloneDeclarativePanel({ ...staticPanel, sources, blocks })).not.toThrow();
    expect(() =>
      cloneDeclarativePanel({
        ...staticPanel,
        sources: [...sources, { id: 's-8', eventType: 'quality/s-8', payloadVersion: 1 }],
      }),
    ).toThrow();
    expect(() =>
      cloneDeclarativePanel({
        ...staticPanel,
        blocks: [...blocks, { id: 'b-32', type: 'heading', text: 'X' }],
      }),
    ).toThrow();
  });
  it('enforces table/path lengths and key-value row limits', () => {
    const sources = fullPanel().sources;
    const columns = Array.from({ length: 10 }, (_, index) => ({
      id: `c-${index}`,
      title: 'X',
      path: Array.from({ length: 8 }, () => 'x'.repeat(64)),
    }));
    const table = { id: 'table', type: 'table', rows: binding(), columns };
    expect(() => cloneDeclarativePanel({ ...staticPanel, sources, blocks: [table] })).not.toThrow();
    expect(() =>
      cloneDeclarativePanel({
        ...staticPanel,
        sources,
        blocks: [{ ...table, columns: [...columns, { id: 'c-10', title: 'X', path: ['x'] }] }],
      }),
    ).toThrow();
    for (const path of [[], [...columns[0]!.path, 'x'], ['x'.repeat(65)]])
      expect(() =>
        cloneDeclarativePanel({
          ...staticPanel,
          sources,
          blocks: [{ ...table, rows: { ...binding(), path } }],
        }),
      ).toThrow();
    const rows = Array.from({ length: 32 }, () => ({ label: 'X', value: { literal: '' } }));
    expect(() =>
      cloneDeclarativePanel({ ...staticPanel, blocks: [{ id: 'kv', type: 'key-value', rows }] }),
    ).not.toThrow();
    expect(() =>
      cloneDeclarativePanel({
        ...staticPanel,
        blocks: [
          { id: 'kv', type: 'key-value', rows: [...rows, { label: 'X', value: { literal: '' } }] },
        ],
      }),
    ).toThrow();
  });
  it('enforces form/option limits and rejects unknown nested keys or explicit undefined defaults', () => {
    const submit = { type: 'prepare-command', command: 'go', label: 'Go' };
    const fields = Array.from({ length: 32 }, (_, index) => ({
      id: `f-${index}`,
      type: 'text',
      label: 'X',
      required: false,
      default: 'a'.repeat(2048),
    }));
    // Check field count with short defaults to stay within the independent byte cap.
    const shortFields = fields.map((field) => ({ ...field, default: '' }));
    expect(() =>
      cloneDeclarativePanel({
        ...staticPanel,
        blocks: [{ id: 'form', type: 'form', fields: shortFields, submit }],
      }),
    ).not.toThrow();
    expect(() =>
      cloneDeclarativePanel({
        ...staticPanel,
        blocks: [
          {
            id: 'form',
            type: 'form',
            fields: [...shortFields, { ...shortFields[0], id: 'f-32' }],
            submit,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      cloneDeclarativePanel({
        ...staticPanel,
        blocks: [
          { id: 'one', type: 'form', fields: shortFields.slice(0, 17), submit },
          {
            id: 'two',
            type: 'form',
            fields: [...shortFields.slice(17), { ...shortFields[0], id: 'f-32' }],
            submit: { ...submit },
          },
        ],
      }),
    ).toThrow();
    const options = Array.from({ length: 32 }, (_, index) => ({ value: `v-${index}`, label: 'X' }));
    const select = {
      id: 'mode',
      type: 'select',
      label: 'X',
      required: false,
      options,
      default: 'v-0',
    };
    expect(() =>
      cloneDeclarativePanel({
        ...staticPanel,
        blocks: [{ id: 'form', type: 'form', fields: [select], submit }],
      }),
    ).not.toThrow();
    for (const field of [
      { ...select, options: [...options, { value: 'v-32', label: 'X' }] },
      { ...fields[0], default: 'a'.repeat(2049) },
      { ...fields[0], default: undefined },
      { ...fields[0], onChange: 'unsafe' },
    ])
      expect(() =>
        cloneDeclarativePanel({
          ...staticPanel,
          blocks: [{ id: 'form', type: 'form', fields: [field], submit }],
        }),
      ).toThrow();
    expect(
      declarativePanelSchema.safeParse({ ...staticPanel, description: undefined }).success,
    ).toBe(false);
    expect(
      declarativePanelSchema.safeParse({
        ...staticPanel,
        blocks: [
          { id: 'metric', type: 'metric', label: 'X', value: { literal: 1 }, unit: undefined },
        ],
      }).success,
    ).toBe(false);
  });
  it('enforces bounded source names and labels while retaining empty text literals', () => {
    expect(() =>
      cloneDeclarativePanel({
        ...staticPanel,
        description: 'a'.repeat(300),
        blocks: [
          { id: 'h', type: 'heading', text: 'a'.repeat(120) },
          {
            id: 'm',
            type: 'metric',
            label: 'a'.repeat(120),
            unit: 'a'.repeat(32),
            value: { literal: 1 },
          },
          { id: 'text', type: 'text', value: { literal: '' } },
        ],
      }),
    ).not.toThrow();
    expect(() => cloneDeclarativePanel({ ...staticPanel, description: 'a'.repeat(301) })).toThrow();
    for (const source of [
      { id: 's', eventType: `quality/${'x'.repeat(130)}`, payloadVersion: 1 },
      { id: 's', eventType: 'core.message', payloadVersion: 1 },
    ])
      expect(() => cloneDeclarativePanel({ ...staticPanel, sources: [source] })).toThrow();
    for (const block of [
      { id: 'm', type: 'metric', label: 'X', unit: 'a'.repeat(33), value: { literal: 1 } },
      { id: 'h', type: 'heading', text: 'a'.repeat(121) },
      { id: 'h', type: 'heading', text: '  ' },
    ])
      expect(() => cloneDeclarativePanel({ ...staticPanel, blocks: [block] })).toThrow();
  });
  it('validates host-attributed shape separately while forbidding author attribution', () => {
    expect(attributedPanelSchema.parse({ ...staticPanel, pluginId: 'quality-report' })).toEqual({
      ...staticPanel,
      pluginId: 'quality-report',
    });
    expect(
      attributedPanelSchema.safeParse({ ...staticPanel, pluginId: 'a'.repeat(65) }).success,
    ).toBe(false);
    expect(
      attributedPanelSchema.safeParse({ ...staticPanel, pluginId: 'quality-report', callback() {} })
        .success,
    ).toBe(false);
  });
});
