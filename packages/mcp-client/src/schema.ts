import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { types } from 'node:util';
import { McpClientError } from './errors.js';
import { MCP_LIMITS } from './limits.js';
import type { McpValidationResult } from './types.js';

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}
interface JsonLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

const inputLimits = {
  maxBytes: MCP_LIMITS.maxInputBytes,
  maxDepth: MCP_LIMITS.maxInputDepth,
  maxNodes: MCP_LIMITS.maxInputNodes,
};
const schemaLimits = {
  maxBytes: MCP_LIMITS.maxSchemaBytes,
  maxDepth: MCP_LIMITS.maxSchemaDepth,
  maxNodes: MCP_LIMITS.maxSchemaNodes,
};
const resultLimits = {
  maxBytes: MCP_LIMITS.maxResultBytes,
  maxDepth: Number.MAX_SAFE_INTEGER,
  maxNodes: Number.MAX_SAFE_INTEGER,
};
const invalidInput: McpValidationResult = Object.freeze({
  valid: false,
  issue: 'MCP tool arguments do not match the declared schema.',
});

function failJson(): never {
  throw new McpClientError('mcp-invalid-input');
}

function unsupportedSchema(): never {
  throw new McpClientError('mcp-unsupported-schema');
}

/** Root depth is zero; every JSON value, including containers, is one node. */
function inspectJson(value: unknown, limits: JsonLimits): JsonValue {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();

  function addBytes(count: number): void {
    bytes += count;
    if (bytes > limits.maxBytes) failJson();
  }

  function stringBytes(text: string): void {
    addBytes(2);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) {
        addBytes(2);
      } else if (code < 32) {
        addBytes(6);
      } else if (code < 128) {
        addBytes(1);
      } else if (code < 2048) {
        addBytes(2);
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          addBytes(4);
          index++;
        } else {
          addBytes(6);
        }
      } else {
        addBytes(code >= 0xdc00 && code <= 0xdfff ? 6 : 3);
      }
    }
  }

  type VisitTask = {
    readonly value: unknown;
    readonly depth: number;
    readonly parent: JsonObject | JsonValue[];
    readonly key: string;
  };
  type Task = VisitTask | { readonly exit: object };
  const holder: JsonObject = {};
  const tasks: Task[] = [{ value, depth: 0, parent: holder, key: 'value' }];
  const assign = (task: VisitTask, result: JsonValue): void => {
    Object.defineProperty(task.parent, task.key, {
      value: result,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  };

  for (const limit of [limits.maxBytes, limits.maxDepth, limits.maxNodes]) {
    if (!Number.isSafeInteger(limit) || limit < 0) failJson();
  }
  while (tasks.length) {
    const task = tasks.pop()!;
    if ('exit' in task) {
      ancestors.delete(task.exit);
      continue;
    }
    const current = task.value;
    if (task.depth > limits.maxDepth || ++nodes > limits.maxNodes) failJson();
    if (current === null || typeof current === 'boolean') {
      addBytes(current === null || current === true ? 4 : 5);
      assign(task, current);
    } else if (typeof current === 'string') {
      stringBytes(current);
      assign(task, current);
    } else if (typeof current === 'number' && Number.isFinite(current)) {
      addBytes(String(current).length);
      assign(task, current);
    } else {
      if (
        typeof current !== 'object' ||
        current === null ||
        types.isProxy(current) ||
        ancestors.has(current)
      )
        failJson();
      ancestors.add(current);
      tasks.push({ exit: current });
      if (Array.isArray(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, 'length');
        const length: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
        if (
          Object.getPrototypeOf(current) !== Array.prototype ||
          typeof length !== 'number' ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > limits.maxNodes - nodes
        )
          failJson();
        addBytes(2 + Math.max(0, length - 1));
        const keys = Reflect.ownKeys(current);
        if (keys.length !== length + 1) failJson();
        const copy: JsonValue[] = [];
        assign(task, copy);
        for (let index = length - 1; index >= 0; index--) {
          const key = String(index);
          const item = Object.getOwnPropertyDescriptor(current, key);
          if (!item?.enumerable || !('value' in item)) failJson();
          tasks.push({ value: item.value, depth: task.depth + 1, parent: copy, key });
        }
      } else {
        const prototype: unknown = Object.getPrototypeOf(current);
        if (prototype !== null && prototype !== Object.prototype) failJson();
        const keys = Reflect.ownKeys(current);
        if (keys.length > limits.maxNodes - nodes) failJson();
        addBytes(2 + Math.max(0, keys.length - 1));
        const copy: JsonObject = {};
        assign(task, copy);
        for (const key of keys) {
          if (typeof key !== 'string') failJson();
          const property = Object.getOwnPropertyDescriptor(current, key);
          if (!property?.enumerable || !('value' in property)) failJson();
          stringBytes(key);
          addBytes(1);
          tasks.push({ value: property.value, depth: task.depth + 1, parent: copy, key });
        }
      }
    }
  }
  return holder.value!;
}

export function assertJsonValue(value: unknown, limits: JsonLimits): void {
  try {
    inspectJson(value, limits);
  } catch {
    failJson();
  }
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const jsonTypes = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const countKeywords = new Set([
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
]);
const numberKeywords = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']);

function inspectSchema(root: JsonObject, input: boolean): void {
  let branches = 0;
  if (input && root.type !== 'object') unsupportedSchema();

  function visit(value: JsonValue, compositionDepth: number, isRoot = false): void {
    if (typeof value === 'boolean') return;
    if (!isObject(value)) unsupportedSchema();
    for (const [keyword, argument] of Object.entries(value)) {
      if (countKeywords.has(keyword)) {
        if (typeof argument !== 'number' || !Number.isInteger(argument) || argument < 0)
          unsupportedSchema();
      } else if (numberKeywords.has(keyword)) {
        if (typeof argument !== 'number') unsupportedSchema();
      } else {
        switch (keyword) {
          case '$schema':
            if (!isRoot || argument !== 'https://json-schema.org/draft/2020-12/schema')
              unsupportedSchema();
            break;
          case 'type': {
            const types = Array.isArray(argument) ? argument : [argument];
            if (
              !types.length ||
              new Set(types).size !== types.length ||
              types.some((type) => typeof type !== 'string' || !jsonTypes.has(type))
            )
              unsupportedSchema();
            break;
          }
          case 'properties':
            if (!isObject(argument)) unsupportedSchema();
            for (const property of Object.values(argument)) visit(property, compositionDepth);
            break;
          case 'required':
            if (
              !Array.isArray(argument) ||
              argument.some((name) => typeof name !== 'string') ||
              new Set(argument).size !== argument.length
            )
              unsupportedSchema();
            break;
          case 'additionalProperties':
          case 'items':
            visit(argument, compositionDepth);
            break;
          case 'enum':
            if (!Array.isArray(argument)) unsupportedSchema();
            break;
          case 'multipleOf':
            if (typeof argument !== 'number' || argument <= 0) unsupportedSchema();
            break;
          case 'anyOf':
          case 'oneOf':
          case 'allOf':
          case 'not': {
            const children = keyword === 'not' ? [argument] : argument;
            if (!Array.isArray(children) || !children.length) unsupportedSchema();
            branches += children.length;
            if (
              branches > MCP_LIMITS.maxCompositionBranches ||
              compositionDepth >= MCP_LIMITS.maxCompositionDepth
            )
              unsupportedSchema();
            for (const child of children) visit(child, compositionDepth + 1);
            break;
          }
          case 'title':
          case 'description':
            if (typeof argument !== 'string') unsupportedSchema();
            break;
          case 'examples':
            if (!Array.isArray(argument)) unsupportedSchema();
            break;
          case 'deprecated':
          case 'readOnly':
          case 'writeOnly':
            if (typeof argument !== 'boolean') unsupportedSchema();
            break;
          case 'const':
          case 'default':
            break;
          default:
            unsupportedSchema();
        }
      }
    }
  }
  visit(root, 0, true);
}

const encodeKey = (key: string): string => `weave:${key}`;

// The SDK's bundled AJV omits properties.__proto__ and its equality helper
// special-cases valueOf/toString. Encode object keys injectively in both schemas
// and validation-only data copies to preserve JSON semantics for all own keys.
function encodeData(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  const root: JsonObject | JsonValue[] = Array.isArray(value) ? [] : {};
  const tasks = [{ source: value, target: root }];
  while (tasks.length) {
    const { source, target } = tasks.pop()!;
    for (const [key, child] of Object.entries(source)) {
      const resultKey = Array.isArray(source) ? key : encodeKey(key);
      if (child !== null && typeof child === 'object') {
        const copy: JsonObject | JsonValue[] = Array.isArray(child) ? [] : {};
        Object.defineProperty(target, resultKey, {
          value: copy,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        tasks.push({ source: child, target: copy });
      } else {
        Object.defineProperty(target, resultKey, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
  }
  return root;
}

function encodeSchema(schema: JsonValue): JsonValue {
  if (typeof schema === 'boolean') return schema;
  if (!isObject(schema)) unsupportedSchema();
  const copy: JsonObject = {};
  for (const [keyword, value] of Object.entries(schema)) {
    switch (keyword) {
      case 'properties': {
        if (!isObject(value)) unsupportedSchema();
        const properties: JsonObject = {};
        for (const [key, child] of Object.entries(value))
          properties[encodeKey(key)] = encodeSchema(child);
        copy[keyword] = properties;
        break;
      }
      case 'required':
        if (!Array.isArray(value)) unsupportedSchema();
        copy[keyword] = value.map((key) => encodeKey(String(key)));
        break;
      case 'items':
      case 'additionalProperties':
      case 'not':
        copy[keyword] = encodeSchema(value);
        break;
      case 'anyOf':
      case 'oneOf':
      case 'allOf':
        if (!Array.isArray(value)) unsupportedSchema();
        copy[keyword] = value.map(encodeSchema);
        break;
      case 'enum':
      case 'const':
        copy[keyword] = encodeData(value);
        break;
      default:
        copy[keyword] = value;
    }
  }
  return copy;
}

export function compileMcpSchema(
  schema: Readonly<Record<string, unknown>>,
  options?: { readonly input?: boolean },
): (input: unknown) => McpValidationResult {
  try {
    const inputPolicy = options?.input === true;
    const copy = inspectJson(schema, schemaLimits);
    if (!isObject(copy)) unsupportedSchema();
    inspectSchema(copy, inputPolicy);
    // A new provider also prevents cross-tool cache reuse; $id remains forbidden
    // because even a fresh provider has pre-registered meta-schema ids.
    const encodedSchema = encodeSchema(copy);
    const validate = new AjvJsonSchemaValidator().getValidator(
      encodedSchema as Parameters<AjvJsonSchemaValidator['getValidator']>[0],
    );
    if (validate.constructor.name === 'AsyncFunction') unsupportedSchema();
    return (input) => {
      try {
        const value = encodeData(inspectJson(input, inputPolicy ? inputLimits : resultLimits));
        const result = validate(value);
        return result.valid === true ? { valid: true } : invalidInput;
      } catch {
        return invalidInput;
      }
    };
  } catch {
    unsupportedSchema();
  }
}
