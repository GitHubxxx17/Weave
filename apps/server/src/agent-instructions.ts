import { execFile } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { defaultCommandShell, type ToolPermissionMode } from '@weave/runtime';

/** Largest part of a project's AGENTS.md included in the instructions. */
export const maxProjectInstructionsBytes = 32 * 1024;

/** The project's own instructions, read from AGENTS.md in its folder. */
export interface ProjectInstructions {
  readonly text: string;
  readonly truncated: boolean;
}

/** Host facts described to the model; injectable so tests stay deterministic. */
export interface AgentEnvironment {
  readonly platform: NodeJS.Platform;
  readonly shell: string;
  readonly now: () => Date;
  readonly gitBranch: (folder: string) => Promise<string | undefined>;
  readonly projectInstructions: (folder: string) => Promise<ProjectInstructions | undefined>;
}

/** The parts of a registered tool the instructions need. */
export interface InstructionTool {
  readonly name: string;
  readonly readOnly?: boolean | undefined;
}

function readGitBranch(folder: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      {
        cwd: folder,
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        timeout: 2000,
        windowsHide: true,
      },
      (error, stdout) => {
        const branch = error === null ? stdout.trim() : '';
        resolve(branch === '' || branch === 'HEAD' ? undefined : branch);
      },
    );
  });
}

/**
 * Reads `AGENTS.md` from the root of a project folder.
 *
 * The file must resolve inside the folder (a symlink cannot point elsewhere)
 * and only its first 32 KB are used, cut at a line break.
 */
