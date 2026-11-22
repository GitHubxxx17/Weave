import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const label = (max = 120) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const opaque = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);
const path = z
  .array(
    z
      .string()
      .min(1)
      .max(64)
      .refine(
        (s) =>
          !['__proto__', 'prototype', 'constructor', '.', '..'].includes(s) && !/^\d+$/.test(s),
      ),
  )
  .min(1)
  .max(8)
  .readonly();
const binding = z.strictObject({ source: id, path }).readonly();
const value = z.union([z.strictObject({ literal: scalar }), z.strictObject({ binding })]);
const options = z
  .array(z.strictObject({ value: z.string().min(1).max(128), label: label() }))
  .min(1)
  .max(32)
  .refine((a) => new Set(a.map((v) => v.value)).size === a.length);
const field = z.discriminatedUnion('type', [
  z.strictObject({
    id,
    type: z.literal('text'),
    label: label(),
    required: z.boolean(),
    default: z.string().max(2048).optional(),
  }),
  z.strictObject({
    id,
    type: z.literal('boolean'),
    label: label(),
    default: z.boolean().optional(),
  }),
  z
    .strictObject({
      id,
      type: z.literal('select'),
      label: label(),
      required: z.boolean(),
      options,
      default: z.string().max(128).optional(),
    })
    .refine((f) => f.default === undefined || f.options.some((o) => o.value === f.default)),
]);
const command = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const block = z.discriminatedUnion('type', [
  z.strictObject({ id, type: z.literal('heading'), text: label() }),
  z.strictObject({ id, type: z.literal('text'), value }),
  z.strictObject({ id, type: z.literal('status'), label: label(), value }),
  z.strictObject({
    id,
    type: z.literal('metric'),
    label: label(),
    value,
    unit: label(32).optional(),
  }),
  z.strictObject({
    id,
    type: z.literal('key-value'),
    rows: z
      .array(z.strictObject({ label: label(), value }))
      .min(1)
      .max(32),
  }),
  z.strictObject({
    id,
    type: z.literal('table'),
    rows: binding,
    columns: z
      .array(z.strictObject({ id, title: label(), path }))
      .min(1)
      .max(10)
      .refine((a) => new Set(a.map((v) => v.id)).size === a.length),
  }),
  z.strictObject({
    id,
    type: z.literal('form'),
    fields: z.array(field).min(1).max(32),
    submit: z.strictObject({ type: z.literal('prepare-command'), command, label: label() }),
  }),
]);
const eventType = z
  .string()
  .min(1)
  .max(129)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const declarativePanelSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id,
    title: label(80),
    description: z.string().max(300).optional(),
    icon: z.enum(['table', 'chart', 'checklist', 'info']),
    placement: z.literal('right'),
    sources: z.array(z.strictObject({ id, eventType, payloadVersion: positive })).max(8),
    blocks: z.array(block).min(1).max(32),
  })
  .superRefine((panel, ctx) => {
    const sources = new Set(panel.sources.map((s) => s.id));
    const blocks = new Set(panel.blocks.map((b) => b.id));
    const fields = panel.blocks.flatMap((b) => (b.type === 'form' ? b.fields : []));
    if (
      sources.size !== panel.sources.length ||
      blocks.size !== panel.blocks.length ||
      fields.length > 32 ||
      new Set(fields.map((f) => f.id)).size !== fields.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate or excessive panel identifiers' });
    const check = (v: z.infer<typeof value>) => {
      if ('binding' in v && !sources.has(v.binding.source))
        ctx.addIssue({ code: 'custom', message: 'Unknown source' });
    };
    for (const b of panel.blocks) {
      if ('value' in b) check(b.value);
      if (
        b.type === 'metric' &&
        'literal' in b.value &&
        b.value.literal !== null &&
        typeof b.value.literal !== 'number'
      )
        ctx.addIssue({ code: 'custom', message: 'Metric must be a number or null' });
      if (b.type === 'key-value') b.rows.forEach((r) => check(r.value));
      if (b.type === 'table' && !sources.has(b.rows.source))
        ctx.addIssue({ code: 'custom', message: 'Unknown table source' });
    }
    let nodes = 0;
    const pending: { value: unknown; depth: number }[] = [{ value: panel, depth: 0 }];
    let structureValid = true;
    while (pending.length > 0) {
      const item = pending.pop()!;
      nodes += 1;
      if (nodes > 4096 || item.depth > 16) {
        structureValid = false;
        break;
      }
      if (Array.isArray(item.value)) {
        nodes += item.value.length;
        for (const v of item.value) pending.push({ value: v, depth: item.depth + 1 });
      } else if (typeof item.value === 'object' && item.value !== null) {
        for (const [key, v] of Object.entries(item.value)) {
          nodes += 1;
          if (key.length > 128) {
            structureValid = false;
            break;
          }
          pending.push({ value: v, depth: item.depth + 1 });
        }
      }
    }
    if (!structureValid)
      ctx.addIssue({ code: 'custom', message: 'Definition structural limit exceeded' });
    if (new TextEncoder().encode(JSON.stringify(panel)).byteLength > 65536)
      ctx.addIssue({ code: 'custom', message: 'Definition too large' });
  })
  .readonly();
export type DeclarativePanel = z.infer<typeof declarativePanelSchema>;
export type PanelBlock = DeclarativePanel['blocks'][number];
export type FormField = Extract<PanelBlock, { type: 'form' }>['fields'][number];
export const authorityFields = {
  serverEpoch: opaque,
  generation: positive,
  authorityEpoch: positive,
};
const stableId = z
  .string()
  .max(256)
  .regex(/^plugin:[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
const descriptor = z
  .strictObject({
    panelId: stableId,
    panelRef: opaque,
    pluginId: id,
    pluginName: z.string().min(1).max(120),
    pluginVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^\d+\.\d+\.\d+$/),
    state: z.enum(['available', 'unavailable']),
    definition: declarativePanelSchema,
  })
  .refine(
    (p) =>
      p.panelId === `plugin:${p.pluginId}/${p.definition.id}` &&
      p.definition.sources.every((s) => s.eventType.startsWith(`${p.pluginId}/`)),
  );
export const panelCatalogSchema = z
  .strictObject({
    ...authorityFields,
    schemaVersion: z.literal(1),
    acceptingRuns: z.boolean(),
    panels: z.array(descriptor).max(128),
  })
  .refine(
    (c) =>
      new Set(c.panels.map((p) => p.panelId)).size === c.panels.length &&
      new Set(c.panels.map((p) => p.panelRef)).size === c.panels.length &&
      [...new Set(c.panels.map((p) => p.pluginId))].every(
        (owner) => c.panels.filter((p) => p.pluginId === owner).length <= 8,
      ),
  )
  .readonly();
export type PanelCatalog = z.infer<typeof panelCatalogSchema>;
export type PluginPanelDescriptor = PanelCatalog['panels'][number];
export const dataStateSchema = z.enum([
  'empty',
  'ready',
  'incompatible',
  'invalid-data',
  'data-too-large',
]);
const cell = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ready'), value: scalar }),
  z.strictObject({ state: z.enum(['empty', 'incompatible', 'invalid-data', 'data-too-large']) }),
]);
export type PanelCell = z.infer<typeof cell>;
const projectedBlock = z.discriminatedUnion('type', [
  z.strictObject({ id, type: z.enum(['text', 'status', 'metric']), cell }),
  z.strictObject({ id, type: z.literal('key-value'), cells: z.array(cell).max(32) }),
  z
    .strictObject({
      id,
      type: z.literal('table'),
      state: dataStateSchema,
      rows: z
        .array(
          z
            .array(
              cell.refine(
                (c) => c.state !== 'ready' || typeof c.value !== 'string' || c.value.length <= 1024,
              ),
            )
            .max(10),
        )
        .max(100),
      totalRows: nonnegative,
      truncatedRows: nonnegative,
    })
    .refine((t) =>
      t.state === 'ready'
        ? t.rows.length === Math.min(t.totalRows, 100) &&
          t.truncatedRows === Math.max(0, t.totalRows - 100)
        : t.rows.length === 0 && t.totalRows === 0 && t.truncatedRows === 0,
    ),
]);
export const panelDataSchema = z
  .strictObject({
    ...authorityFields,
    schemaVersion: z.literal(1),
    panelRef: opaque,
    panelId: stableId,
    sessionId: z.string().min(1).max(128),
    lastSequence: nonnegative,
    state: dataStateSchema,
    sources: z
      .array(
        z.strictObject({
          id,
          eventType,
          payloadVersion: positive,
          state: dataStateSchema,
          latest: z
            .strictObject({
              sequence: positive,
              occurredAt: z.iso.datetime({ offset: true }).max(64),
              payloadVersion: positive.nullable(),
            })
            .nullable(),
        }),
      )
      .max(8),
    blocks: z.array(projectedBlock).max(32),
  })
  .readonly();
