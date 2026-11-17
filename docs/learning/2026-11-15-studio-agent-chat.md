# Weave Studio Agent Chat 学习说明

这篇文档面向前后端基础较好、但第一次做 Agent 产品的开发者。目标不是
介绍 React 或 SSE 的全部细节，而是解释一个最小 Agent 产品如何把
Runtime、HTTP、浏览器流和 UI 状态连接起来。

本阶段的链路是：

```text
Browser Studio
  -> fetch POST /agent/runs/stream
  -> Server HTTP/SSE adapter
  -> Runtime AgentRunner
  -> LlmClient / ToolPipeline / SessionEventStore
```

Studio 是第一个可以用浏览器观察 Agent 的工作台，但它不是 Runtime 的
替代品，也还不是完整的 Weave 产品。

## 1. 为什么 Studio 不导入 Runtime

`apps/studio` 是浏览器应用，`packages/runtime` 是 Node 侧的 Agent 领域
运行时。两者的职责不同：

```text
Studio
  负责输入、展示、取消和本地临时 UI 状态

Server
  负责 HTTP 输入校验、SSE 编码和请求生命周期适配

Runtime
  负责模型调用、工具执行、Session 恢复和生命周期持久化
```

如果 Studio 直接导入 Runtime，会产生几个问题：

1. 浏览器会被迫理解 Node、文件系统、Session Store 或 Provider 的依赖；
2. UI 可能绕过 Server 和 Tool Pipeline，形成另一套 Agent Loop；
3. Runtime 的内部实现会变成前端的耦合协议，后续替换运行时成本很高；
4. 浏览器无法安全地直接获得 Workspace、工具执行和密钥相关能力。

因此 Studio 只依赖公开的 HTTP/SSE 契约。它知道请求字段和
`AgentRuntimeEvent` 的可展示形状，但不知道 Runtime 如何调用模型、如何
执行工具，也不直接写 Session。

这是一个典型的边界设计：

```text
浏览器边界: HTTP request / SSE response
领域边界:   AgentRunRequest / AgentRuntimeEvent
基础设施边界: LlmClient / SessionEventStore / ToolPipeline
```

这样做也便于测试。前端可以 mock `fetch` 或 `streamAgentRun()`，Runtime
可以直接测试 Agent Loop，Server 可以测试 HTTP adapter，三层不需要启动
同一个进程才能验证各自的行为。

## 2. 为什么使用 fetch + ReadableStream

当前接口是：

```text
POST /agent/runs/stream
Content-Type: application/json
Accept: text/event-stream
```

`EventSource` 适合订阅一个 GET SSE 地址，但它不适合当前的 Agent Turn：

- Agent 请求需要 JSON body；
- body 中包含 Session、用户消息、Provider 和模型；
- 原生 `EventSource` 不提供发送 POST body 的接口；
- `EventSource` 的自动重连语义不适合当前还没有 Run Registry 的短生命周期请求。

`fetch()` 可以同时满足两个需求：

1. 用 `POST` 和 JSON body 提交一次 Agent 请求；
2. 从 `Response.body` 获取 `ReadableStream<Uint8Array>`，边接收边渲染。

Studio 的 `agent-stream.ts` 负责传输层工作，React 的 `App.tsx` 只接收
已经校验过的事件：

```text
fetch
  -> Response.body.getReader()
  -> TextDecoder
  -> SSE frame parser
  -> Zod event validation
  -> AgentRuntimeEvent
  -> React state update
```

`fetch()` 不会自动解析 SSE。浏览器只负责给出字节流，SSE 事件边界、JSON
解析、事件类型校验和终止语义都需要应用层实现。

## 3. UTF-8 chunk 和 SSE frame 不是一回事

这是流式开发中最容易混淆的两个边界。

### 3.1 UTF-8 chunk boundary

网络层给出的 `Uint8Array` chunk 只是一次读取得到的字节片段。它可能在
任意字节位置截断，例如一个中文字符的 UTF-8 编码可能被拆到两个 chunk：

