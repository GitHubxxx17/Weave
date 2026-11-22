import { z } from 'zod';
import type { SessionEvent } from '@weave/session';
import type { Binding, PanelBlock, Scalar, Value } from '@weave/plugin';
import { PanelError } from './plugin-panel-errors.js';
import {
  freezePanel,
  panelBytes,
  type BoundPanelDefinition,
  type Cell,
  type DataState,
  type PanelData,
  type ProjectedBlock,
  type SourceResult,
} from './plugin-panel-types.js';
export interface PanelProjection {
  readonly lastSequence: number;
  readonly archived: boolean;
  readonly sources: readonly SourceResult[];
  readonly blocks: readonly ProjectedBlock[];
  readonly state: DataState;
}
const envelope = z.object({
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  sequence: z.number().int().safe().positive(),
  type: z.string().min(1),
  occurredAt: z.iso.datetime().max(64),
  payload: z.unknown(),
});
const priority: Record<DataState, number> = {
  empty: 0,
  ready: 1,
  incompatible: 2,
  'invalid-data': 3,
  'data-too-large': 4,
};
const worst = (states: readonly DataState[]): DataState =>
  states.reduce<DataState>((a, b) => (priority[a] > priority[b] ? a : b), 'empty');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function own(value: unknown, key: string): unknown {
  if (!record(value)) return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d !== undefined && 'value' in d ? d.value : undefined;
}
function path(value: unknown, segments: readonly string[]): unknown {
  for (const segment of segments) value = own(value, segment);
  return value;
}
function cell(value: unknown, metric = false, max = 4096): Cell {
  if (typeof value === 'string')
    return value.length > max
      ? { state: 'data-too-large' }
      : metric
        ? { state: 'invalid-data' }
        : { state: 'ready', value };
  if (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'boolean' && !metric)
  )
    return { state: 'ready', value: value as Scalar };
  return { state: 'invalid-data' };
}
function valueCell(
  value: Value,
  source: string,
  payload: unknown,
  metric: boolean,
  previous: Cell,
): Cell {
  return 'literal' in value
    ? cell(value.literal, metric)
    : value.binding.source === source
      ? cell(path(payload, value.binding.path), metric)
      : previous;
}
function initialValue(value: Value, metric = false): Cell {
  return 'literal' in value ? cell(value.literal, metric) : { state: 'empty' };
}
function initialBlocks(blocks: readonly PanelBlock[]): ProjectedBlock[] {
  return blocks.flatMap<ProjectedBlock>((block) => {
    switch (block.type) {
      case 'heading':
      case 'form':
        return [];
      case 'text':
      case 'status':
      case 'metric':
        return [
          {
            id: block.id,
            type: block.type,
            cell: initialValue(block.value, block.type === 'metric'),
          },
        ];
      case 'key-value':
        return [
          {
            id: block.id,
            type: block.type,
            cells: block.rows.map((row) => initialValue(row.value)),
          },
        ];
      case 'table':
        return [
          {
            id: block.id,
            type: block.type,
            state: 'empty',
            rows: [],
            totalRows: 0,
            truncatedRows: 0,
          },
        ];
    }
  });
}
function table(
  binding: Binding,
  columns: Extract<PanelBlock, { type: 'table' }>['columns'],
  payload: unknown,
): Extract<ProjectedBlock, { type: 'table' }> {
  const rows = path(payload, binding.path);
  const invalid = {
    id: '',
    type: 'table' as const,
    state: 'invalid-data' as const,
    rows: [],
    totalRows: 0,
    truncatedRows: 0,
  };
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) return invalid;
  // Validate dense ordinary array shape without reading unselected row values.
  if (Reflect.ownKeys(rows).length !== rows.length + 1) return invalid;
  for (let index = 0; index < rows.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
    if (descriptor === undefined || !('value' in descriptor) || !record(descriptor.value))
      return invalid;
  }
  const output: Cell[][] = [];
  for (let i = 0; i < Math.min(rows.length, 100); i++) {
    const descriptor = Object.getOwnPropertyDescriptor(rows, String(i));
    if (descriptor === undefined || !('value' in descriptor) || !record(descriptor.value))
      return invalid;
    output.push(columns.map((column) => cell(path(descriptor.value, column.path), false, 1024)));
  }
  const state = worst(output.flat().map((item) => item.state));
  return state !== 'ready' && output.length > 0
    ? { ...invalid, state }
    : {
        id: '',
        type: 'table',
        state: 'ready',
        rows: output,
        totalRows: rows.length,
        truncatedRows: Math.max(0, rows.length - 100),
      };
}
function markSource(
  blocks: readonly ProjectedBlock[],
  definition: BoundPanelDefinition['definition'],
  source: string,
  state: Exclude<DataState, 'ready'>,
): ProjectedBlock[] {
  return blocks.map((projected) => {
    const block = definition.blocks.find((item) => item.id === projected.id)!;
    const mark = (value: Value, previous: Cell): Cell =>
      'binding' in value && value.binding.source === source ? { state } : previous;
    if (projected.type === 'table' && block.type === 'table' && block.rows.source === source)
      return { ...projected, state, rows: [], totalRows: 0, truncatedRows: 0 };
    if (projected.type === 'key-value' && block.type === 'key-value')
      return {
        ...projected,
        cells: projected.cells.map((previous, i) => mark(block.rows[i]!.value, previous)),
      };
    if ('cell' in projected && 'value' in block)
      return { ...projected, cell: mark(block.value, projected.cell) };
    return projected;
  });
}
export function compactPanelProjection(
  state: PanelProjection,
  definition: BoundPanelDefinition['definition'],
): PanelProjection {
  let blocks = [...state.blocks];
  for (const source of definition.sources)
    blocks = markSource(blocks, definition, source.id, 'data-too-large');
  return {
    ...state,
    state: 'data-too-large',
    sources: state.sources.map((source) => ({ ...source, state: 'data-too-large' })),
    blocks,
  };
}
/** Fold one observed durable prefix. This deliberately adds no deletion fence after store.read. */
export function projectPanelPrefix(
  sessionId: string,
  panel: BoundPanelDefinition,
  base: PanelProjection | undefined,
  events: readonly SessionEvent[],
): PanelProjection {
  let cursor = base?.lastSequence ?? 0,
    archived = base?.archived ?? false,
    deleted = false;
  const sources: SourceResult[] = base
    ? [...base.sources]
    : panel.definition.sources.map((source) => ({ ...source, state: 'empty', latest: null }));
  let blocks = base ? [...base.blocks] : initialBlocks(panel.definition.blocks);
  if (cursor === 0 && events.length === 0) throw new PanelError('session-not-found');
  for (const raw of events) {
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) throw new PanelError('panel-session-invalid');
    const event = parsed.data;
    if (
      event.sessionId !== sessionId ||
      event.sequence !== cursor + 1 ||
      deleted ||
      (cursor === 0 ? event.type !== 'session.created' : event.type === 'session.created')
    )
      throw new PanelError('panel-session-invalid');
    if (event.type === 'session.created') {
      if (
        !record(event.payload) ||
        (own(event.payload, 'title') !== undefined &&
          typeof own(event.payload, 'title') !== 'string')
      )
        throw new PanelError('panel-session-invalid');
    }
    if (
      event.type === 'session.archived' ||
      event.type === 'session.restored' ||
      event.type === 'session.deleted'
    ) {
      if (
        !record(event.payload) ||
        (own(event.payload, 'reason') !== undefined &&
          typeof own(event.payload, 'reason') !== 'string')
      )
        throw new PanelError('panel-session-invalid');
      if (event.type === 'session.archived') {
        if (archived) throw new PanelError('panel-session-invalid');
        archived = true;
      } else if (event.type === 'session.restored') {
        if (!archived) throw new PanelError('panel-session-invalid');
        archived = false;
      } else deleted = true;
    }
    if (
      archived &&
      [
        'message.created',
        'turn.started',
        'step.started',
        'step.completed',
        'tool-call.created',
        'tool-result.created',
      ].includes(event.type)
    )
      throw new PanelError('panel-session-invalid');
    cursor = event.sequence;
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]!;
      if (source.eventType !== event.type) continue;
      const version = own(event.payload, 'schemaVersion');
      const payloadVersion =
        typeof version === 'number' && Number.isSafeInteger(version) && version > 0
          ? version
          : null;
      let state: DataState = payloadVersion === source.payloadVersion ? 'ready' : 'incompatible';
      if (!record(event.payload)) state = 'invalid-data';
      if (state === 'ready') {
        const selected: DataState[] = [];
        blocks = blocks.map((projected) => {
          const block = panel.definition.blocks.find((item) => item.id === projected.id)!;
          if (
            projected.type === 'table' &&
            block.type === 'table' &&
            block.rows.source === source.id
          ) {
            const value = table(block.rows, block.columns, event.payload);
            selected.push(value.state);
            return { ...value, id: block.id };
          }
          if (projected.type === 'key-value' && block.type === 'key-value') {
            const cells = projected.cells.map((previous, i) => {
              const value = block.rows[i]!.value;
              const next = valueCell(value, source.id, event.payload, false, previous);
              if ('binding' in value && value.binding.source === source.id)
                selected.push(next.state);
              return next;
            });
            return { ...projected, cells };
          }
          if ('cell' in projected && 'value' in block) {
            const next = valueCell(
              block.value,
              source.id,
              event.payload,
              block.type === 'metric',
              projected.cell,
            );
            if ('binding' in block.value && block.value.binding.source === source.id)
              selected.push(next.state);
            return { ...projected, cell: next };
          }
          return projected;
        });
        state = worst(['ready', ...selected]);
      }
      if (state !== 'ready') blocks = markSource(blocks, panel.definition, source.id, state);
      sources[index] = {
        ...source,
        state,
        latest: { sequence: event.sequence, occurredAt: event.occurredAt, payloadVersion },
      };
    }
  }
  if (deleted) throw new PanelError('session-deleted');
  let result: PanelProjection = {
    lastSequence: cursor,
    archived,
    sources,
    blocks,
    state: sources.length === 0 ? 'ready' : worst(sources.map((source) => source.state)),
  };
  if (panelBytes(result) > 65536) result = compactPanelProjection(result, panel.definition);
  if (panelBytes(result) > 65536) throw new PanelError('panel-data-too-large');
  return freezePanel(result);
}
export function boundPanelData(
  data: PanelData,
  definition: BoundPanelDefinition['definition'],
): PanelData {
  if (panelBytes(data) <= 65536) return data;
  const projected = compactPanelProjection({ ...data, archived: false }, definition);
  const result = {
    ...data,
    state: projected.state,
    sources: [...projected.sources],
    blocks: [...projected.blocks],
  };
  if (panelBytes(result) > 65536) throw new PanelError('panel-data-too-large');
  return freezePanel(result);
}
