import { z } from 'zod';
import { commandNamePattern } from './commands.js';
import { pluginEventTypePattern } from './event-type.js';

export type Scalar = string | number | boolean | null;
export type DataPath = readonly string[];
export interface Binding {
  readonly source: string;
  readonly path: DataPath;
}
export type Value = { readonly literal: Scalar } | { readonly binding: Binding };
export interface PanelSource {
  readonly id: string;
  readonly eventType: string;
  readonly payloadVersion: number;
}
export type FormField =
  | {
      readonly id: string;
      readonly type: 'text';
      readonly label: string;
      readonly required: boolean;
      readonly default?: string;
    }
  | {
      readonly id: string;
      readonly type: 'boolean';
      readonly label: string;
      readonly default?: boolean;
    }
  | {
      readonly id: string;
      readonly type: 'select';
      readonly label: string;
      readonly required: boolean;
      readonly options: readonly { readonly value: string; readonly label: string }[];
      readonly default?: string;
    };
export type PanelBlock =
  | { readonly id: string; readonly type: 'heading'; readonly text: string }
  | { readonly id: string; readonly type: 'text'; readonly value: Value }
  | { readonly id: string; readonly type: 'status'; readonly label: string; readonly value: Value }
  | {
      readonly id: string;
      readonly type: 'metric';
      readonly label: string;
      readonly value: Value;
      readonly unit?: string;
    }
  | {
      readonly id: string;
      readonly type: 'key-value';
      readonly rows: readonly { readonly label: string; readonly value: Value }[];
    }
  | {
      readonly id: string;
      readonly type: 'table';
      readonly rows: Binding;
      readonly columns: readonly {
        readonly id: string;
        readonly title: string;
        readonly path: DataPath;
      }[];
    }
  | {
      readonly id: string;
      readonly type: 'form';
      readonly fields: readonly FormField[];
      readonly submit: {
        readonly type: 'prepare-command';
        readonly command: string;
        readonly label: string;
      };
    };
export interface DeclarativePanel {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly icon: 'table' | 'chart' | 'checklist' | 'info';
  readonly placement: 'right';
  readonly sources: readonly PanelSource[];
  readonly blocks: readonly PanelBlock[];
}
export interface AttributedPanel extends DeclarativePanel {
  readonly pluginId: string;
}
export interface PanelsExtensionApi {
  addPanel(definition: DeclarativePanel): void | false;
}

export const panelLimits = Object.freeze({
  definitionBytes: 65536,
  sources: 8,
  blocks: 32,
  depth: 16,
  nodes: 4096,
} as const);
const localId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const nonblank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() !== '', { message: 'Text must not be blank' });

// Explicit undefined is not JSON and is not an alternative spelling of absence.
function closedObject<T extends z.ZodRawShape>(shape: T) {
  return z
    .object(shape)
    .strict()
    .superRefine((value, context) => {
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined)
          context.addIssue({
            code: 'custom',
            path: [key],
            message: 'Optional properties must be absent, not undefined',
          });
      }
    });
}
const pathSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(64)
      .refine(
        (part) =>
          !['__proto__', 'prototype', 'constructor', '.', '..'].includes(part) &&
          !/^\d+$/.test(part),
      ),
  )
  .min(1)
  .max(8);
