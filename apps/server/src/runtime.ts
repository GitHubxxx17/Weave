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

export function createServerRuntime(): Runtime {
  return createRuntime({ services: [mockLlmService] });
}
