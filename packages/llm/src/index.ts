export type { LlmClient } from './client.js';
export { createLlmError } from './errors.js';
export { createMockLlmClient, createToolCommandMockLlmClient } from './mock-client.js';
export type { ToolCommandMockOptions } from './mock-client.js';
export { createOpenAiCompatibleClient } from './openai-compatible.js';
export type { OpenAiCompatibleClientOptions } from './openai-compatible.js';
export { createLlmProviderRegistry } from './provider-registry.js';
export type {
  LlmProviderDescriptor,
  LlmProviderRegistration,
  LlmProviderRegistry,
  LlmProviderType,
} from './provider-registry.js';
export {
  createSseParserState,
  decodeSseChunks,
  flushSseParser,
  pushSseChunk,
} from './sse-parser.js';
export type {
  LlmError,
  LlmErrorCode,
  LlmRequest,
  LlmStreamOptions,
  ParsedSseFrame,
  SseParserState,
  StreamEvent,
} from './types.js';

export { createOpenAiEmbeddingClient, describeOpenAiEmbeddingBatches } from './openai-embedding.js';
export type { OpenAiEmbeddingClientOptions } from './openai-embedding.js';
export type {
  EmbeddingBatch,
  EmbeddingClient,
  EmbeddingInput,
  EmbeddingVector,
} from './embedding-types.js';
