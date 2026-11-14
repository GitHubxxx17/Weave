export type RuntimeStatus = 'created' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface RuntimeContext {
  readonly signal: AbortSignal;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface RuntimeService<T> {
  readonly key: symbol;
  readonly create: (context: RuntimeContext) => T | Promise<T>;
  readonly dispose?: (value: T) => void | Promise<void>;
}

export interface Runtime {
  readonly status: RuntimeStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  get<T>(service: RuntimeService<T>): T;
}

export interface RuntimeOptions {
  readonly config?: Readonly<Record<string, unknown>>;
  readonly services?: readonly RuntimeService<unknown>[];
}
