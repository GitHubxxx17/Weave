/**
 * Builds the system instructions the default Weave Agent receives each run.
 *
 * Without them the model only sees the provider's generic default prompt and
 * cannot tell whether it has tools or which folder they operate on, so it
 * tends to claim it has no file access. The text states the facts the Server
 * knows for this Session: the tool names and whether a Project folder is set.
 * It never includes file content or secrets.
 */
export function createAgentInstructions(options: {
  readonly toolNames: () => readonly string[];
  readonly resolveWorkspaceRoot?: ((sessionId: string) => Promise<string | undefined>) | undefined;
}): (context: { readonly sessionId: string }) => Promise<string> {
  return async ({ sessionId }) => {
    const toolNames = options.toolNames();
    const hasFileTools = toolNames.includes('read_file') || toolNames.includes('write_file');
    const hasRecall = toolNames.includes('recall');
    const folder =
      options.resolveWorkspaceRoot === undefined
        ? undefined
        : await options.resolveWorkspaceRoot(sessionId);

    const lines = [
      '你是 Weave Agent，运行在用户本机的编程助手。请用用户使用的语言回答，最终回答写在正文中。',
      toolNames.length === 0
        ? '本轮没有可用的工具。'
        : `本轮可用的工具：${toolNames.join('、')}。需要时直接调用，不要声称自己没有工具。`,
    ];

    if (hasFileTools) {
      lines.push(
        folder === undefined
          ? '当前项目还没有设置文件夹，文件工具调用会失败。用户询问读写文件时，请提示他在项目菜单中选择"设置文件夹"。'
          : [
              `当前项目文件夹：${folder}。`,
              'read_file 和 write_file 的 path 参数使用相对这个文件夹的路径，例如 README.md 或 src/index.ts，不要传绝对路径。',
              'write_file 默认不覆盖已有文件，覆盖时需要传 overwrite: true；每次写入都要等用户在界面上确认。',
              '工具返回错误时，根据错误信息调整后重试，或向用户说明原因。',
            ].join('\n'),
      );
    }

    if (hasRecall) {
      lines.push(
        '较早的对话可能被压缩成骨架摘要，其中的工具结果会标注 [recall id=...]。需要被省略的原文时，调用 recall 工具（传 toolCallId 或 path）取回完整内容，不要臆测。',
      );
    }

    return lines.join('\n');
  };
}
