import {
  agentTaskCancelInputSchema,
  agentTaskSpawnInputSchema,
  agentTaskStatusInputSchema,
  agentTaskWaitInputSchema,
  type AgentTaskCancelInput,
  type AgentTaskSpawnInput,
  type AgentTaskStatusInput,
  type AgentTaskWaitInput,
} from '@weave/protocol';
import { agentTaskFactDigest } from '@weave/session';
import { z } from 'zod';
import type { AgentTaskObserver } from './agent-task-observer.js';
import type { AgentTaskEnvelope } from './agent-task-result.js';
import { AgentTaskError, type AgentTaskService } from './agent-task-service.js';
import {
  readAgentToolAuthority,
  type AgentToolInvocationAuthority,
} from './agent-tool-authority.js';
import type { ToolDefinition, ToolExecutionContext } from './tool-types.js';

interface AgentTaskToolsOptions {
  readonly service: Pick<AgentTaskService, 'spawn' | 'requestCancel'>;
  readonly observer: Pick<AgentTaskObserver, 'status' | 'wait'>;
}

export interface AgentTaskTools {
  readonly spawn: ToolDefinition<AgentTaskSpawnInput, AgentTaskEnvelope>;
  readonly status: ToolDefinition<AgentTaskStatusInput, AgentTaskEnvelope>;
  readonly wait: ToolDefinition<AgentTaskWaitInput, AgentTaskEnvelope>;
  readonly cancel: ToolDefinition<AgentTaskCancelInput, AgentTaskEnvelope>;
}

function requireInvocation(
  context: ToolExecutionContext,
  name: string,
): AgentToolInvocationAuthority {
  try {
    const invocation = readAgentToolAuthority(context);
    if (invocation.toolName === name) return invocation;
  } catch {
    // Only a live Pipeline invocation grants access to its root task tree.
  }
  throw new AgentTaskError(
    'agent-task-not-permitted',
    'Agent task tool requires a running root invocation',
  );
}

export function createAgentTaskTools({ service, observer }: AgentTaskToolsOptions): AgentTaskTools {
  return {
    spawn: {
      name: 'agent_spawn',
      description:
        'Start a one-shot child agent with its own session. Give it a self-contained prompt. Read-only is the default. Request workspace access explicitly when the child needs to edit the shared Project folder. Existing approval rules still apply to child tools.',
      parameters: z.toJSONSchema(agentTaskSpawnInputSchema, { io: 'input' }),
      inputSchema: agentTaskSpawnInputSchema,
      readOnly: false,
      async execute(input, context) {
        const { identity } = requireInvocation(context, 'agent_spawn');
        const { taskId } = await service.spawn(input, context);
        return observer.status(identity.sessionId, { taskIds: [taskId] });
      },
    },
    status: {
      name: 'agent_status',
      description:
        'Read child task status, approvals, and available result previews. Pass up to four task IDs for detail, or omit IDs to paginate tasks. A detail cursor can be used with agent_wait for the same task IDs.',
      parameters: z.toJSONSchema(agentTaskStatusInputSchema, { io: 'input' }),
      inputSchema: agentTaskStatusInputSchema,
      readOnly: true,
      execute(input, context) {
        const { identity } = requireInvocation(context, 'agent_status');
        return observer.status(identity.sessionId, input);
      },
    },
    wait: {
      name: 'agent_wait',
      description:
        'Wait for up to four child tasks to settle or need a new approval. The default wait is 30 seconds, and timeoutMs 0 reads the current snapshot. A timeout leaves tasks running. Reuse after only for the same task IDs. When allSettled is true, do not wait again for this group.',
      parameters: z.toJSONSchema(agentTaskWaitInputSchema, { io: 'input' }),
      inputSchema: agentTaskWaitInputSchema,
      readOnly: true,
      execute(input, context) {
        const { identity } = requireInvocation(context, 'agent_wait');
        return observer.wait(identity.sessionId, input, context.signal);
      },
    },
    cancel: {
      name: 'agent_cancel',
      description:
        'Request cancellation for up to four child tasks. Returns their current state while cleanup continues. Use agent_status or agent_wait to observe settlement.',
      parameters: z.toJSONSchema(agentTaskCancelInputSchema, { io: 'input' }),
      inputSchema: agentTaskCancelInputSchema,
      readOnly: false,
      async execute(input, context) {
        const { identity, toolCallId } = requireInvocation(context, 'agent_cancel');
        const operationId = agentTaskFactDigest({
          parentSessionId: identity.sessionId,
          parentTurnId: identity.turnId,
          toolCallId,
        });
        await service.requestCancel(
          identity.sessionId,
          input.taskIds,
          operationId,
          'task-cancelled',
        );
        return observer.status(identity.sessionId, { taskIds: input.taskIds });
      },
    },
  };
}
