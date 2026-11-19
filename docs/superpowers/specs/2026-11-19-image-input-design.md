# 图片输入（L4）设计

状态：草案（动码前）。基线 main `72f2433`。目标：用户可在 composer 附带图片（选择/粘贴），随消息发给支持视觉的模型，并在对话里显示。

## 范围

- `protocol`：消息内容新增 `image` 片段。
- `llm`：`openai-compatible` 把 image 片段按 OpenAI 视觉格式（`image_url` + data URL）发送。
- `runtime`：上下文估算 `token-estimate.ts` 为 image 片段加按条估值（见下）。
- `studio`：composer 附件（选择/粘贴图片）、发送时带上 image 片段、用户气泡渲染缩略图；重载（从会话详情投影）也能显示。
- `server`/`session`：无需改动——run 请求的 `userMessage` 用的是 protocol 的 `userMessageSchema`，消息内容加了 image 片段后自动接受并随投影持久化。

不碰：道 1 的审批/权限；其它 lane（L3 设置、L6-UI、L5 composer 交互）。注意本 lane 改 `App.tsx` 的 composer，与 L5 互斥（L5 未开工）。

## 契约

**`packages/protocol/src/content.ts`** 新增片段：
```
{ type: 'image', mediaType: string, data: string }
```
- `mediaType`：如 `image/png`、`image/jpeg`。
- `data`：base64（不带 `data:` 前缀）。
- 加入 `contentPartSchema` 判别联合。`messages.ts` 的 `contentSchema = array(contentPartSchema)` 自动让所有角色消息接受 image 片段。

`ContentPart` 类型同步加该分支。

## llm（`openai-compatible.ts`）

`toProviderMessage`：当消息含 image 片段时，`content` 发成数组：
- text 片段 → `{ type: 'text', text }`
- image 片段 → `{ type: 'image_url', image_url: { url: 'data:${mediaType};base64,${data}' } }`

无 image 片段时维持原样（`contentToText` 扁平成字符串，兼容 DeepSeek 等）。`contentToText` 仅处理 text（已忽略 reasoning），不受影响。

## runtime（`context/token-estimate.ts`）

`estimateMessageTokens` 原本对每个片段取 `part.text`。image 片段没有 `text`，加入判别联合后该访问不再对全联合成立（会被 TS 拦住，这正是跨包契约外溢的点）。改为：image 片段按固定 `imageOverheadTokens = 1024` 估值，其余片段仍走 `estimateTokens(part.text)`。真实图片 token 数随 provider 与分辨率分块变化，这里只做偏保守的粗估，确保上下文预算留在窗口安全一侧。

## studio

- `agent-types.ts` `userMessageSchema`：`content` 由「单个 text 的 tuple」改为「text|image 片段数组」。
- `ChatMessage` 新增 `images: readonly { mediaType; data }[]`。
- `messageImages(message)` 从内容抽 image 片段；`toChatMessages` 的 user 分支填充 `images`。
- 组合器状态 `pendingImages`：
  - 附件按钮（隐藏 `input[type=file] accept="image/*" multiple`）+ textarea 粘贴事件读取图片，`FileReader` 读成 base64，入 `pendingImages`（带缩略图 + 移除）。
  - 发送时把 `pendingImages` 转成 image 片段拼进 `userMessage.content`（文本在前、图片在后），本地 ChatMessage 也带 `images`；发送后清空。
  - 没有文本但有图片也允许发送。
- 渲染：用户气泡在正文下方显示图片缩略图（`src=data:${mediaType};base64,${data}`）；纯图片消息则只显示图片、不渲染空正文。点击缩略图弹出放大预览（固定遮罩 + 关闭按钮，点遮罩或 Esc 关闭）。
- Studio 不 import `node:`/`electron`；图片读取用浏览器 `FileReader`/`File`。

## 测试

- protocol：image 片段通过 schema；空 `data` 被拒；混合 text+image 的消息有效。
- llm：含 image 的消息 `toProviderMessage` 产出 `image_url`（data URL）数组；纯文本消息仍是字符串。
- runtime：`token-estimate` 现有用例覆盖，image 片段不再触发类型/运行期问题（粗估值计入）。
- studio：选择图片后发送，`streamAgentRun` 请求的 `userMessage.content` 含 image 片段、用户气泡渲染出 `img`、发送后组合器缩略图清空；仅图片（无文本）也能发送；重载路径（会话详情含 image 片段）也渲染；点击消息图片弹出放大预览，关闭按钮与 Esc 均可关闭。
- `pnpm check` 全绿。composer 的选择/粘贴附件与缩略图为单测覆盖，未做浏览器实测。

## 兼容性

- image 片段为新增；纯文本路径不变。
- 模型不支持视觉时，发送仍合法（provider 侧行为由模型决定）；本篇不做「按 Provider 能力禁用附件」，后续可加。
