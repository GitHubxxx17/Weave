import type { RuntimeService } from './types.js';

const unavailableServiceMessage = 'Runtime service is not available';

/**
 * Stores service instances for one Runtime.
 *
 * The container is intentionally instance-scoped rather than global so tests,
 * CLI processes, and future Crew runtimes cannot leak services into each other.
 */
export class ServiceContainer {
  private readonly values = new Map<symbol, unknown>();

  /** Associates a created service value with its definition key. */
  set<T>(service: RuntimeService<T>, value: T): void {
    this.values.set(service.key, value);
  }

  /** Returns a service value or throws when it has not been registered. */
  get<T>(service: RuntimeService<T>): T {
    if (!this.values.has(service.key)) {
      throw new Error(unavailableServiceMessage);
    }

    return this.values.get(service.key) as T;
  }

  /** Checks whether a service value is currently registered. */
  has<T>(service: RuntimeService<T>): boolean {
    return this.values.has(service.key);
  }

  /** Removes all service values from the container. */
  clear(): void {
    this.values.clear();
  }
}

export { unavailableServiceMessage };