```text
chunk 1: ... E4
chunk 2: B8 AD ...
```

如果直接把每个 chunk 转成字符串，可能得到替换字符。Studio 使用：

```ts
const decoder = new TextDecoder();
buffer += decoder.decode(value, { stream: true });
```

`TextDecoder` 会保留尚未完整解码的多字节字符，等下一块字节到达后再输出
正确的 Unicode 字符。最后一次读取结束时，还要调用一次不带 `stream: true`
的 `decode()` 刷出 decoder 中的剩余状态。

### 3.2 SSE frame boundary

SSE 使用空行结束一条 frame：

```text
event: text-delta
data: {"type":"text-delta","text":"你好"}

```

但一次 `reader.read()` 可能包含半条 frame、一条 frame 或多条 frame。
因此不能把一次 `read()` 当成一次事件，也不能把一次 UTF-8 解码结果当成
完整 JSON。

正确顺序是：

```text
bytes -> UTF-8 text -> buffer -> SSE frame -> event/data -> JSON -> typed event
```

代码要保留未完成的 `buffer`。当找到 `\n\n` 或 `\r\n\r\n` 时，才取出完整
frame；最后一个没有空行的 frame，则在 response 结束时处理。

SSE 的多行 `data:` 也有自己的规则。多行 data 需要用换行合并后再解析
JSON，空帧和以 `:` 开头的注释行需要忽略。未知事件可以忽略，因为这为
协议向后兼容留下了空间；已知事件但字段非法，则必须转换为安全的协议错误。

## 4. Parser 如何映射到 React 状态

Parser 不应该直接修改 DOM，也不应该知道 React。它只做两件事：

1. 把不可靠的 HTTP 字节流转换成可靠的、经过 Zod 校验的事件；
2. 按网络接收顺序调用 `onEvent`。

UI 层再把事件映射到本地状态：

| Runtime event     | React state 变化             |
| ----------------- | ---------------------------- |
| `text-delta`      | 追加到当前 assistant message |
| `reasoning-delta` | 追加到 reasoning 文本        |
| `tool-call`       | 创建 `called` 的工具活动     |
| `tool-executing`  | 将对应工具改为 `executing`   |
| `tool-result`     | 保存结果并改为 `completed`   |
| `completed`       | Run 状态改为 `completed`     |
| `error`           | 保存安全错误并改为 `error`   |

提交消息时，App 会同时插入 user message 和空的 assistant message。之后
收到 `text-delta` 时使用函数式 state update 追加文本，而不是从 DOM 读取
当前内容。这能保证连续 delta 在 React 批量更新时仍然按顺序合并。

第一版状态保持在 `App` 内，因为页面只有一个工作台，暂时没有跨路由或
跨页面共享状态的需求。未来加入 Session 列表、Workspace、Approval 和
Crew 后，再根据状态所有权决定是否拆分 store，而不是一开始就引入全局状态
管理库。

## 5. 项目就是本地 Agent 的工作区

在面向代码开发的 Agent 产品里，“工作区”和“项目”通常不应该是两个
并列概念。用户打开 Codex、Kiro 或类似工具时，最自然的动作是选择一个本地
文件夹，然后在这个文件夹里创建多个会话。文件夹决定 Agent 可以理解的代码
边界，项目则是这个文件夹在产品里的可管理身份。

因此 Studio 当前使用下面的关系：

```text
Project
  ├── folderName
  └── sessions[]
       ├── Session A
       ├── Session B
       └── Session C
```

这比下面这种平铺结构更符合产品语义：

```text
Workspace
Project
Session A
Session B
```

平铺结构会产生几个问题：

1. 同一个项目名称和工作区名称重复出现，用户不知道两者有什么区别；
2. 会话没有明确归属，切换项目时很容易把其他项目的会话显示出来；
3. 后续接入真实文件读写权限时，没有自然的位置保存项目和目录的关系；
4. Agent 请求只能携带一个孤立的 `sessionId`，不容易追溯它属于哪个项目。

