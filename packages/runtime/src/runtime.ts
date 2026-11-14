import { ServiceContainer, unavailableServiceMessage } from './service-container.js';
import type {
  Runtime,
  RuntimeContext,
  RuntimeOptions,
  RuntimeService,
  RuntimeStatus,
} from './types.js';

const stoppedStartMessage = 'Runtime cannot be started after it has stopped';
const startingStopMessage = 'Runtime cannot be stopped while it is starting';
const duplicateServiceKeysMessage = 'Runtime service keys must be unique';

function validateServiceKeys(services: readonly RuntimeService<unknown>[]): void {
  const keys = new Set<symbol>();

  for (const service of services) {
    if (keys.has(service.key)) {
      throw new Error(duplicateServiceKeysMessage);
    }
    keys.add(service.key);
  }
}

function flattenErrors(error: unknown): unknown[] {
  return error instanceof AggregateError ? [...error.errors] : [error];
}

class RuntimeImpl implements Runtime {
  private readonly abortController = new AbortController();
  private readonly config: Readonly<Record<string, unknown>>;
  private readonly services: readonly RuntimeService<unknown>[];
  private readonly container = new ServiceContainer();
  private readonly createdServices: RuntimeService<unknown>[] = [];
  private statusValue: RuntimeStatus = 'created';
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private closed = false;

  constructor(options?: RuntimeOptions) {
    this.config = options?.config ?? {};
    this.services = options?.services ?? [];
    validateServiceKeys(this.services);
  }

  get status(): RuntimeStatus {
    return this.statusValue;
  }

  async start(): Promise<void> {
    if (this.statusValue === 'running') {
      return;
    }
    if (this.statusValue === 'starting') {
      return this.startPromise;
    }
    if (this.closed) {
      throw new Error(stoppedStartMessage);
    }
    if (this.statusValue === 'stopping') {
      throw new Error('Runtime cannot be started while it is stopping');
    }

    this.statusValue = 'starting';
    const promise = this.startServices();
    this.startPromise = promise;

    return promise.finally(() => {
      if (this.startPromise === promise) {
        this.startPromise = undefined;
      }
    });
  }

  async stop(): Promise<void> {
    if (this.statusValue === 'stopped') {
      return;
    }
    if (this.statusValue === 'stopping') {
      return this.stopPromise;
    }
    if (this.statusValue === 'starting') {
      throw new Error(startingStopMessage);
    }

    this.closed = true;
    this.statusValue = 'stopping';
    this.abortController.abort();
    const promise = this.stopServices();
    this.stopPromise = promise;

    return promise.finally(() => {
      if (this.stopPromise === promise) {
        this.stopPromise = undefined;
      }
    });
  }

  get<T>(service: RuntimeService<T>): T {
    if (this.statusValue !== 'running') {
      throw new Error(unavailableServiceMessage);
    }

    return this.container.get(service);
  }

  private async startServices(): Promise<void> {
    const context: RuntimeContext = {
      signal: this.abortController.signal,
      config: this.config,
    };

    try {
      for (const service of this.services) {
        const value = await service.create(context);
        this.container.set(service, value);
        this.createdServices.push(service);
      }
      this.statusValue = 'running';
    } catch (error) {
      let cleanupDidThrow = false;
      let cleanupError: unknown;

      try {
        await this.disposeCreatedServices();
      } catch (caughtError) {
        cleanupDidThrow = true;
        cleanupError = caughtError;
      }
      this.statusValue = 'stopped';

      if (cleanupDidThrow) {
        throw new AggregateError(
          [error, ...flattenErrors(cleanupError)],
          'Runtime startup and cleanup failed',
          { cause: error },
        );
      }

      throw error;
    }
  }

  private async stopServices(): Promise<void> {
    try {
      await this.disposeCreatedServices();
    } finally {
      this.statusValue = 'stopped';
    }
  }

  private async disposeCreatedServices(): Promise<void> {
    const errors: unknown[] = [];

    for (let index = this.createdServices.length - 1; index >= 0; index -= 1) {
      const service = this.createdServices[index];
      if (service === undefined) {
        continue;
      }

      const value = this.container.get(service);
      try {
        await service.dispose?.(value);
      } catch (error) {
        errors.push(error);
      }
    }

    this.createdServices.length = 0;
    this.container.clear();

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Runtime service disposal failed', { cause: errors[0] });
    }
  }
}

export function createRuntime(options?: RuntimeOptions): Runtime {
  return new RuntimeImpl(options);
}

export { duplicateServiceKeysMessage, stoppedStartMessage };
