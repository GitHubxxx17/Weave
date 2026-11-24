import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/main.js';
import { approvalBrokerService, getServerSessionStore } from '../src/runtime.js';

/** One SSE frame as sent by the Server; `data` is the parsed JSON payload. */
export interface ContractFrame {
  readonly id?: string;
  readonly event: string;
  readonly data: unknown;
}

/** Neutral captures of the real Server HTTP responses that Studio mirrors by hand. */
export interface HttpContractFixtures {
  readonly workspace: Record<string, unknown>;
  readonly execution: Record<string, unknown>;
  readonly queue: Record<string, unknown>;
  readonly approvals: Record<string, unknown>;
  readonly tasks: Record<string, unknown>;
}

function parseFrame(text: string): ContractFrame {
  let id: string | undefined;
  let event = 'message';
  const data: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('id: ')) id = line.slice(4);
    else if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  return { ...(id === undefined ? {} : { id }), event, data: JSON.parse(data.join('\n')) };
}

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const timestampPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const taskCursorPattern = /[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{43}/g;

/**
 * Replaces values that differ on every run (random ids, wall clock, signed
 * cursors, temporary paths, prompt-size token counts) with stable ones that
 * keep their syntax and cross-references, so Studio schemas still validate.
 */
export function neutralizeContract<T>(value: T, temporaryDirectory: string): T {
  const ids = new Map<string, string>();
  const neutralId = (id: string) => {
    let mapped = ids.get(id);
    if (mapped === undefined) {
      mapped = `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`;
      ids.set(id, mapped);
    }
    return mapped;
  };
  const string = (text: string) =>
    text
      .replaceAll(temporaryDirectory, '/contract')
      .replace(uuidPattern, neutralId)
      .replace(timestampPattern, '2026-11-24T00:00:00.000Z')
      .replace(taskCursorPattern, `${'C'.repeat(40)}.${'S'.repeat(43)}`);
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return string(node);
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== 'object' || node === null) return node;
    const entries = Object.entries(node).map(([key, child]) => [key, walk(child)] as const);
    const result: Record<string, unknown> = Object.fromEntries(entries);
    const categories = result.categories;
    if (
      typeof result.windowTokens === 'number' &&
      typeof categories === 'object' &&
      categories !== null
    ) {
      // Prompt size depends on the current system prompt and tool descriptions.
      const fixed = { ...categories, system: 900, tools: 4800 } as Record<string, number>;
      const sent = Object.values(fixed).reduce((sum, count) => sum + count, 0);
      Object.assign(result, {
        categories: fixed,
        sentTokens: sent,
        ratio: sent / result.windowTokens,
      });
    }
    return result;
  };
  return walk(value) as T;
}