现在的前端状态以 `StudioProject` 为聚合边界。更新消息、新建会话和切换会话
都先定位当前项目，再只修改该项目的 `sessions`。切换项目时会同时切换到
目标项目最近的会话，因此侧栏不会残留上一个项目的会话列表。

这个模型并不意味着 Runtime 现在已经持久化了 Project。当前 Studio 只是为了
先把产品交互和数据关系表达清楚。等后端加入 Workspace/Project 记录后，可以
把前端结构映射成：

```text
Project record
  -> local folder identity
  -> SessionEventStore session ids
```

这里要特别区分两种身份：

- `project.id` 是 Weave 自己生成的产品标识；
- `folderName` 是用户选择的本地文件夹显示名；
- 真正可靠的目录句柄、权限和恢复能力，需要由桌面壳或后端 Workspace 层负责。

## 5.1 为什么侧栏使用项目树

当项目数量增加后，只展示当前项目的会话会让用户频繁打开项目切换菜单；
把全部项目和会话放进同一棵树，用户可以直接完成三类操作：

1. 扫描所有项目的工作状态；
2. 展开某个项目，查看它下面的会话；
3. 直接点击任意项目下的会话，同时切换项目和会话。

树的第一层是项目，第二层是会话。这个层级不是单纯的视觉分组，而是和
数据模型保持一致：

```text
项目节点
  -> project.id / project.name / folderName
  -> 会话节点
       -> session.id / title / messages
```

项目节点的“展开/收起”只改变导航视图，不改变 `activeProjectId` 或
`activeSessionId`。点击项目名称则切换当前项目，并定位到该项目最近的会话；
点击会话则同时更新两个活动标识。这样“当前项目”和“当前会话”不会出现
互相矛盾的状态。

当前实现使用 `expandedProjectIds` 保存展开状态，而没有把它混入项目数据。
原因是展开状态属于临时 UI 状态，不是项目的持久事实。将来项目从后端重新
加载时，项目数据可以独立恢复，用户本次打开页面时的展开偏好也可以单独处理。

## 5.2 跨项目搜索为什么保留项目层级

搜索框匹配的是所有项目下的会话标题，但结果仍然以项目为外层节点：

```text
搜索：Foundation

项目
  ▾ Weave
      Foundation 设计
```

如果把搜索结果直接平铺成会话名称，用户只能看到“匹配了什么”，却不知道
“它属于哪个项目”。这会带来两个实际问题：

1. 用户可能误打开同名会话；
2. 切换到会话后，无法快速理解 Agent 接下来拥有哪个文件夹上下文。

因此 `visibleProjects` 会先保留项目对象，再过滤每个项目的 `sessions`。
搜索有结果的项目会保留在树中，并在展示时自动展开；没有匹配会话的项目
则被过滤掉。搜索结束后，原本的 `expandedProjectIds` 仍然保留，不会因为
一次搜索破坏用户之前的导航状态。

这也是一个可迁移到后端的查询思路：后端可以先按会话标题或消息内容搜索，
再通过 `projectId` 聚合结果，返回带项目上下文的搜索响应，而不是只返回
一组孤立的 Session ID。

## 5.3 为什么移动端也要保留项目树

项目树是访问其他项目和会话的主要入口。如果在移动端完全隐藏它，用户只能
看到当前项目，必须依赖另一个项目菜单才能完成跨项目导航，桌面端和移动端
的产品心智也会不一致。

当前移动端的处理方式是保留项目树，同时限制它的最大高度并允许滚动：

```text
顶部导航
  -> 当前项目摘要
  -> 新建会话 / 搜索
  -> 可滚动项目树
  -> 当前会话内容
```

这是响应式布局中的一个重要取舍：窄屏应该减少装饰和面板宽度，但不应该删掉
用户完成核心任务所需的信息架构。后续可以继续优化为抽屉式项目树，但抽屉
里仍然应该复用同一份项目树数据和选择逻辑，不能在移动端再维护一套项目状态。

## 5.4 当前项目树的边界