export type PanelData = z.infer<typeof panelDataSchema>;
export const prepareRequestSchema = z
  .strictObject({
    formId: id,
    values: z
      .record(id, z.union([z.string().max(2048), z.boolean()]))
      .refine((v) => Object.keys(v).length <= 32),
  })
  .readonly();
export type PrepareRequest = z.infer<typeof prepareRequestSchema>;
export const preparedCommandSchema = z
  .strictObject({
    ...authorityFields,
    schemaVersion: z.literal(1),
    panelRef: opaque,
    panelId: stableId,
    sessionId: z.string().min(1).max(128),
    lastSequence: nonnegative,
    formId: id,
    command,
    text: z.string().refine((t) => new TextEncoder().encode(t).byteLength <= 32768),
    requiresUserSend: z.literal(true),
  })
  .readonly();
export type PreparedCommand = z.infer<typeof preparedCommandSchema>;
export const panelErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      'panel-invalid-input',
      'session-invalid-input',
      'panel-request-forbidden',
      'panel-not-found',
      'session-not-found',
      'panel-stale',
      'session-archived',
      'session-deleted',
      'panel-request-too-large',
      'panel-prompt-too-large',
      'panel-data-too-large',
      'panel-unavailable',
      'panel-busy',
      'panel-store-unavailable',
      'panel-session-invalid',
    ]),
    message: z.string().max(300),
  }),
});
/** Validate projection counts/order against the exact separately validated definition. */
export function validatePanelData(definition: DeclarativePanel, data: PanelData): boolean {
  if (
    data.sources.length !== definition.sources.length ||
    !definition.sources.every((s, i) => {
      const actual = data.sources[i];
      return (
        actual?.id === s.id &&
        actual.eventType === s.eventType &&
        actual.payloadVersion === s.payloadVersion &&
        (actual.latest === null || actual.latest.sequence <= data.lastSequence)
      );
    })
  )
    return false;
  const dynamic = definition.blocks.filter((b) => b.type !== 'heading' && b.type !== 'form');
  return (
    dynamic.length === data.blocks.length &&
    dynamic.every((b, i) => {
      const actual = data.blocks[i];
      if (actual?.id !== b.id || actual.type !== b.type) return false;
      if (b.type === 'key-value')
        return actual.type === 'key-value' && actual.cells.length === b.rows.length;
      if (b.type === 'table')
        return actual.type === 'table' && actual.rows.every((r) => r.length === b.columns.length);
      if (b.type === 'metric')
        return (
          'cell' in actual &&
          (actual.cell.state !== 'ready' ||
            actual.cell.value === null ||
            typeof actual.cell.value === 'number')
        );
      return true;
    })
  );
}
