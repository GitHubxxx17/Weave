import type { Message, ToolDefinition } from '@weave/protocol';

/** Per-message framing overhead (role, delimiters) in estimated tokens. */
const messageOverheadTokens = 4;

/**
 * Flat estimate for one image part. Real image token cost depends on the
 * provider and the resolution tiling, which this heuristic does not model; a
 * deliberately high constant keeps the budget on the safe side of the window.
 */
const imageOverheadTokens = 1024;

/**
 * Approximate token count for a string, without a tokenizer dependency.
 *
 * CJK and other full-width characters are counted as ~1 token each; other
 * characters (ASCII letters, digits, punctuation, code) as ~0.25. The result
 * is rounded up. It is deliberately a slight over-estimate so the budget stays
 * on the safe side of the real context window.
 */
export function estimateTokens(text: string): number {
  if (text === '') {
    return 0;
  }
  let weighted = 0;
  for (const char of text) {
    weighted += isWideCharacter(char) ? 1 : 0.25;
  }
  return Math.ceil(weighted);
}

/** True for characters that a tokenizer typically spends a whole token on. */
function isWideCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }
  // CJK, Hiragana/Katakana, Hangul, and CJK-range full-width punctuation.
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) || // CJK radicals .. Unified
    (codePoint >= 0xa960 && codePoint <= 0xa97f) || // Hangul Jamo Extended-A
    (codePoint >= 0xac00 && codePoint <= 0xd7ff) || // Hangul Syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility Ideographs
    (codePoint >= 0xff00 && codePoint <= 0xffef) || // Halfwidth/Fullwidth Forms
    (codePoint >= 0x20000 && codePoint <= 0x3ffff) // CJK Extension B+
  );
}

/** Estimated tokens for one message, including role framing and tool calls. */
export function estimateMessageTokens(message: Message): number {
  let total = messageOverheadTokens;
  for (const part of message.content) {
    total += part.type === 'image' ? imageOverheadTokens : estimateTokens(part.text);
  }
  if (message.role === 'assistant' && message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      total += estimateTokens(call.name) + estimateTokens(call.arguments) + messageOverheadTokens;
    }
  }
  return total;
}

/** Estimated tokens for the model-visible tool definitions block. */
export function estimateToolsTokens(tools: readonly ToolDefinition[] | undefined): number {
  if (tools === undefined || tools.length === 0) {
    return 0;
  }
  let total = 0;
  for (const tool of tools) {
    total +=
      estimateTokens(tool.name) +
      estimateTokens(tool.description) +
      estimateTokens(JSON.stringify(tool.parameters ?? {})) +
      messageOverheadTokens;
  }
  return total;
}