function reply(value: string | { readonly name: string; readonly arguments: object }): Response {
  const call = typeof value !== 'string';
  const chunk = {
    id: 'chatcmpl-contract',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'contract',
    choices: [
      {
        index: 0,
        delta: call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-contract',
                  type: 'function',
                  function: { name: value.name, arguments: JSON.stringify(value.arguments) },
                },
              ],
            }
          : { content: value },
        finish_reason: null,
      },
    ],
  };
  const final = {
    ...chunk,
    choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
  };
  return new Response(
    `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function lastUserText(body: { messages: { role: string; content: unknown }[] }): string {
  const last = body.messages.filter((message) => message.role === 'user').at(-1);
  if (typeof last?.content === 'string') return last.content;
  return JSON.stringify(last?.content);
}

/** Reads up to `count` SSE frames (or until the stream ends), then cancels the stream. */
async function readFrames(response: Response, count: number): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: string[] = [];
  try {
    while (frames.length < count) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0 && frames.length < count) {
        frames.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel();
  }
  return frames;
}

/**
 * Drives one real Server (HTTP, SQLite, Runtime, Approval broker, Agent tasks)
 * through the first-batch contract scenario and returns the raw responses.
 * Provider output is scripted; every other layer is the production composition.
 */
export async function captureHttpContract(): Promise<HttpContractFixtures> {
  const directory = await mkdtemp(join(tmpdir(), 'weave-http-contract-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'notes.txt'), 'contract');
  const gates: (() => void)[] = [];
  const calls = new Map<string, number>();
  const fakeFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: unknown }[];
    };
    const prompt = lastUserText(body);
    const step = calls.get(prompt) ?? 0;
    calls.set(prompt, step + 1);
    if (prompt.startsWith('block')) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
        init?.signal?.addEventListener('abort', abort, { once: true });
        gates.push(resolve);
        if (init?.signal?.aborted) abort();
      });
      return reply('released');
    }
    if (prompt === 'Delegate one review.') {
      if (step === 0)
        return reply({
          name: 'agent_spawn',
          arguments: { title: 'Workspace review', prompt: 'Workspace child.', access: 'workspace' },
        });
      return reply('Delegated.');
    }
    if (prompt === 'Workspace child.' && step === 0)
      return reply({
        name: 'write_file',
        arguments: { path: 'review.txt', content: 'review' },
      });
    return reply('Done.');
  };
  const server = await startServer(0, {
    databaseFile: join(directory, 'state.db'),
    pluginsDirectory: false,
    skillsDirectory: false,
    fetch: fakeFetch,
    environment: {
      WEAVE_LLM_PROVIDERS: JSON.stringify([
        {
          id: 'contract',
          label: 'Contract',
          type: 'openai-compatible',
          baseUrl: 'https://fixture.invalid/v1',
          apiKey: 'fixture-only',
          defaultModel: 'contract',
        },
      ]),
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const getJson = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    if (response.status !== 200) throw new Error(`${path} ${response.status}`);
    return (await response.json()) as unknown;
  };
  const launch = async (sessionId: string, text: string) => {
    const response = await post(`/sessions/${sessionId}/executions`, {
      requestId: randomUUID(),
      input: {
        provider: 'contract',
        model: 'contract',
        permissionMode: 'ask',
        userMessage: { role: 'user', content: [{ type: 'text', text }] },
      },
    });
    if (response.status !== 202) throw new Error(`launch ${response.status}`);
    return (await response.json()) as { executionId: string };
  };
  const poll = async (check: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for contract scenario state');
  };
  try {
    const store = getServerSessionStore(server.runtime);
    const project = (await (
      await post('/projects', { name: 'Contract', folderName: 'contract', folderPath: workspace })
    ).json()) as { id: string };
    const parent = (await (await post(`/projects/${project.id}/sessions`, {})).json()) as {
      id: string;
    };
    // Parent delegates one workspace task whose child waits on a write approval.
    const delegated = await launch(parent.id, 'Delegate one review.');
    const broker = server.runtime.get(approvalBrokerService);
    await poll(() => broker.list().some((item) => item.status === 'pending'));
    await poll(async () =>
      (await store.read(parent.id)).some((event) => event.type === 'execution.finished'),
    );
    const approvalsStream = await fetch(`${base}/approvals/stream`);
    const approvalFrames = await readFrames(approvalsStream, 1);
    const tasks = await getJson(`/sessions/${parent.id}/tasks`);

    // Second Session: one active (blocked at the provider) and two queued entries.
    const second = (await (await post(`/projects/${project.id}/sessions`, {})).json()) as {
      id: string;
    };
    await launch(second.id, 'block-one');
    await poll(() => gates.length === 1);
    await launch(second.id, 'block-two');
    await launch(second.id, 'block-three');
    const queue = await getJson(`/sessions/${second.id}/executions/queue`);
    const queueFrames = await readFrames(
      await fetch(`${base}/sessions/${second.id}/executions/queue/events`),
      1,
    );
    // Live frames: subscribe while the active execution waits at the provider,
    // then release it so the stream carries event and status frames to its end.
    const activeId = (queue as { active: { executionId: string } }).active.executionId;
    const live = await fetch(`${base}/sessions/${second.id}/executions/${activeId}/events`);
    const liveFrames = readFrames(live, 64);
    await new Promise((resolve) => setTimeout(resolve, 100));
    gates[0]!();
    const executionFrames = await liveFrames;

    const taskId = (tasks as { tasks: { taskId: string }[] }).tasks[0]!.taskId;
    const frames = (texts: readonly string[]) => texts.map(parseFrame);
    return neutralizeContract(
      {
        workspace: {
          projects: await getJson('/projects'),
          sessionDetail: await getJson(`/sessions/${parent.id}`),
        },
        execution: {
          list: await getJson(`/sessions/${parent.id}/executions`),
          snapshot: await getJson(`/sessions/${second.id}/executions/${activeId}`),
          delegatedSnapshot: await getJson(
            `/sessions/${parent.id}/executions/${delegated.executionId}`,
          ),
          frames: frames(executionFrames),
        },
        queue: { snapshot: queue, frames: frames(queueFrames) },
        approvals: { list: await getJson('/approvals'), frames: frames(approvalFrames) },
        tasks: { tree: tasks, task: await getJson(`/sessions/${parent.id}/tasks/${taskId}`) },
      },
      directory,
    );
  } finally {
    for (const release of gates) release();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
}