当前项目树仍然是 Studio 内存状态，刷新页面后会回到 `initialProjects`。
它验证的是产品交互、组件结构和前端状态关系，还没有完成以下持久化能力：

- 从后端读取真实 Project 列表；
- 将项目和本地文件夹关系写入 Workspace 存储；
- 从 SessionEventStore 查询项目下的会话；
- 在多个窗口之间同步项目树变化；
- 恢复用户上次的展开状态和当前会话。

后续接入后端时，建议保持这个边界：

```text
Workspace / Project API
  -> 返回项目和会话摘要
Studio
  -> 负责展开状态、搜索输入、选中状态
Session API
  -> 负责消息和事件流
```

不要因为前端现在用一个 `StudioProject` 类型，就让 Runtime 直接依赖
React 的状态结构。后端应定义自己的 Project、SessionSummary 和分页/搜索
契约，Studio 再把它们映射成适合渲染的树节点。

## 5.5 会话编辑、归档和永久删除

会话标题和会话是否归档属于 Session 元数据，不应该和项目树的展开状态
混在一起。当前模型使用：

```ts
type StudioSession = {
  id: string;
  title: string;
  lastUsedLabel: string;
  archivedAt: string | null;
  messages: ChatMessage[];
};
```

这里使用 `archivedAt`，而不是只使用 `isArchived: boolean`，有两个原因：

1. 归档是一个有时间意义的事实，未来可以按照归档时间排序、做清理策略或
   展示“归档于什么时候”；
2. `null` 表示当前未归档，非空时间戳表示已经归档，状态语义清晰，也更接近
   后端数据库中的可审计字段。

归档操作不会立即从 `projects` 中移除会话，只会写入归档时间：

```text
active session
  -> archivedAt = ISO timestamp
  -> 普通项目树过滤掉
  -> 归档区仍然可以找到
```

这是一种软删除（soft delete）思路。它比直接从数组删除更适合 Agent 会话：

- 用户可能误点，需要恢复入口；
- 会话消息和事件通常具有学习、审计或调试价值；
- 后续可以在归档区增加批量清理、保留期限和权限控制；
- 前端可以先验证交互，后端再把同一语义映射到数据库字段。

真正删除只能在归档区操作，并且需要二次确认。这样做有两个产品层面的
保护：普通工作区不会出现破坏性操作；用户必须先明确理解“归档”和“永久
删除”的差异。后端实现时也应该再次校验会话已经处于归档状态，不能只依赖
前端按钮的可见性。

当前前端的数据流是：

```text
编辑
  -> 更新 Session.title

归档
  -> 更新 Session.archivedAt
  -> 项目树过滤 archivedAt !== null

恢复
  -> 更新 Session.archivedAt = null
  -> 返回原项目树

永久删除
  -> 归档区二次确认
  -> 从当前项目的 sessions 中移除
```

如果归档或永久删除的是当前会话，Studio 会优先切换到同一项目下的另一个
未归档会话；如果没有可切换的会话，则清空当前会话选择，等待用户新建会话
或从归档区恢复一个会话。这个处理避免了界面仍然显示一个已经不在可用列表
中的 Session ID。

## 6. 浏览器选择文件夹的限制

创建项目弹窗支持浏览器的 File System Access API：

```ts
const directory = await window.showDirectoryPicker();
```

这个 API 能够让浏览器返回一个目录句柄，并提供目录名称，但它不等于应用
已经获得了可以永久使用的绝对路径。实际产品还需要考虑：

1. 用户是否授权；
2. 页面刷新后如何恢复句柄；
3. 句柄是否仍然有效；
4. 访问某个文件前是否需要重新确认权限；
5. 不支持该 API 的浏览器如何降级。

因此当前版本只保存 `folderName` 和用户输入的项目名称。没有后端 Workspace
和持久化权限之前，UI 不应该显示“已经拥有完整文件夹访问能力”这种不准确
的状态。对于不支持 `showDirectoryPicker()` 的浏览器，界面会退化到文件夹
上传选择，只用于推导目录名，并不把文件上传到服务器。

