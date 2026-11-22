import { randomUUID } from 'node:crypto';
import {
  agentExecutionSnapshotSchema,
  type AgentRunRequest,
  type AgentRuntimeEvent,
  type Runtime,
} from '@weave/runtime';
import { getServerSessionStore } from '../src/runtime.js';

/** Real acceptance and detachable SSE, shared by loopback integration fixtures. */
export async function openExecutionStream(
  server: { readonly port: number },
  request: AgentRunRequest,
) {
  const { sessionId, signal: _signal, executionIdentity: _identity, ...settings } = request;
  void _signal;
  void _identity;
  const accepted = await fetch(`http://127.0.0.1:${server.port}/sessions/${sessionId}/executions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: randomUUID(),
      input: { ...settings, permissionMode: request.permissionMode ?? 'ask' },
    }),
  });
  if (accepted.status !== 202)
    throw new Error(`Execution acceptance ${accepted.status}: ${await accepted.text()}`);
  const receipt = agentExecutionSnapshotSchema.parse(await accepted.json());
  const response = await fetch(
    `http://127.0.0.1:${server.port}/sessions/${sessionId}/executions/${receipt.executionId}/events?after=${encodeURIComponent(receipt.cursor)}`,
  );
  if (response.status !== 200)
    throw new Error(`Execution subscribe ${response.status}: ${await response.text()}`);
  return { receipt, response };
}

/** These existing fixtures assert tool/provenance output. Project the owned
 * durable Turn after its SSE ends, since fast execution may finish before GET. */
export async function runExecutionToLegacyResponse(
  server: { readonly port: number; readonly runtime: Runtime },
  request: AgentRunRequest,
): Promise<Response> {
  const { receipt, response } = await openExecutionStream(server, request);
  await response.text();
  const events = await getServerSessionStore(server.runtime).read(request.sessionId);
  const start = events.findIndex(
    (event) => event.type === 'turn.started' && event.payload.turnId === receipt.turnId,
  );
  const output: AgentRuntimeEvent[] = [];
  for (const event of events.slice(start + 1)) {
    if (event.type === 'turn.completed' && event.payload.turnId === receipt.turnId) {
      if (event.payload.status !== 'completed')
        throw new Error(`Fixture execution ${event.payload.status}: ${event.payload.reason ?? ''}`);
      output.push({ type: 'completed', turnId: receipt.turnId });
      break;
    }
    if (event.type === 'message.created' && event.payload.message.role === 'assistant') {
      for (const part of event.payload.message.content) {
        if (part.type === 'text') output.push({ type: 'text-delta', text: part.text });
        if (part.type === 'reasoning') output.push({ type: 'reasoning-delta', text: part.text });
      }
    } else if (event.type === 'tool-result.created' && event.payload.turnId === receipt.turnId) {
      const { toolCallId, name, content, truncated, status, errorCode } = event.payload;
      output.push({
        type: 'tool-result',
        result: { toolCallId, name, content, truncated },
        status,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    }
  }
  if (!output.some((event) => event.type === 'completed'))
    throw new Error('Owned execution did not complete');
  return new Response(
    output.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
