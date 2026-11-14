import { createMockLlmClient } from '@weave/llm';
import type { StreamEvent } from '@weave/protocol';
import { createRuntime, type Runtime, type RuntimeService } from '@weave/runtime';

const mockLlmService: RuntimeService<unknown> = {
  key: Symbol('weave.server.mock-llm'),
  create: () => {
    const script: readonly StreamEvent[] = [];
    return createMockLlmClient(script);
  },
};

/**
 * Assembles the services used by the local server entry point.
 *
 * The default server intentionally uses a Mock LLM so startup and health
 * checks remain deterministic and do not require provider credentials.
 */
export function createServerRuntime(): Runtime {
  return createRuntime({ services: [mockLlmService] });
}
