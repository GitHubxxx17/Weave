# Stage 6.5 implementation plan

Design: [Plugin marketplace](../specs/2026-11-22-plugin-marketplace-design.md).

1. Server discovery: add strict static community index loader, curated builtin
   projection, compatibility/order and read-only HTTP route. Test malformed/large
   indexes, duplicates, reserved identities, unavailable sources and nonmutation.
2. Studio navigation: add left marketplace product view, remove right Plugins
   descriptor, migrate saved layouts, preserve chat/right panel instances and
   pending badge. Test navigation, run/draft/iframe/terminal survival and focus.
3. Marketplace page: independent HTTP DTO validation, Discover/Installed UI,
   search/filters/version detail, explicit handoff to existing managed review with
   frozen source/manifest equality and all existing gate/retry/cancel behavior.
4. Integrate: update examples/operator and developer docs; independent review of
   affected contracts and UI; focused suites followed by full `pnpm check`.
5. Browser smoke: real Server and Vite, left navigation/legacy migration,
   responsive layout, official and fixture community discovery, reviewed inert
   import and unchanged explicit activation. Record fixture versus live evidence.
6. Preserve original Stage 6.4 branch, export a Stage 6.5-only review patch and
   report actual verification and remaining distribution limitations.

Each implementation task uses behavioral tests before implementation. No package
dependencies, automatic trust, package execution or custom panel SDK are added.
