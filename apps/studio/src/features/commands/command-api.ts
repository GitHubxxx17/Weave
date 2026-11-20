import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import { commandListSchema, type SlashCommand } from './command-types.js';

/** A typed failure from the Studio command client. */
export class CommandApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CommandApiError';
  }
}

/** Loads the slash commands plugins contribute to the Agent (`GET /commands`). */
export async function fetchCommands(signal?: AbortSignal): Promise<readonly SlashCommand[]> {
  let response: Response;
  try {
    response = await fetch(runtimeApiUrl('/commands'), {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      throw error;
    }
    throw new CommandApiError('command-network', '无法连接到本地服务', 0);
  }
  if (!response.ok) {
    throw new CommandApiError('command-request-failed', '读取命令列表失败', response.status);
  }
  const payload: unknown = await response.json().catch(() => undefined);
  const parsed = commandListSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CommandApiError(
      'command-invalid-response',
      '命令列表的响应格式不正确',
      response.status,
    );
  }
  return parsed.data.commands;
}
