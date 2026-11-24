import type { AgentRunner } from '@weave/runtime';

/** Input accepted by `AgentRunner.run`, minus the abort signal supplied by the helper. */
export type AgentRunInput = Omit<Parameters<AgentRunner['run']>[0], 'signal'>;

/**
 * Drives one Agent turn directly through an AgentRunner, without an HTTP route.
 *
 * Tests that cover Tool Pipeline, Plugin or workspace behavior use this in
 * compositions that have no AgentExecutionService. Events are rendered as
 * `event: <type>\ndata: <json>\n\n` frames so assertions keep reading the event
 * sequence the runner emitted. A thrown runner error becomes a final `error`
 * frame with its `code` and `message`, as a consumer would observe it.
 */
export async function runAgentTurn(runner: AgentRunner, input: AgentRunInput): Promise<string> {
  let body = '';
  try {
    for await (const event of runner.run({ ...input, signal: new AbortController().signal })) {
      body += `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    }
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'error';
    const message = error instanceof Error ? error.message : 'Agent run failed';
    body += `event: error\ndata: ${JSON.stringify({ error: { code, message } })}\n\n`;
  }
  return body;
}
