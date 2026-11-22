import { ToolExecutionError, type ToolPipeline } from '@weave/runtime';
import { SkillAuditError } from './skill-errors.js';
import type { TurnSkillController } from './skill-turns.js';
/** This wrapper must stay outside isolated plugin observers and execute catches. */
export function withSkillAuditPipeline(
  base: ToolPipeline,
  controller: TurnSkillController,
): ToolPipeline {
  return {
    async execute(request) {
      if (request.name !== 'read_skill' && request.name !== 'read_skill_resource')
        return base.execute(request);
      if (request.sessionId === undefined || request.turnId === undefined)
        throw new ToolExecutionError('tool-invalid-input', 'The Skill turn scope is unavailable');
      const scope = {
        sessionId: request.sessionId,
        turnId: request.turnId,
        toolCallId: request.toolCallId,
      };
      let result;
      try {
        result = await base.execute(request);
      } catch (error: unknown) {
        if (request.signal?.aborted === true) throw error;
        // A failure recording a safe loader error must not become a recoverable
        // execute error, even if the base Pipeline translated the original throw.
        try {
          controller.pendingReceipt(scope);
        } catch (auditError: unknown) {
          if (auditError instanceof SkillAuditError) throw auditError;
        }
        throw error;
      }
      if (request.signal?.aborted === true)
        throw new ToolExecutionError('tool-cancelled', 'Skill read was cancelled');
      const receipt = controller.pendingReceipt(scope);
      if (
        receipt === undefined ||
        receipt.serialized !== result.content ||
        result.truncated ||
        result.name !== request.name ||
        result.toolCallId !== request.toolCallId
      )
        throw new SkillAuditError();
      await controller.commitReceipt(receipt, result);
      return result;
    },
  };
}
