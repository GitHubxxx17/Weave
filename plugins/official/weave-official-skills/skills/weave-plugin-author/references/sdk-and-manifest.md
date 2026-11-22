# SDK、manifest 与贡献边界

## 可运行形状

ESM payload 的 weave-plugin.json 使用 schemaVersion:1、entry:index.mjs 和完整 manifest。
manifest 包含 id/name/version/apiVersion/capabilities/contributes/permissions。id 为小写
单词以单连字符分隔，version/apiVersion 是 x.y.z；当前 plugin API 是 1.0.0。
engines.weave 只有在真实宿主版本经过测试时填写，不能把 API/Node 版本当宿主版本。

源码默认导出工厂，import type { PluginFactory } from '@weave/plugin'；运行值用入参
sdk。工厂返回 setup(env) 和可选 dispose()，不能复制另一个 Runtime 或直接调用 Agent。
参考 examples/hello-tool.ts / tool-manifest.json，或 hello-command.ts / command-manifest.json。

Tool 的 parameters 是模型中立 JSON Schema，inputSchema 用 sdk.z 验证真实输入。
readOnly:true 仅用于真实只读操作；受保护操作需 approval 元数据并接受宿主策略。
示例只返回输入文本，不访问系统，execute 检查 context.signal。
Command 是 name/title/description?/prompt 的声明式模板，使用 $ARGUMENTS 插入参数；
它准备模型提示，不是任意命令执行 callback。同名冲突由 owner 拒绝。

纯文本 Skills 直接用 schema-2 kind:skills、host:declarative、仅 skill capability、
显式 contributes.skills 和 permissions:[]，不添加假 ESM、工具、hook、service 或 Panel。
需要动态贡献 Skills 的 ESM 插件仍是执行受信任代码的插件，不能混称纯文本包。

## 身份、权限和服务

owner 修复后的 Kernel 捕获并冻结解析后的 manifest；作者随后修改原始对象不改变
插件 ID。贡献名必须声明；只有 owner 实际同步接受的贡献被记为成功。owner 返回
undefined 成功，false 跳过；Promise/异常/其他返回值不记成功。contributor 必须同步，
返回后保留的 guarded API 关闭；不要 async (api)=> await ... 再 add。

SDK 不向作者暴露宿主 Tool Registry、Agent Runner 或审批批准/拒绝能力。
env.use(sdk.approvalBrokerRef) 仅允许 request/get/list/subscribe，不能 approve/reject。
服务使用的 service:<id> 权限由 Kernel 检查；workspace/network/process 声明向用户
披露意图，不把声明本身解释为完整恶意 Node 代码隔离。

事件使用 env.defineEvent('report',{schema:sdk.z.strictObject(...)})，自动归入
<pluginId>/report，并在 manifest contributes.events 声明该完整类型。可用
const writer=env.use(sdk.sessionStoreRef)；实际 get() 后 append 自己的事件。
owner 修复后直接 use 和 service factory deps 都绑定消费者身份，不能 append 核心或
别的插件类型；一批任一非法事件使整批零写入。读取仍共享 Session 历史，close 不关闭
宿主 store。pluginEventsRef 是无 define/schema/project 实现引用的 reader，get/list
仅返回冻结元数据，不能用它注册其他 owner。

这些 owner 修复的已合并 SHA 为 fbc6d1a82d0cdc57889f44fb697e903c764f1d44；
不要向早于该提交的 SDK 用户承诺新约束已生效。
历史事件不因修复而获得生产 artifact/Generation 证明。受信任进程内插件不是 OS 沙箱。
