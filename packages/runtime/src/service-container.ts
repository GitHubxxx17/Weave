import type { RuntimeService } from './types.js';

const unavailableServiceMessage = 'Runtime service is not available';

export class ServiceContainer {
  private readonly values = new Map<symbol, unknown>();

  set<T>(service: RuntimeService<T>, value: T): void {
    this.values.set(service.key, value);
  }

  get<T>(service: RuntimeService<T>): T {
    if (!this.values.has(service.key)) {
      throw new Error(unavailableServiceMessage);
    }

    return this.values.get(service.key) as T;
  }

  has<T>(service: RuntimeService<T>): boolean {
    return this.values.has(service.key);
  }

  clear(): void {
    this.values.clear();
  }
}

export { unavailableServiceMessage };
