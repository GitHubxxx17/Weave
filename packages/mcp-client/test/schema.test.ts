import { describe, expect, it } from 'vitest';
import { McpClientError } from '../src/errors.js';
import { assertJsonValue, compileMcpSchema } from '../src/schema.js';

const jsonLimits = { maxBytes: 100_000, maxDepth: 32, maxNodes: 4096 };

function expectInvalidJson(value: unknown, limits = jsonLimits): void {
  expect(() => assertJsonValue(value, limits)).toThrowError(
    expect.objectContaining({ code: 'mcp-invalid-input' }),
  );
}

function expectUnsupported(schema: Readonly<Record<string, unknown>>): void {
  expect(() => compileMcpSchema(schema)).toThrowError(
    expect.objectContaining({ code: 'mcp-unsupported-schema' }),
  );
}

function nestedData(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index++) value = [value];
  return value;
}

describe('assertJsonValue', () => {
  it('accepts finite JSON values, null-prototype records and shared acyclic values', () => {
    const shared = { x: 1 };
    const record: Record<string, unknown> = Object.create(null);
    record.value = [null, true, false, 0, -1.5, 'hello', shared, shared];
    expect(() => assertJsonValue(record, jsonLimits)).not.toThrow();
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1n,
    Symbol('private-value'),
    () => 'private-value',
    new Date(),
    new Map(),
    new Set(),
    new String('private-value'),
    Object.create({ inherited: 'private-value' }),
    { nested: undefined },
    [undefined],
  ])('rejects values whose JSON serialization changes their meaning: %s', (value) => {
    expectInvalidJson(value);
  });

  it('rejects cycles while permitting repeated references outside the active path', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expectInvalidJson(value);
  });

  it('rejects proxies at every depth before traps can change serialized values', () => {
    const proxy = new Proxy({ x: 1 }, { get: () => 'changed' });
    expectInvalidJson(proxy);
    expectInvalidJson({ nested: proxy });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expectInvalidJson(revocable.proxy);
  });

  it('rejects accessors without invoking them or toJSON', () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('private-value');
      },
    });
    expectInvalidJson(getter);
    expectInvalidJson({ toJSON: () => 'private-value' });
    expect(reads).toBe(0);
  });

  it('rejects sparse and extended arrays and properties omitted by JSON.stringify', () => {
    expectInvalidJson(new Array(2));
    expectInvalidJson(Object.assign([1], { extra: 2 }));
    expectInvalidJson(Object.defineProperty({}, 'hidden', { value: 1 }));
    expectInvalidJson({ [Symbol('hidden')]: 1 });
    expectInvalidJson(Object.defineProperty([1], '0', { get: () => 1 }));
  });

  it('preserves own __proto__ keys without changing the prototype', () => {
    const value: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => assertJsonValue(value, jsonLimits)).not.toThrow();
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('counts root depth as zero and bounds traversal before serializing', () => {
    expect(() => assertJsonValue(nestedData(32), jsonLimits)).not.toThrow();
    expectInvalidJson(nestedData(33));
    expectInvalidJson(new Array(2 ** 32 - 1));
  });

  it('counts JSON values including containers as nodes and repeated values per occurrence', () => {
    const limits = { ...jsonLimits, maxNodes: 4 };
    expect(() => assertJsonValue({ x: [1, null] }, limits)).not.toThrow();
    expectInvalidJson({ x: [1, null, false] }, limits);
    const shared = { x: 1 };
    expectInvalidJson([shared, shared], limits);
  });

  it.each([
    ['"é"', 'é', 4],
    ['"😀"', '😀', 6],
    ['"\\ud800"', '\ud800', 8],
    ['"\\u0000"', '\u0000', 8],
    ['"\\n"', '\n', 4],
    ['{"x":1}', { x: 1 }, 7],
    ['[true,null]', [true, null], 11],
  ])('uses exact serialized UTF-8 bytes for %s', (_serialized, value, byteCount) => {
    const limits = { ...jsonLimits, maxBytes: byteCount as number };
    expect(() => assertJsonValue(value, limits)).not.toThrow();
    expectInvalidJson(value, { ...limits, maxBytes: (byteCount as number) - 1 });
  });

  it('uses a fixed safe error without retaining a thrown trap or input value', () => {
    const value = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('private-value');
        },
      },
    );
    try {
      assertJsonValue(value, jsonLimits);
      expect.fail('Expected invalid JSON');
    } catch (error) {
      expect(error).toBeInstanceOf(McpClientError);
      expect(error).toMatchObject({ code: 'mcp-invalid-input' });
      expect(String(error)).not.toContain('private-value');
      expect(error).not.toHaveProperty('cause');
    }
  });
});

