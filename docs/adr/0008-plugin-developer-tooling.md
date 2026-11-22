# ADR 0008: Repository-local plugin developer tools

- Status: Accepted
- Date: 2026-11-22

Add the independent `@weave/plugin-cli` leaf, with internal dependencies only on
Plugin and Plugin-host. It creates Tool, Command and Skills projects and provides
source/artifact validation, controlled build and directory packaging. It never
imports author modules, runs author configuration/scripts, installs dependencies,
contacts services or changes installation authority. Runtime and Server retain
execution, trust, activation, Generation and Tool Pipeline responsibilities.

Use the real public SDK declarations with CLI-owned TypeScript and Node types,
then esbuild for one Node ESM file. Version one accepts checked relative TypeScript
source and actual Node builtins, with SDK imports erased as types. General npm
bundling is deferred until its resolution/license contract exists. Static checks
express a supported packaging profile, not a sandbox or code-safety verdict.

Keep the existing descriptor: schema-1 source declares its eventual `index.mjs`
while source lives at `src/index.ts`; it is not installable until built. Schema-2
Skills is already an inert payload. A new exclusive output container holds the
verified `payload/` and, for pack, `receipt.json` outside the directory digest.
Do not invent archives, published SDK packages, signatures or release commits.

Compiler/runtime dependencies are exact TypeScript 5.9.3 (strict real SDK checks),
esbuild 0.28.2 (single ESM bundle), @types/node 24.10.1 (compiler declarations at
CLI runtime), Zod 4.6.7 (external inputs). Existing workspace tools remain unchanged.

The [design](../superpowers/specs/2026-11-22-plugin-developer-cli-design.md) records
contracts and the [plan](../superpowers/plans/2026-11-22-plugin-developer-cli.md)
assigns implementation and verification. Product references use the existing
pinned audit; this CLI is Weave's implementation, with no copied upstream source.
