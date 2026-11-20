import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createPluginEventRegistry,
  pluginManifestSchema,
  type PluginEventDefinition,
} from '@weave/plugin';
import { isPluginEventType, newSessionEventSchema } from '@weave/session';

/**
 * `@weave/session` and `@weave/plugin` each state what a plugin event type
 * looks like, because the plugin kernel carries no runtime dependency on a
 * library. This is where the two are held to the same rule.
 */
describe('plugin event type', () => {
  const accepted = ['notes/note-added', 'a/b', 'my-plugin/a1-b2', '0/0', 'git/commit-captured'];
  const rejected = [
    'turn.started',
    'session.created',
    'notes',
    'notes/',
    '/note',
    'Notes/note',
    'notes/Note',
    'notes/note_added',
    'notes/note/added',
    '-notes/note',
    'notes/-note',
    'notes/note-',
    'notes--x/note',
    'notes/note--x',
    ' notes/note',
    'notes/note ',
    'notes/note\n',
  ];

  it.each([...accepted, ...rejected])(
    'is judged the same by the session package, the registry and the manifest: %j',
    (type) => {
      const expected = accepted.includes(type);

      const registry = createPluginEventRegistry();
      let definable = true;
      try {
        registry.define({
          type,
          schema: z.object({}),
        } as unknown as PluginEventDefinition);
      } catch {
        definable = false;
      }
      const manifestAccepts = pluginManifestSchema.safeParse({
        id: type.split('/')[0],
        name: 'Plugin',
        version: '1.0.0',
        apiVersion: '1.0.0',
        capabilities: ['event'],
        contributes: { events: [type] },
      }).success;
      const storeAccepts = newSessionEventSchema.safeParse({ type, payload: {} }).success;

      expect(isPluginEventType(type)).toBe(expected);
      expect(definable).toBe(expected);
      expect(manifestAccepts).toBe(expected);
      // `session.created` is a valid core event with an empty payload, so the
      // Store check applies only to strings that contain the plugin separator.
      if (type.includes('/')) {
        expect(storeAccepts).toBe(expected);
      }
    },
  );
});
