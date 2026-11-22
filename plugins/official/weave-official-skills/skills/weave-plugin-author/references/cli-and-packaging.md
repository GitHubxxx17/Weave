# 仓库内 CLI 与打包

从真实 Weave checkout 执行，Node >=24.4，使用仓库固定 pnpm/lockfile。每个输出必须
是新目录，且在 source 外。以下 /tmp 路径仅是用户创作时需选择的新工作目录，操作前
先确认不存在；不要覆盖已有项目，也不要把示例作为“已运行”的证明。

```sh
pnpm plugin:create --template tool --id hello-tool --directory /tmp/my-hello-tool
pnpm plugin:validate --source /tmp/my-hello-tool
pnpm plugin:build --source /tmp/my-hello-tool --out /tmp/my-hello-build
pnpm plugin:validate --artifact /tmp/my-hello-build/payload
pnpm plugin:pack --artifact /tmp/my-hello-build/payload --out /tmp/my-hello-release
```

template 可为 tool、command、skills，--name 设置展示名，模板初始版本 0.1.0。
--json 输出一个结构化结果，stderr 为诊断。根 wrapper 会先构建真实 CLI/依赖。
ESM 的 --sdk-directory 选择另一个真实已构建的本地 packages/plugin；Skills 和 artifact
validation 不接受该选项。--host-version 仅传已选的真实 Weave 发布版本，否则省略。

## source 与 payload

ESM source 有 src/index.ts、type:module 的 package.json、描述未来入口的 descriptor。
源码没有假 index.mjs，validate --source 不产生 artifact digest。build 创建新容器下
payload/index.mjs，才是可安装目录。pack 接受已存在 payload，不隐式构建。

```text
release-container/
  payload/
    weave-plugin.json
    index.mjs
    README.md
  receipt.json
```

Skills source 本身是合法文本 payload，无需编译；build/pack 保留原始文档和资源。
receipt 位于 payload 外，记录真实 manifest/kind/digest/计数/本地路径；不是签名、官方
证明、trust 或远端出处。payload 改变后旧 receipt 失效，以实际文件验证为准。

## ESM 第一版 profile

支持 src 内相对 TypeScript 模块（.js 可解析到 .ts）、真实 Node builtin，以及擦除的
@weave/plugin type-only imports。最终单个 index.mjs，无 chunks/maps/assets。一般 npm
运行时依赖打包尚未支持。运行时 SDK import、未知裸包、URL/绝对/逃逸路径、非字面量
import、CommonJS require/createRequire、author declaration shim 等会失败。

CLI 使用固定严格 TypeScript 5.9.3 设置和真实公开 SDK 检查 PluginFactory。作者的
tsconfig/build config/transformer/lifecycle/source 不被执行。不要为通过校验生成空 SDK
声明或 ambient augmentation，也不要改成 any 绕过。合法的 Node builtin 并不代表安全。
源码最多 128 文件/4 MiB，单文件 256 KiB，遍历深度16/512 entries。

ESM pack 包含 descriptor、一个 index.mjs 和可选 README.md/LICENSE/NOTICE。
禁止 .env/.env.*、.map、node_modules/coverage 路径；这只是发布卫生，不证明无秘密。
Skills 的文本限制见该包实际 inspector，不误用更大的 standalone disk inventory 限制。

报错时区分 source type error、unsupported build profile、payload shape、路径变化、
输出冲突及清理失败。CLI 失败只清理自己仍拥有的输出；观察到替换数据时保留并诊断。
不要反复删除未知目录来重试。SIGINT 为协作取消，同步编译阶段可能不能瞬时中断。