const bindingSchema = closedObject({ source: localId, path: pathSchema });
const scalarSchema = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);
const valueSchema = z.union([
  closedObject({ literal: scalarSchema }),
  closedObject({ binding: bindingSchema }),
]);
const fieldSchema = z.discriminatedUnion('type', [
  closedObject({
    id: localId,
    type: z.literal('text'),
    label: nonblank(120),
    required: z.boolean(),
    default: z.string().max(2048).optional(),
  }),
  closedObject({
    id: localId,
    type: z.literal('boolean'),
    label: nonblank(120),
    default: z.boolean().optional(),
  }),
  closedObject({
    id: localId,
    type: z.literal('select'),
    label: nonblank(120),
    required: z.boolean(),
    options: z
      .array(closedObject({ value: z.string().min(1).max(128), label: nonblank(120) }))
      .min(1)
      .max(32),
    default: z.string().min(1).max(128).optional(),
  }),
]);
const blockSchema = z.discriminatedUnion('type', [
  closedObject({ id: localId, type: z.literal('heading'), text: nonblank(120) }),
  closedObject({ id: localId, type: z.literal('text'), value: valueSchema }),
  closedObject({
    id: localId,
    type: z.literal('status'),
    label: nonblank(120),
    value: valueSchema,
  }),
  closedObject({
    id: localId,
    type: z.literal('metric'),
    label: nonblank(120),
    value: valueSchema,
    unit: nonblank(32).optional(),
  }),
  closedObject({
    id: localId,
    type: z.literal('key-value'),
    rows: z
      .array(closedObject({ label: nonblank(120), value: valueSchema }))
      .min(1)
      .max(32),
  }),
  closedObject({
    id: localId,
    type: z.literal('table'),
    rows: bindingSchema,
    columns: z
      .array(closedObject({ id: localId, title: nonblank(120), path: pathSchema }))
      .min(1)
      .max(10),
  }),
  closedObject({
    id: localId,
    type: z.literal('form'),
    fields: z.array(fieldSchema).min(1).max(32),
    submit: closedObject({
      type: z.literal('prepare-command'),
      command: z.string().min(1).max(64).regex(commandNamePattern),
      label: nonblank(120),
    }),
  }),
]);
const panelShape = {
  schemaVersion: z.literal(1),
  id: localId,
  title: nonblank(80),
  description: z.string().max(300).optional(),
  icon: z.enum(['table', 'chart', 'checklist', 'info']),
  placement: z.literal('right'),
  sources: z
    .array(
      closedObject({
        id: localId,
        eventType: z.string().max(129).regex(pluginEventTypePattern),
        payloadVersion: z.number().int().positive().safe(),
      }),
    )
    .max(panelLimits.sources),
  blocks: z.array(blockSchema).min(1).max(panelLimits.blocks),
};
function validateReferences(panel: DeclarativePanel, context: z.RefinementCtx): void {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  const unique = (ids: readonly string[], kind: string) => {
    if (new Set(ids).size !== ids.length) issue(`Duplicate ${kind} ID`);
  };
  unique(
    panel.sources.map((source) => source.id),
    'source',
  );
  unique(
    panel.blocks.map((block) => block.id),
    'block',
  );
  const sources = new Set(panel.sources.map((source) => source.id));
  const binding = (value: Binding) => {
    if (!sources.has(value.source)) issue('Binding source is not declared');
  };
  const value = (item: Value) => {
    if ('binding' in item) binding(item.binding);
  };
  const fields: FormField[] = [];
  for (const block of panel.blocks) {
    if (block.type === 'text' || block.type === 'status' || block.type === 'metric') {
      value(block.value);
      if (
        block.type === 'metric' &&
        'literal' in block.value &&
        block.value.literal !== null &&
        typeof block.value.literal !== 'number'
      )
        issue('Metric literals must be finite numbers or null');
    } else if (block.type === 'key-value') block.rows.forEach((row) => value(row.value));
    else if (block.type === 'table') {
      binding(block.rows);
      unique(
        block.columns.map((column) => column.id),
        'column',
      );
    } else if (block.type === 'form') {
      fields.push(...block.fields);
      for (const field of block.fields) {
        if (field.type === 'select') {
          unique(
            field.options.map((option) => option.value),
            'select option',
          );
          if (
            field.default !== undefined &&
            !field.options.some((option) => option.value === field.default)
          )
            issue('Select default must be an option value');
        }
      }
    }
  }
  if (fields.length > 32) issue('Panel has too many form fields');
  unique(
    fields.map((field) => field.id),
    'field',
  );
}
// closedObject rejects present undefined before these output type assertions,
// preserving the public exact-optional contract that Zod cannot infer.
/** Validates detached host JSON. Use cloneDeclarativePanel for author-owned input. */
export const declarativePanelSchema: z.ZodType<DeclarativePanel> = closedObject(
  panelShape,
).superRefine((panel, context) =>
  validateReferences(panel as DeclarativePanel, context),
) as z.ZodType<DeclarativePanel>;
/** Collector-only owner attribution; author JSON cannot provide pluginId. */
export const attributedPanelSchema: z.ZodType<AttributedPanel> = closedObject({
  ...panelShape,
  pluginId: localId,
}).superRefine((panel, context) =>
  validateReferences(panel as DeclarativePanel, context),
) as z.ZodType<AttributedPanel>;

type JsonValue = Scalar | JsonValue[] | { [key: string]: JsonValue };
class PanelJsonError extends TypeError {}
function cloneClosedPanelJson(input: unknown): JsonValue {
  const seen = new WeakSet<object>();
  let nodes = 0;
  function consume(depth: number): void {
    if (depth > panelLimits.depth) throw new PanelJsonError('Panel JSON exceeds its depth limit');
    if (++nodes > panelLimits.nodes) throw new PanelJsonError('Panel JSON exceeds its node limit');
  }
  function visit(value: unknown, depth: number): JsonValue {
    consume(depth);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.length > 4096) throw new PanelJsonError('Invalid panel JSON');
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null || seen.has(value))
      throw new PanelJsonError('Invalid panel JSON');
    seen.add(value);
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype
    )
      throw new PanelJsonError('Invalid panel JSON');
    const keys = Reflect.ownKeys(value);
    if (keys.length > panelLimits.nodes)
      throw new PanelJsonError('Panel JSON exceeds its node limit');
    const result: JsonValue[] | { [key: string]: JsonValue } = array ? [] : {};
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        length === undefined ||
        !('value' in length) ||
        length.enumerable ||
        length.configurable ||
        typeof length.value !== 'number' ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        keys.length !== length.value + 1
      )
        throw new PanelJsonError('Invalid panel JSON');
    }
    let index = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      consume(depth + 1);
      if (typeof key !== 'string' || key.length > 128 || (array && key !== String(index++)))
        throw new PanelJsonError('Invalid panel JSON');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
        throw new PanelJsonError('Invalid panel JSON');
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  try {
    return visit(input, 0);
  } catch (error: unknown) {
    // Reflection on a trusted candidate Proxy can execute traps. No trap error,
    // accessor, iterator or toJSON is ever treated as host panel data.
    if (error instanceof PanelJsonError) throw error;
    throw new TypeError('Invalid panel JSON', { cause: error });
  }
}
function freezeHostJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeHostJson(child);
    Object.freeze(value);
  }
  return value;
}
/** Bounded descriptor clone precedes schema parsing and serialization. */
export function cloneDeclarativePanel(input: unknown): DeclarativePanel {
  const parsed = declarativePanelSchema.parse(cloneClosedPanelJson(input));
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > panelLimits.definitionBytes)
    throw new TypeError('Panel definition exceeds its byte limit');
  return freezeHostJson(parsed);
}
