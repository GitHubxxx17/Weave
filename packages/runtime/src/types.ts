/** Lifecycle states exposed by a Runtime instance. */
export type RuntimeStatus = 'created' | 'starting' | 'running' | 'stopping' | 'stopped';

/**
 * Context shared with services while they are created.
 *
 * The signal belongs to one Runtime startup attempt. Services should observe
 * it for cancellation instead of creating an unrelated lifecycle signal.
 */
export interface RuntimeContext {
  /** Aborted when Runtime startup fails or shutdown begins. */
  readonly signal: AbortSignal;
  /** Immutable configuration supplied to the Runtime. */
  readonly config: Readonly<Record<string, unknown>>;
}

/**
 * Typed service factory registered with a Runtime.
 *
 * Services are created in declaration order and disposed in reverse order.
 * The symbol key keeps lookup identity local to the Runtime instance.
 */
export interface RuntimeService<T> {
  /** Stable identity used by the service container. */
  readonly key: symbol;
  /** Creates the service during Runtime startup. */
  readonly create: (context: RuntimeContext) => T | Promise<T>;
  /** Releases resources held by the service during Runtime shutdown. */
  readonly dispose?: (value: T) => void | Promise<void>;
}

/**
 * Runtime lifecycle and typed service lookup boundary.
 *
 * Runtime intentionally has no HTTP or UI dependency so the same assembly can
 * be reused by a server, CLI, desktop process, or test.
 */
export interface Runtime {
  /** Current lifecycle state. */
  readonly status: RuntimeStatus;
  /** Starts all registered services. */
  start(): Promise<void>;
  /** Stops the Runtime and disposes every created service. */
  stop(): Promise<void>;
  /**
   * Gets a running service by its service definition.
   *
   * @throws When the Runtime is not running or the service was not created.
   */
  get<T>(service: RuntimeService<T>): T;
}

/** Configuration used to create an isolated Runtime instance. */
export interface RuntimeOptions {
  /** Values made available to every service factory. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Services to create in declaration order. */
  readonly services?: readonly RuntimeService<unknown>[];
}
