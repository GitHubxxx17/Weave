import type { NewSessionEvent, SessionEvent } from './events.js';
import { z } from 'zod';

/**
 * Stable error categories exposed by Session Event Store implementations.
 */
export type SessionStoreErrorCode =
  | 'session-store-closed'
  | 'session-store-invalid-input'
  | 'session-store-io'
  | 'session-store-protocol';

/**
 * Error raised when a Store cannot satisfy an operation.
 */
export class SessionStoreError extends Error {
  readonly code: SessionStoreErrorCode;

  constructor(code: SessionStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionStoreError';
    this.code = code;
  }
}

/**
 * Runtime validation for the Session identifier accepted by Store methods.
 */
export const sessionIdSchema = z.string().min(1);

/**
 * Runtime validation for incremental event reads.
 */
export const readSessionEventsOptionsSchema = z
  .object({
    afterSequence: z.number().int().nonnegative().safe().optional(),
  })
  .passthrough();

/**
 * Persistence boundary for append-only Session facts.
 */
export interface SessionEventStore {
  /**
   * Appends caller-provided facts and assigns Store-owned persistence fields.
   */
  append(sessionId: string, events: readonly NewSessionEvent[]): Promise<readonly SessionEvent[]>;

  /**
   * Reads events in sequence order, optionally after a known sequence.
   */
  read(
    sessionId: string,
    options?: {
      readonly afterSequence?: number;
    },
  ): Promise<readonly SessionEvent[]>;

  /**
   * Releases resources. Repeated calls must be safe.
   */
  close(): Promise<void>;
}
