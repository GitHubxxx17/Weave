import { createHash } from 'node:crypto';
import {
  managedRequestSchema,
  PluginAuthorityError,
  type ManagedRequest,
} from './plugin-authority-types.js';

export interface CanonicalManagedRequest {
  readonly request: ManagedRequest;
  readonly canonicalCommand: string;
  readonly fingerprint: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function invalidJson(): never {
  throw new TypeError('Authority data must contain only plain JSON values');
}

function cloneJson(input: unknown, ancestors: Set<object>): JsonValue {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
  if (typeof input === 'number') return Number.isFinite(input) ? input : invalidJson();
  if (typeof input !== 'object' || ancestors.has(input)) return invalidJson();
  const array = Array.isArray(input);
  const prototype: unknown = Object.getPrototypeOf(input);
  if (
    array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
  ) {
    return invalidJson();
  }
  ancestors.add(input);
  try {
    if (array) {
      const keys = Reflect.ownKeys(input);
      if (keys.length !== input.length + 1) return invalidJson();
      const result: JsonValue[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          return invalidJson();
        }
        result.push(cloneJson(descriptor.value, ancestors));
      }
      return result;
    }
    const result: { [key: string]: JsonValue } = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string') return invalidJson();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return invalidJson();
      }
      if (descriptor.value !== undefined) {
        Object.defineProperty(result, key, {
          value: cloneJson(descriptor.value, ancestors),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return result;
  } finally {
    ancestors.delete(input);
  }
}

function withInvalidData<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    if (error instanceof PluginAuthorityError) throw error;
    throw new PluginAuthorityError(
      'plugin-authority-invalid',
      'Plugin authority input is invalid',
      {
        cause: error,
      },
    );
  }
}

function encodeCanonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encodeCanonical(value[key]!)}`)
    .join(',')}}`;
}

export function canonicalJson(input: unknown): string {
  return withInvalidData(() => encodeCanonical(cloneJson(input, new Set())));
}

function freezeJson(value: JsonValue): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
}

/** Clone first so freezing a returned authority value never freezes its caller. */
export function detachAndFreeze<T>(value: T): T {
  return withInvalidData(() => {
    const detached = cloneJson(value, new Set());
    freezeJson(detached);
    return detached as T;
  });
}

export function canonicalizeManagedRequest(input: unknown): CanonicalManagedRequest {
  return withInvalidData(() => {
    // Check raw data before Zod can normalize prototypes or invoke accessors.
    // Parse the original afterward so unknown keys with undefined still reject.
    cloneJson(input, new Set());
    const request = managedRequestSchema.parse(input);
    const canonicalCommand = canonicalJson({ version: 1, command: request.command });
    return detachAndFreeze({
      request,
      canonicalCommand,
      fingerprint: createHash('sha256').update(canonicalCommand, 'utf8').digest('hex'),
    });
  });
}