未来接入桌面端时，可以由主进程保存真正的目录标识和权限，再通过受控的
Workspace API 暴露给 Runtime。浏览器 Studio 仍然只调用应用边界，不应该
直接绕过 Workspace 去读取任意路径。

## 7. 为什么恢复按钮放在标题栏最右侧

右侧活动面板收起后，主内容区域会变宽。如果恢复按钮仍然停留在分支信息
旁边，用户会把它理解成分支操作的一部分，而且标题栏右侧留下的空白会让
布局显得突然。

当前动作顺序是：

```text
分支信息 -> 更多操作 -> 恢复活动面板
```

恢复按钮作为最后一个 header action，位置和它控制的右侧面板形成直接关系。
这也是开发工具常见的布局原则：面板开关属于窗口级动作，应固定在标题栏动作
区的边缘，而不是插入业务操作中间。

## 8. runId 如何防止取消竞态

取消一个请求并不意味着它的所有异步回调已经同步消失。旧请求可能在取消
之后晚到一个事件，或者晚一点抛出 `AbortError`。如果新请求已经开始，旧
请求就可能错误地修改新请求的 assistant message 或状态。

Studio 为每次提交生成一个唯一的 `runId`：

```text
submit A -> runId A
cancel A
submit B -> runId B
```

事件、错误和 `finally` 清理都先检查：

```text
activeRunId === current callback runId
```

只有仍属于当前 Run 的回调才允许更新 React 状态。取消时先让旧
`activeRunId` 失效，再调用 `AbortController.abort()`，这样旧请求即使稍后
回调也只会被丢弃。

这个问题本质上不是 React 特有的，而是异步请求生命周期的并发问题。任何
支持“取消后立即重新发送”的实时界面，都需要请求身份、版本号或等价的
所有权判断。

## 9. AbortController 的跨层取消链路

取消是一条跨层控制链：

```text
用户点击 Cancel
  -> controller.abort()
  -> 浏览器 fetch rejected with AbortError
  -> Server request signal / response cancel
  -> AsyncIterator.return()
  -> Runtime 中止模型或工具
  -> Runtime 持久化 cancelled Turn/Step
  -> Studio 显示 Cancelled
```

Server 仍然是 HTTP 和 Runtime 之间的适配层。它不应该自己复制一套
“取消中的 Agent 状态机”，而应该把请求断开转换为 Runner iterator 的
`return()`。Runtime 才知道当前是在等待模型、执行工具，还是准备写入
Session，也才有能力决定如何保存取消终态。

前端只把 `AbortError` 视为用户取消，不把它展示成系统故障。其他错误分为：

- SSE 建立前的 HTTP 错误，例如 `400` 或 `503`；
- SSE 建立后的 `error` 事件；
- 客户端发现的协议错误。

这些错误都应该使用安全的 `code` 和 `message`，不能把本地路径、堆栈或
Provider 的敏感响应原样展示给用户。

## 10. 本地 Mock 为什么放在 composition root

本地演示脚本位于 `apps/server/src/runtime.ts`，由 composition root 选择
固定的 Mock LLM：

```ts
const localDemoScript = [
  { type: 'text-delta', text: '这是 Weave 的本地 Agent 演示。' },
  { type: 'text-delta', text: ' 当前消息通过 SSE 增量传输。' },
  { type: 'finish', reason: 'stop' },
];
```

这不是在 Server 里重新实现 Agent Loop，而是在组装服务时注入一个确定性
的 `LlmClient`。Agent Runner、Tool Pipeline、Session 持久化和 SSE adapter
仍然走生产代码路径。

把 Mock 放在 composition root 有三个好处：

1. 领域逻辑不需要知道“这是演示环境”；
2. 测试和浏览器验收每次都能得到确定结果；
3. 以后接入真实 Provider 时只替换服务选择，不改 Studio 契约。

## 11. Transient 和 durable

两类事件服务不同目的：

