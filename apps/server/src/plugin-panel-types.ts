import { z } from 'zod';
import { declarativePanelSchema, type DeclarativePanel, type Scalar } from '@weave/plugin';
import type { SessionEventStore } from '@weave/session';
import type { ManagedPreparedIdentity } from '@weave/plugin-host';
import type { ExtensionIdentity } from './extension-types.js';
import type { ServerHost } from './server-host.js';
export interface BoundPanelDefinition {
  readonly panelId: string;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly definitionHash: string;
  readonly definition: DeclarativePanel;
  readonly commands: Readonly<Record<string, { readonly name: string; readonly prompt: string }>>;
}
export type HostUiMemberIdentity =
  | { readonly kind: 'host'; readonly pluginId: string; readonly baselineId: string }
  | {
      readonly kind: 'source';
      readonly pluginId: string;
      readonly sourceId: string;
      readonly identity: string;
      readonly origin?: ExtensionIdentity['origin'];
      readonly instanceId?: string;
      readonly managedIdentity?: ManagedPreparedIdentity;
    };
export interface CurrentUiObservation {
  readonly generationId: number;
  readonly authorityEpoch: number;
  readonly available: boolean;
  readonly members: readonly HostUiMemberIdentity[];
  readonly signal: AbortSignal;
}
export interface CurrentUiAuthority {
  captureCurrentUiSync(): CurrentUiObservation;
  assertCurrentUiSync(capture: CurrentUiObservation): void;
  subscribeUiInvalidationSync(listener: () => void): () => void;
}
export interface HostPublicationSnapshot {
  readonly generationId: number;
  readonly publicationId: string;
  readonly panels: readonly BoundPanelDefinition[];
}
export const panelTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
export const panelSessionIdSchema = z.string().min(1).max(128);
const safe = z.number().int().safe();
const tuple = {
  serverEpoch: panelTokenSchema,
  generation: safe.positive(),
  authorityEpoch: safe.positive(),
};
const scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);
export const dataStateSchema = z.enum([
  'empty',
  'ready',
  'incompatible',
  'invalid-data',
  'data-too-large',
]);
export type DataState = z.infer<typeof dataStateSchema>;
export const cellSchema = z.union([
  z.strictObject({ state: z.literal('ready'), value: scalar }),
  z.strictObject({ state: z.enum(['empty', 'incompatible', 'invalid-data', 'data-too-large']) }),
]);
export type Cell =
  | { readonly state: 'ready'; readonly value: Scalar }
  | { readonly state: Exclude<DataState, 'ready'> };
export const projectedBlockSchema = z.union([
  z.strictObject({ id: z.string(), type: z.enum(['text', 'status', 'metric']), cell: cellSchema }),
  z.strictObject({
    id: z.string(),
    type: z.literal('key-value'),
    cells: z.array(cellSchema).max(32),
  }),
  z.strictObject({
    id: z.string(),
    type: z.literal('table'),
    state: dataStateSchema,
    rows: z.array(z.array(cellSchema).max(10)).max(100),
    totalRows: safe.nonnegative(),
    truncatedRows: safe.nonnegative(),
  }),
]);
export type ProjectedBlock = z.infer<typeof projectedBlockSchema>;
export const sourceResultSchema = z.strictObject({
  id: z.string(),
  eventType: z.string().max(129),
  payloadVersion: safe.positive(),
  state: dataStateSchema,
  latest: z
    .strictObject({
      sequence: safe.positive(),
      occurredAt: z.iso.datetime().max(64),
      payloadVersion: safe.positive().nullable(),
    })
    .nullable(),
});
export type SourceResult = z.infer<typeof sourceResultSchema>;
export const panelCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...tuple,
  acceptingRuns: z.boolean(),
  panels: z
    .array(
      z.strictObject({
        panelId: z.string(),
        panelRef: panelTokenSchema,
        pluginId: z.string().max(64),
        pluginName: z.string().max(120),
        pluginVersion: z.string().max(64),
        state: z.enum(['available', 'unavailable']),
        definition: declarativePanelSchema,
      }),
    )
    .max(128),
});
export type PanelCatalog = z.infer<typeof panelCatalogSchema>;
export const panelDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...tuple,
  panelRef: panelTokenSchema,
  panelId: z.string(),
  sessionId: panelSessionIdSchema,
  lastSequence: safe.nonnegative(),
  state: dataStateSchema,
  sources: z.array(sourceResultSchema).max(8),
  blocks: z.array(projectedBlockSchema).max(32),
});
export type PanelData = z.infer<typeof panelDataSchema>;
const submittedValuesSchema = z
  .unknown()
  .transform((input, context) => {
    // z.record intentionally strips __proto__ while parsing. Inspect the raw
    // own keys first so an unknown submitted field cannot disappear before the
    // service checks its declared form fields.
    const plain =
      input !== null &&
      typeof input === 'object' &&
      (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null);
    if (
      !plain ||
      Reflect.ownKeys(input).some(
        (key) =>
          typeof key !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) || key.length > 64,
      )
    ) {
      context.addIssue({ code: 'custom', message: 'Panel submitted fields are invalid' });
      return z.NEVER;
    }
    return input;
  })
  .pipe(z.record(z.string().max(64), z.union([z.string().max(2048), z.boolean()])));
export const prepareRequestSchema = z.strictObject({
  formId: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  values: submittedValuesSchema,
});
export type PrepareRequest = z.infer<typeof prepareRequestSchema>;
export const preparedCommandSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...tuple,
  panelRef: panelTokenSchema,
  panelId: z.string(),
  sessionId: panelSessionIdSchema,
  lastSequence: safe.nonnegative(),
  formId: z.string(),
  command: z.string().max(64),
  text: z.string(),
  requiresUserSend: z.literal(true),
});
export type PreparedCommand = z.infer<typeof preparedCommandSchema>;
export const panelErrorCodeSchema = z.enum([
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
]);
export type PanelErrorCode = z.infer<typeof panelErrorCodeSchema>;
export const panelErrorBodySchema = z.strictObject({
  error: z.strictObject({ code: panelErrorCodeSchema, message: z.string().max(300) }),
});
export type PanelErrorBody = z.infer<typeof panelErrorBodySchema>;
export interface PanelService {
  catalog(): PanelCatalog;
  read(sessionId: string, panelRef: string, options: { signal?: AbortSignal }): Promise<PanelData>;
  prepare(
    sessionId: string,
    panelRef: string,
    input: PrepareRequest,
    options: { signal?: AbortSignal },
  ): Promise<PreparedCommand>;
  closeSync(): void;
  drain(): Promise<void>;
}
export interface PanelServiceOptions {
  readonly host: ServerHost;
  readonly authority: CurrentUiAuthority;
  readonly sessionStore: SessionEventStore;
}
export function panelBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
export function freezePanel<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freezePanel(item);
    Object.freeze(value);
  }
  return value;
}
