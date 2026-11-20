/**
 * The shape of a plugin event type, `<pluginId>/<name>`: two lowercase,
 * hyphen-separated segments. The slash keeps plugin events apart from the core
 * events, whose types never contain one.
 *
 * `@weave/session` states the same rule for what its stores accept, and the
 * plugin kernel keeps its own copy so it has no runtime dependency on a
 * library. A test in `@weave/plugin-builtins` holds the two in step.
 */
const segment = '[a-z0-9]+(?:-[a-z0-9]+)*';

/** Matches a whole plugin event type. */
export const pluginEventTypePattern = new RegExp(`^${segment}/${segment}$`);

/** Matches the `<name>` half a plugin picks for its own event. */
export const pluginEventNamePattern = new RegExp(`^${segment}$`);