```text
AgentRuntimeEvent
  面向实时消费者，transient

SessionEvent
  面向恢复、投影和审计，durable
```

`text-delta`、`reasoning-delta` 和 `tool-executing` 适合实时展示，不适合
逐条写入 Session。原因包括：

- delta 数量很多，会膨胀事件存储；
- 网络传输分块不是领域事实；
- SSE 断开后，部分 delta 可能已经到达浏览器、部分还没有到达；
- 把传输格式写入数据库会让持久化模型绑定到某个 UI 协议。

Session 更适合保存用户消息、完整 assistant message、Turn/Step 生命周期、
Tool Call 和 Tool Result 等可恢复事实。Runtime 负责决定哪些事实应该追加；
Studio 只展示实时事件，不直接写 durable events。

当前项目没有 Run Registry，因此刷新页面或断开后不能通过本接口重放历史
运行。要支持后台任务、多端订阅和重连，需要单独设计 run ownership、
事件 replay、`Last-Event-ID`、进程重启恢复和权限边界。

## 12. Studio 界面、会话交互与一键启动

当前 Studio 默认使用中文界面。这里没有立刻引入完整的国际化框架，而是
先把界面文案集中在页面组件中，并保留技术协议名词，例如 `Agent`、`SSE`
和本地模型名称。这样可以先保证产品体验一致，等未来确实需要英文、
日文等多语言时，再把文案迁移到独立的 locale 资源和语言切换层。

### 9.1 本地会话交互

当前会话列表已经不是静态装饰，而是一个最小可用的本地状态层。Studio
维护以下结构：

```ts
type StudioSession = {
  id: string;
  title: string;
  lastUsedLabel: string;
  messages: readonly ChatMessage[];
};
```

页面同时维护 `sessions` 和 `activeSessionId`：

```text
sessions
  -> 找到 activeSessionId 对应的 session
  -> 渲染当前会话 messages
  -> 发送请求时使用当前 session.id
```

点击“新建会话”时，页面只在浏览器内创建一个空会话并立即切换过去；
点击已有会话时，则切换消息视图，并清空当前运行的 reasoning、工具活动
和错误信息。这些状态属于一次 Agent Run，不属于某个会话的 durable 历史。

发送消息时，用户消息和空的 assistant 消息会写入当前 `StudioSession`。
后续收到的 `text-delta` 也通过 `sessionId` 定位目标会话，因此不同会话
之间不会共享消息。第一次向“未命名会话”发送消息时，输入内容会被截断
后作为会话标题，方便在侧栏识别。

运行中的会话暂时禁止切换和新建。这是一个有意识的边界：当前页面还没有
Run Registry，也没有后台运行列表。如果允许用户在运行中随意切换，旧 Run
的工具事件、错误和完成状态就可能污染另一个会话。等后续引入后台 Run、
事件归属和订阅协议后，再把“运行中禁用”升级为真正的多任务管理。

这里的会话仍然是 Studio 本地内存状态，刷新页面后会丢失；Agent 请求的
`sessionId` 已经会随当前会话变化，但后端会话列表、历史恢复和搜索 API
尚未接入。这样先把浏览器交互和状态边界验证清楚，再扩展跨包 HTTP 契约，
可以减少前后端同时修改带来的调试范围。

### 9.2 工作台布局

视觉层采用“窄导航 + 会话侧栏 + Agent 主工作区 + 运行活动面板”的工作台结构：

```text
工作区导航 -> 会话与项目 -> Agent 工作流 -> 运行活动
```

窄导航只表达工作台、项目、历史和设置等产品级入口；会话侧栏负责当前
Workspace、项目和最近会话；中央区域负责 Agent 时间线和底部任务输入条；
右侧运行活动面板负责运行状态、思考过程、工具调用和错误。

这里刻意没有把每个区域都做成一张浮动卡片。工作台使用背景层级、细分隔线
和少量重点边框来组织空间，让主对话拥有最多视觉权重。Weave 当前采用
蓝灰、靛蓝和青绿色的配色：深蓝灰负责工作区骨架，靛蓝负责品牌和主要
操作，青绿色表示连接与完成状态，其他区域保持冷暖适中的白灰色。这样既
有自己的识别度，也不会让主色抢走任务内容的注意力。