describe('compileMcpSchema', () => {
  it('checks required, type and extra properties without changing arguments', () => {
    const validate = compileMcpSchema(
      {
        type: 'object',
        required: ['x'],
        properties: { x: { type: 'integer', default: 3 } },
        additionalProperties: false,
      },
      { input: true },
    );
    const input = { x: '2', secret: 'private-value' };
    expect(validate({ x: 2 })).toEqual({ valid: true });
    expect(validate({}).valid).toBe(false);
    expect(validate({ x: '2' }).valid).toBe(false);
    expect(validate({ x: 2, extra: true }).valid).toBe(false);
    expect(validate(input)).toEqual({ valid: false, issue: expect.any(String) });
    expect(validate(input).issue).not.toContain('private-value');
    expect(input).toEqual({ x: '2', secret: 'private-value' });
    const absent: Record<string, unknown> = {};
    validate(absent);
    expect(absent).toEqual({});
  });

  it('requires an exact object root type for input schemas', () => {
    for (const schema of [{}, { type: 'string' }, { type: ['object'] }]) {
      expect(() => compileMcpSchema(schema, { input: true })).toThrowError(
        expect.objectContaining({ code: 'mcp-unsupported-schema' }),
      );
    }
    expect(compileMcpSchema({ type: 'string' })('text').valid).toBe(true);
  });

  it('accepts only Draft 2020-12 at the root and rejects nested dialects', () => {
    const validate = compileMcpSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'string',
    });
    expect(validate('text').valid).toBe(true);
    expectUnsupported({ $schema: 'http://json-schema.org/draft-07/schema#' });
    expectUnsupported({ $schema: 2020 });
    expectUnsupported({
      properties: { x: { $schema: 'https://json-schema.org/draft/2020-12/schema' } },
    });
  });

  it.each([
    '$id',
    '$ref',
    '$dynamicRef',
    '$dynamicAnchor',
    '$anchor',
    '$async',
    'pattern',
    'patternProperties',
    'format',
    'uniqueItems',
    'unevaluatedProperties',
    'if',
    'then',
    'else',
    '$defs',
    'definitions',
    'dependencies',
    'dependentRequired',
    'contains',
    'prefixItems',
    'additionalItems',
    'customKeyword',
  ])('rejects unsupported schema keyword %s at every schema position', (keyword) => {
    expectUnsupported({ [keyword]: 'private-value' });
    expectUnsupported({ properties: { value: { [keyword]: 'private-value' } } });
    expectUnsupported({ items: { [keyword]: 'private-value' } });
    expectUnsupported({ additionalProperties: { [keyword]: 'private-value' } });
    expectUnsupported({ not: { [keyword]: 'private-value' } });
    expectUnsupported({ anyOf: [{ [keyword]: 'private-value' }] });
  });

  it('does not interpret ordinary enum, const, default or examples data as schema keywords', () => {
    const data = { $id: 'data', $ref: 'data', $schema: 'data', pattern: 'data' };
    const validate = compileMcpSchema({
      enum: [data],
      const: data,
      default: data,
      examples: [data],
      title: 'title',
      description: 'description',
      deprecated: true,
      readOnly: false,
      writeOnly: false,
    });
    expect(validate(data).valid).toBe(true);
    expect(validate({ $id: 'different' }).valid).toBe(false);
  });

  it('accepts boolean schemas at nested schema positions', () => {
    expect(
      compileMcpSchema({ properties: { blocked: false }, additionalProperties: true })({
        blocked: 1,
      }).valid,
    ).toBe(false);
    expect(compileMcpSchema({ items: false })([]).valid).toBe(true);
    expect(compileMcpSchema({ anyOf: [true, false] })(1).valid).toBe(true);
    expectUnsupported(false as unknown as Record<string, unknown>);
  });

  it.each([
    { required: 'x' },
    { required: [1] },
    { required: ['x', 'x'] },
    { properties: [] },
    { properties: { x: 1 } },
    { additionalProperties: 1 },
    { items: [] },
    { items: null },
    { enum: 1 },
    { type: 'date' },
    { type: [] },
    { type: ['string', 'string'] },
    { type: [1] },
    { minimum: '1' },
    { maximum: null },
    { exclusiveMinimum: true },
    { exclusiveMaximum: '2' },
    { multipleOf: 0 },
    { multipleOf: -1 },
    { minLength: -1 },
    { maxLength: 1.5 },
    { minItems: '1' },
    { maxItems: -1 },
    { minProperties: false },
    { maxProperties: 1.5 },
    { anyOf: [] },
    { oneOf: {} },
    { allOf: [null] },
    { not: [] },
    { title: false },
    { description: [] },
    { examples: {} },
    { deprecated: 1 },
    { readOnly: 'yes' },
    { writeOnly: null },
  ])('rejects malformed keyword shapes: %j', (schema) => {
    expectUnsupported(schema);
  });

  it('reports the SDK restriction on empty enums and accepts repeated enum members', () => {
    expectUnsupported({ enum: [] });
    const validate = compileMcpSchema({
      enum: [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
    });
    expect(validate({ a: 1, b: 2 }).valid).toBe(true);
    expect(validate({ a: 2, b: 2 }).valid).toBe(false);
  });

  it('implements numeric, string, array, object and composition constraints', () => {
    const cases: readonly [Record<string, unknown>, unknown, unknown][] = [
      [{ type: 'number', minimum: 0, maximum: 10, multipleOf: 2 }, 4, 3],
      [{ exclusiveMinimum: 0, exclusiveMaximum: 2 }, 1, 0],
      [{ type: ['string', 'null'], minLength: 1, maxLength: 2 }, 'é', 'abc'],
      [{ type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer' } }, [1], ['1']],
      [{ type: 'object', minProperties: 1, maxProperties: 1 }, { x: 1 }, {}],
      [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, 1, false],
      [{ oneOf: [{ type: 'integer' }, { minimum: 1 }] }, 0, 1],
      [{ allOf: [{ type: 'number' }, { minimum: 1 }], not: { const: 2 } }, 1, 2],
    ];
    for (const [schema, valid, invalid] of cases) {
      const validate = compileMcpSchema(schema);
      expect(validate(valid).valid).toBe(true);
      expect(validate(invalid).valid).toBe(false);
    }
  });

  it('rejects invalid JSON in schema annotations and returns invalid for non-JSON input', () => {
    expectUnsupported({ default: { value: undefined } });
    expectUnsupported({ maximum: Infinity });
    expectUnsupported({ examples: [new Date()] });
    const validate = compileMcpSchema({});
    expect(validate({ value: undefined }).valid).toBe(false);
    expect(validate(new Date()).valid).toBe(false);
    expect(validate(NaN).valid).toBe(false);
  });

  it('counts all annotation data toward schema depth, node and byte budgets', () => {
    expect(compileMcpSchema({ default: nestedData(31) })(null).valid).toBe(true);
    expectUnsupported({ default: nestedData(32) });
    expect(compileMcpSchema({ default: new Array(2046).fill(null) })(null).valid).toBe(true);
    expectUnsupported({ default: new Array(2047).fill(null) });
    expect(compileMcpSchema({ description: 'x'.repeat(65_518) })(null).valid).toBe(true);
    expectUnsupported({ description: 'x'.repeat(65_519) });
  });

  it('enforces an aggregate composition branch budget including not', () => {
    expect(compileMcpSchema({ anyOf: new Array(32).fill(true) })(null).valid).toBe(true);
    expectUnsupported({ anyOf: new Array(33).fill(true) });
    expectUnsupported({ anyOf: new Array(32).fill(true), not: false });
  });

  it('limits composition nesting through intervening schema locations', () => {
    const compose = (count: number): Record<string, unknown> => {
      let schema: Record<string, unknown> = {};
      for (let index = 0; index < count; index++) schema = { not: { properties: { x: schema } } };
      return schema;
    };
    expect(() => compileMcpSchema(compose(4))).not.toThrow();
    expectUnsupported(compose(5));
  });

  it('enforces input byte, depth and node limits before the validator sees them', () => {
    const validate = compileMcpSchema({ type: 'object' }, { input: true });
    expect(validate({ x: 'x'.repeat(65_528) }).valid).toBe(true);
    expect(validate({ x: 'x'.repeat(65_529) }).valid).toBe(false);
    expect(validate({ x: nestedData(31) }).valid).toBe(true);
    expect(validate({ x: nestedData(32) }).valid).toBe(false);
    expect(validate({ x: new Array(4094).fill(null) }).valid).toBe(true);
    expect(validate({ x: new Array(4095).fill(null) }).valid).toBe(false);
  });

  it('captures input validation policy before callers can mutate the options object', () => {
    const options = { input: true };
    const validate = compileMcpSchema({ type: 'object' }, options);
    options.input = false;
    expect(validate({ x: 'x'.repeat(65_529) }).valid).toBe(false);
  });

  it('accepts result JSON beyond input structural limits while keeping a one MiB budget', () => {
    const validate = compileMcpSchema({});
    expect(validate(nestedData(10_000)).valid).toBe(true);
    expect(validate(new Array(5000).fill(null)).valid).toBe(true);
    expect(validate('x'.repeat(1_048_574)).valid).toBe(true);
    expect(validate('x'.repeat(1_048_575)).valid).toBe(false);
  });

  it('validates object data keys that shadow Object.prototype members', () => {
    const data = { constructor: 'constructor', toString: 1, valueOf: 2 };
    const validate = compileMcpSchema({ const: data });
    expect(validate(data).valid).toBe(true);
    expect(validate({ ...data, valueOf: 3 }).valid).toBe(false);
  });

  it('rejects known meta-schema ids instead of returning a cached meta-schema validator', () => {
    expectUnsupported({ $id: 'https://json-schema.org/draft/2020-12/schema', type: 'integer' });
    expectUnsupported({
      properties: { x: { $id: 'https://json-schema.org/draft/2020-12/schema' } },
    });
    const first = compileMcpSchema({ type: 'integer' });
    const second = compileMcpSchema({ type: 'string' });
    expect(first(1).valid).toBe(true);
    expect(first('1').valid).toBe(false);
    expect(second(1).valid).toBe(false);
    expect(second('1').valid).toBe(true);
  });

  it('supports own __proto__ schema data without polluting prototypes', () => {
    const schema: Record<string, unknown> = JSON.parse(
      '{"type":"object","required":["__proto__"],"additionalProperties":false,"properties":{"__proto__":{"type":"string"}}}',
    );
    const validate = compileMcpSchema(schema);
    expect(validate(JSON.parse('{"__proto__":"value"}')).valid).toBe(true);
    expect(validate(JSON.parse('{"__proto__":1}')).valid).toBe(false);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('keeps original property names distinct from names that contain the internal prefix', () => {
    const validate = compileMcpSchema(
      {
        type: 'object',
        required: ['x', 'weave:x'],
        additionalProperties: false,
        properties: { x: { const: 1 }, 'weave:x': { const: 2 } },
      },
      { input: true },
    );
    expect(validate({ x: 1, 'weave:x': 2 }).valid).toBe(true);
    expect(validate({ x: 2, 'weave:x': 1 }).valid).toBe(false);
    expect(validate({ x: 1 }).valid).toBe(false);
  });
});
