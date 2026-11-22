# 右侧声明式 Panel

已核对 Weave main e7dd7ca80dfa71d46fa73b5a5b6dffbb1ae8ad49（PR #97）。这份资源是本包的版本快照，
不依赖安装者另有源码 checkout。源码出处仅用于维护追踪：
packages/plugin/src/panels.ts、sdk.ts、seams.ts；examples/plugins/quality-report/；
docs/learning/2026-11-22-plugin-panels.md。

## 声明与 SDK

使用 schema-1 单文件 ESM 插件，manifest capabilities 包含 panel，contributes.panels
明确列出本地面板 ID。工厂运行值来自注入 sdk，通过 env.contribute(sdk.panelsExtensionPoint,
api => api.addPanel(definition)) 注册；不要运行时 import @weave/plugin。
schema-2 host:declarative 发行包继续只允许 Skills，不能放 Panel。

最小静态定义的结构如下（不是独立可安装入口）：

```json
{
  "schemaVersion": 1,
  "id": "summary",
  "title": "摘要",
  "icon": "checklist",
  "placement": "right",
  "sources": [],
  "blocks": [{ "id": "text", "type": "text", "value": { "literal": "等待报告" } }]
}
```

支持 heading、text、status、metric、key-value、table、form 七种块；chart 只是
可选图标名，不是 chart 块。宿主不接受 React、HTML、Markdown、CSS、URL、iframe、
回调、RPC 或直接运行工具按钮。表单字段只有 text、boolean、select。

## 数据与表单

数据 source 必须是同一候选插件真正成功注册的持久事件；只在 manifest 声明事件
不足以绑定。path 是受限的字面记录属性路径，没有数组索引、JSONPath、继承属性
或原型访问；只有 table rows 绑定可返回数组。宿主读取最新精确类型事件并只投影
所需字段，不执行插件 schema、projector、service 或工具。最新事件版本不兼容时
显示 incompatible，不回退旧报告。

form submit 必须绑定同一插件真正成功注册的命令。宿主冻结命令提示词，点击只将
展开的完整文字追加到当前可见草稿，用户检查、编辑后明确发送。打开/刷新/准备
不会发送消息、运行工具或新增 Session 事件。文字、图片与 Skill 选择保留，准备后
按字面发送；显式重新选择斜杠命令才恢复普通展开。无真实 Session 时不能准备。

数据授权只对应当前 Generation 与已观察的插件状态；重载/撤销使旧 ref 失效，
面板不会固定旧 Generation。稳定标签 ID 在插件暂缺时保留占位。Session 读取依据
实际返回的连续持久前缀：前缀已归档时仍能看数据，不能准备；已删除时拒绝读取
和准备。并发删除在观察前缀之后发生时，不保证该响应立刻看见删除。

## 预算与验证

每插件8面板、候选总共128；定义64 KiB、目录1 MiB、数据64 KiB；sources8、blocks32、
深度16、节点4096。表格最多100行10列；准备请求16 KiB、展开提示词32 KiB。
超大选中数据显式失败，不悄悄截断为看似完整的报告。

用户请求真实插件时，先核对目标宿主的实际 sdk.panelsExtensionPoint 与类型。
在新目录用现有 Tool/Command 模板起步，补完整 manifest/事件/命令/面板，经过真实
source validate/build/artifact validate/pack。质量报告组合需要实际共享 Tool Pipeline
写事件，面板自身不运行检查；不要把工具输入分数说成宿主认证。

这是同进程受信任机制，不是 OS/Node 沙箱。普通 getter 在快照前拒绝，候选组装的
Proxy 反射 trap 仍可能执行。资源内示例是惰性文本，加载不授予执行或管理授权。