消息在前端以时间线呈现，而不是把用户和 Agent 都塞进相同的气泡卡片。这样
后续加入工具调用、文件变更、审批结果和命令输出时，可以继续沿着同一条
工作流追加事件，而不需要重新发明另一套消息布局。底部输入条也保留了
添加上下文、权限模式、Provider 和停止运行等扩展位置，但这些控件当前仍
是界面占位，不代表对应能力已经接通。

在宽屏中右侧面板常驻，便于边运行边观察；在窄屏中隐藏右侧面板并保留主
工作流和输入区，优先保证任务内容可读和输入可用，而不是压缩成三列。

### 9.3 视觉收敛与交互状态

第一版工作台已经验证了四列结构和基础交互，但视觉上仍然容易出现
“每个区域都是一个组件卡片”的问题。新版把设计目标收敛为：

```text
浅色产品导航
  + 冷白会话栏
  + 白色主工作区
  + 低对比度运行面板
```

这次调整有几个明确取舍：

1. **减少主色数量**：界面使用冷白、雾灰和低饱和靛蓝组织层级；
   绿色只表达连接和完成状态。这样用户能更快区分“可以点击的
   操作”和“系统当前状态”，页面也不会因为每个图标都带颜色而显得嘈杂。
2. **去掉装饰性容器**：消息区域不再给每条 Agent 回复都套一层明显的
   气泡边框，用户消息只保留轻量背景来区分方向。后续工具调用、文件变更
   和审批事件可以继续沿着同一条时间线加入，而不需要不断增加卡片层级。
3. **输入区成为主要焦点**：输入框保留边框和轻微阴影，聚焦时只增加一圈
   很弱的靛蓝提示。发送按钮使用 `SendHorizontal` 图标，并与停止按钮
   复用相同尺寸，避免使用难以表达方向的 Unicode 字符。
4. **图标统一来源**：工作台导航、会话操作、工具状态和发送控制统一使用
   `lucide-react`。图标本身只表达动作，不承担额外的文字说明；中文标签
   仍然保留在用户需要理解入口含义的地方。
5. **响应式先保证工作流**：桌面端保留导航、会话、对话和运行信息四个区域；
   中等宽度隐藏运行面板；移动端改成顶部导航和上下布局。响应式设计的重点
   不是把桌面四列强行压缩，而是优先保护消息阅读和任务输入。

这说明 Agent 产品的 UI 不应该只围绕“聊天气泡”设计。对开发 Agent 来说，
用户还需要知道当前项目、会话、运行状态、工具调用和权限范围。好的布局
应该让这些信息有稳定的位置，同时把视觉重点留给当前任务和输入动作。

页面按钮也从静态占位升级为本地交互状态：

- 产品导航可以切换工作台、项目、历史和设置区域；
- 会话搜索会展开搜索框并实时过滤本地会话；
- 工作区、项目和会话更多操作使用统一的弹出菜单；
- 添加上下文会生成可移除的上下文标签；
- 权限模式和模型选择会直接更新输入区当前状态；
- 运行活动面板可以收起和恢复；
- 菜单支持点击外部区域或按 `Escape` 关闭。

这些交互暂时只改变 Studio 本地状态，不会伪造后端能力。例如切换
“DeepSeek”只表示前端已经具备模型选择入口，并不意味着 Provider 已经完成
配置。这样可以先验证信息架构和操作路径，再通过稳定协议逐步接入真实能力。

开发时可以使用根目录的一键命令：

```bash
pnpm dev
```

根脚本通过 pnpm 并行启动 Server 和 Studio。Server 在 `4317` 提供本地
HTTP/SSE，Studio 在 `5173` 提供浏览器页面。Studio 的开发脚本固定绑定
`127.0.0.1`，这样 Vite 代理目标、浏览器验收地址和文档命令保持一致。
需要单独调试某一端时，仍然可以分别执行：

