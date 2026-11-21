# MCP stdio client

`@weave/mcp-client` is an independent Node.js client for local MCP services. It
has no dependency on another Weave package. The official SDK owns JSON-RPC,
legacy version negotiation and stdio spawning; this package owns bounded JSON
and schema validation, immutable tool catalogs, request budgets and safe errors.
Plugin adaptation, workspace authority and durable trust belong to later layers.

The connection explicitly selects the SDK's legacy protocol mode. In SDK
2.4.0 that protocol validates `structuredContent` and `outputSchema` as objects,
even though public types spanning newer protocol versions can represent broader
values. Weave preserves that validation: an invalid legacy result produces a
safe failure. The transport patch does not relax protocol schemas.

## Dependencies

- `@modelcontextprotocol/client` is pinned to **2.4.0** so the protocol behavior
  and the transport patch below remain reviewable. The implementation was
  checked against [the official v2.4.0 source][sdk], tag commit
  `951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5`.
- `zod` validates external configuration and protocol data before this package
  uses it. The SDK's Ajv validator compiles the supported schema subset; this
  package does not add a second JSON Schema implementation.

## SDK transport cleanup patch

[`patches/@modelcontextprotocol__client@2.4.0.patch`][patch] is registered through
the root `pnpm.patchedDependencies`. It changes the official SDK's distributed
ESM and CommonJS `stdio` entries only. No Weave implementation accesses private
SDK fields.

The upstream public `StdioClientTransport.close()` waits for the direct child's
`close` event. A service can exit while one of its descendants keeps inherited
stdout or stderr open. In that situation the SDK's close promise returns after
its bounded wait, but parent-side pipe handles still keep the host event loop
alive, `onclose` has not fired and pending protocol calls remain unsettled.
Initialization failure can also overlap another close call after the SDK clears
its process field.

The patch shares one close promise and releases the transport's stdin, stdout,
stderr and stderr `PassThrough` in `finally`, then clears its read buffer and
notifies `onclose` exactly once. That notification lets the SDK's existing
protocol cleanup reject pending calls and clear their timers. The original
shutdown sequence remains stdin EOF with up to two seconds of waiting, SIGTERM
with up to two more seconds, then SIGKILL. Weave applies a five second outer
shutdown deadline. The patch does not change negotiation, JSON-RPC messages,
tool behavior or retries.

This releases handles owned by the host. It does not kill a process group, wait
for the final SIGKILL to finish, guarantee descendant cleanup or provide an OS
sandbox. Call cancellation is a protocol notification, and cannot roll back
service side effects.

[`test/transport-close.test.ts`][test] starts a separate Node host for both
distribution entries. The MCP service creates a descendant that inherits its
stdio. Tests require the host to actually emit `exit` within the deadline while
that descendant is still alive, verify pending calls settle and `onclose` fires
once, and cover normal and failed initialization with repeated close calls. The
test harness kills the descendant it created after observing the host outcome.

On an SDK upgrade, inspect the new public close implementation and run these
regressions **without** the patch. Remove the pin-specific patch and its pnpm
registration only when the unpatched SDK passes both distribution entries,
pending-call settlement, repeated close and initialization failure cleanup.
Passing only the `close()` promise assertion is insufficient: the independent
host must exit while inherited descendant pipes remain open.

[sdk]: https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/client/src/client/stdio.ts
[patch]: ../../patches/@modelcontextprotocol__client@2.4.0.patch
[test]: test/transport-close.test.ts

## Schema compatibility

The synchronous validator accepts the Draft 2020-12 subset and budgets recorded
in the Stage 5 design. It rejects references, regular expressions, other dialects,
unknown keywords and `$id` at every schema position before compiling. The fixed
SDK also rejects an empty `enum` during compilation; duplicate enum members are
accepted. Annotation
and const/enum data remain data. Input validation never changes caller values.

The bundled AJV skips a schema property literally named `__proto__`, and its
const/enum equality helper special-cases names such as `valueOf`. The validation
adapter uses private copies with an injective prefix for every data-object key,
plus the corresponding schema properties, required names and const/enum values.
This preserves object-key semantics without changing public schemas or tool
arguments, including keys that already contain the prefix. Each schema has its
own provider and its compiled function is reused for the connection lifetime.