export async function readProjectInstructions(
  folder: string,
): Promise<ProjectInstructions | undefined> {
  try {
    const root = await realpath(folder);
    const target = await realpath(path.join(root, 'AGENTS.md'));
    const relative = path.relative(root, target);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return undefined;
    }
    const metadata = await stat(target);
    if (!metadata.isFile()) {
      return undefined;
    }
    const handle = await open(target, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(metadata.size, maxProjectInstructionsBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      const truncated = metadata.size > maxProjectInstructionsBytes;
      if (truncated) {
        // Drop a character cut in half and the partial last line.
        text = text.replace(/\uFFFD+$/, '');
        const lastBreak = text.lastIndexOf('\n');
        if (lastBreak > 0) {
          text = text.slice(0, lastBreak);
        }
      }
      text = text.trim();
      return text === '' ? undefined : { text, truncated };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

const defaultEnvironment: AgentEnvironment = {
  platform: process.platform,
  shell: defaultCommandShell(),
  now: () => new Date(),
  gitBranch: readGitBranch,
  projectInstructions: readProjectInstructions,
};

function operatingSystemName(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return platform;
  }
}

function localDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const workspaceToolNames: ReadonlySet<string> = new Set([
  'list_dir',
  'glob',
  'grep',
  'read_file',
  'edit_file',
  'write_file',
  'run_command',
]);

/**
 * Builds the system instructions the default Weave Agent receives each run.
 *
 * Without them the model only sees the provider's generic default prompt and
 * cannot tell whether it has tools or which folder they operate on. The text
 * states what the Server knows for this Session: the tools of this run's
 * permission mode, how to use them, the host, the Project folder and its
 * AGENTS.md. Only facts that rarely change are included (the date, not the
 * time; the Git branch, not the working tree state), so the request prefix
 * stays stable and the provider's prompt cache keeps hitting. It never
 * includes secrets.
 */
export function createAgentInstructions(options: {
  readonly tools: () => readonly InstructionTool[];
  readonly resolveWorkspaceRoot?: ((sessionId: string) => Promise<string | undefined>) | undefined;
  readonly environment?: Partial<AgentEnvironment> | undefined;
}): (context: {
  readonly sessionId: string;
  readonly permissionMode?: ToolPermissionMode | undefined;
}) => Promise<string> {
  const environment: AgentEnvironment = { ...defaultEnvironment, ...options.environment };

  return async ({ sessionId, permissionMode = 'ask' }) => {
    const tools = options.tools();
    const names = new Set(tools.map((tool) => tool.name));
    const protectedNames = tools.filter((tool) => tool.readOnly !== true).map((tool) => tool.name);
    const usesWorkspace = tools.some((tool) => workspaceToolNames.has(tool.name));
    const folder =
      options.resolveWorkspaceRoot === undefined
        ? undefined
        : await options.resolveWorkspaceRoot(sessionId);

    const sections: string[] = [
      [
        '你是 Weave Agent，运行在用户本机的编程助手。请用用户使用的语言回答，最终回答写在正文中。',
        tools.length === 0
          ? '本轮没有可用的工具。'
          : `本轮可用的工具：${tools.map((tool) => tool.name).join('、')}。需要时直接调用，不要声称自己没有工具。`,
      ].join('\n'),
    ];

    const practices: string[] = [];
    const finders = ['list_dir', 'glob', 'grep'].filter((name) => names.has(name));
    if (finders.length > 0 && names.has('read_file')) {
      practices.push(
        `先用 ${finders.join('、')} 找到相关文件，再用 read_file 读需要的部分；read_file 只返回一部分时，结尾会给出下一页的 offset。互不依赖的只读调用可以在一次回复里同时发起。`,
      );
    }
    if (names.has('edit_file') && names.has('write_file')) {
      practices.push(
        '修改已有文件用 edit_file；新建文件用 write_file。除非用户要求，不要用 write_file 整体重写已有文件。',
      );
    }
    if (names.has('run_command')) {
      practices.push(
        '改完后用 run_command 运行相关的测试或检查，根据结果继续修正。不要启动不会自己结束的进程，例如开发服务器；命令默认 2 分钟超时。',
      );
    }
    if (tools.length > 0) {
      practices.push('工具返回错误时，根据错误信息调整后重试，或向用户说明原因。');
    }
    if (practices.length > 0) {
      sections.push(['工作方式：', ...practices.map((line) => `- ${line}`)].join('\n'));
    }

    if (protectedNames.length > 0) {
      const sandboxNote = names.has('run_command') ? '；命令不在沙箱中运行' : '';
      if (permissionMode === 'yolo') {
        sections.push(
          `权限：当前是"完全访问"模式，${protectedNames.join('、')} 都不需要确认、直接执行${sandboxNote}。请谨慎操作，破坏性改动不可撤销。`,
        );
      } else if (permissionMode === 'trust') {
        sections.push(
          `权限：当前是"信任"模式。本会话内常规改动会自动执行，只有高风险操作（删除、git push、sudo、联网等）才需要用户确认${sandboxNote}。`,
        );
      } else {
        sections.push(
          `权限：当前是"常规"模式。${protectedNames.join('、')} 每次都要用户在界面上确认${sandboxNote}。`,
        );
      }
    }

    const environmentLines = [
      `- 系统 ${operatingSystemName(environment.platform)}，Shell ${environment.shell}，今天是 ${localDate(environment.now())}`,
    ];
    if (usesWorkspace) {
      if (folder === undefined) {
        environmentLines.push(
          '- 当前项目还没有设置文件夹，文件工具调用会失败。用户询问读写文件时，请提示他在项目菜单中选择"设置文件夹"。',
        );
      } else {
        const branch = await environment.gitBranch(folder);
        environmentLines.push(
          `- 当前项目文件夹：${folder}${branch === undefined ? '' : `，Git 分支 ${branch}`}`,
          '- 工具参数里的 path 使用相对这个文件夹的路径，例如 README.md 或 src/index.ts，不要传绝对路径。',
        );
      }
    }
    sections.push(['环境：', ...environmentLines].join('\n'));

    if (names.has('recall')) {
      sections.push(
        '较早的对话可能被压缩成骨架摘要，其中的工具结果会标注 [recall id=...]。需要被省略的原文时，调用 recall 工具（传 toolCallId 或 path）取回完整内容，不要臆测。',
      );
    }

    if (folder !== undefined) {
      const project = await environment.projectInstructions(folder);
      if (project !== undefined) {
        sections.push(
          [
            '项目说明（来自项目根目录的 AGENTS.md，请遵守其中的约定）：',
            project.text,
            ...(project.truncated ? ['[AGENTS.md 超过 32 KB，后面的内容没有包含]'] : []),
          ].join('\n'),
        );
      }
    }

    return sections.join('\n\n');
  };
}