```bash
pnpm --filter @weave/server dev
pnpm --filter @weave/studio dev
```

### 12.4 对话区自动滚动

`features/conversation/use-auto-scroll.ts` 让对话区在流式输出时跟随到底部：

- 视口距离底部不超过 80px 时视为"在底部"，新内容到达后自动滚到底；
- 用户向上滚动后停止跟随，右下方出现"回到底部"按钮，流式输出中显示为"有新内容"；
- 点击按钮、用户自己滚回底部、发送新消息或切换会话时恢复跟随；
- 只有"向上滚动"会关闭跟随，所以平滑滚向底部的动画中途不会把自己取消。

### 12.5 助手回复的 Markdown 渲染

`features/conversation/markdown-message.tsx` 用 Markdown 渲染助手正文，思考过程和
用户消息仍是纯文本。

新增依赖及原因：

| 依赖             | 原因                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `react-markdown` | 把 Markdown 解析成 React 元素，默认不解释原始 HTML，避免模型输出注入脚本；不用 `dangerouslySetInnerHTML` |
| `remark-gfm`     | 支持模型常用的表格、任务列表、删除线和自动链接                                                           |

安全约束：

- 不安装 `rehype-raw`，模型输出里的 `<script>`、`<b onclick>` 等标签不会变成真实元素；
- 只保留 `http(s)` 和 `mailto` 链接，`javascript:` 等协议的链接只显示文字；
- 链接用 `target="_blank"` 和 `rel="noopener noreferrer"` 打开；
- 不渲染图片，避免模型让 Studio 加载任意远程资源。

当前限制：代码块没有语法高亮；桌面端的 `setWindowOpenHandler` 会拒绝外部窗口，所以
桌面端点击链接暂时没有反应，需要后续用系统浏览器打开。

## 13. 面试表达

可以按下面的顺序回答：

1. **分层**：Runtime 负责 Agent Loop、工具和 Session，Server 负责 HTTP
   输入校验与 SSE 适配，Studio 负责浏览器交互和展示。
2. **前端边界**：Studio 不导入 Runtime，只依赖稳定的 HTTP/SSE 契约，避免
   浏览器耦合 Node 和领域内部实现。
3. **流式处理**：先用 `TextDecoder` 解决 UTF-8 字节边界，再用 buffer 解决
   SSE frame 边界，最后用 Zod 验证事件结构。
4. **状态模型**：parser 只产生 typed events，React 根据事件更新消息、
   reasoning、工具活动和 Run 状态。
5. **取消语义**：AbortController 触发 fetch 取消，Server 将断开转换为
   iterator return，Runtime 负责停止执行并持久化 cancelled 终态。
6. **持久化取舍**：实时 delta 是 transient，Session 保存 durable facts，
   当前单请求接口暂不承担重连和后台运行。
7. **演进方向**：需要刷新恢复、多端订阅或后台任务时，引入 Run Registry 和
   replay 协议，而不是把重连逻辑堆到当前页面。

## 14. 自测题

1. 为什么包含 `AbortSignal` 的 Runtime request 不能直接作为 HTTP JSON schema？
2. 为什么一次 `reader.read()` 不能等同于一条 SSE 事件？
3. UTF-8 字符边界和 SSE frame 边界分别由什么组件处理？
4. 为什么 `completed` 后 parser 应该结束消费并取消 reader？
5. 为什么取消后立即发送新请求时需要 `runId`？
6. 浏览器断开后，为什么 Server 需要调用 AsyncIterator `return()`？
7. 为什么 `text-delta` 不应逐条写入 Session Event Store？
8. 什么业务需求出现时，才值得引入 Run Registry、重连和 Last-Event-ID？
9. 为什么固定 Mock LLM 应该放在 composition root，而不是 Agent Runner 内部？
10. 如果 SSE 已经返回 `200`，Runtime 后续失败为什么只能发送 `error` 事件，
    不能再把 HTTP 状态改成 `500`？
