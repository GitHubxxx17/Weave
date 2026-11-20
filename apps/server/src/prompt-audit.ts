import { createHash } from 'node:crypto';
import type { PromptSection } from '@weave/plugin';
import type { SessionEvent, SessionEventStore } from '@weave/session';

/**
 * What plugins add to the system prompt is recorded in the Session before it is
 * sent to a model, so a request can be reconstructed from the log.
 *
 * Two core events carry it. `prompt.section-content` holds the text of one
 * section under its SHA-256, written once per Session. `prompt.sections-applied`
 * lists the sections in effect (id, plugin, hash, size) and is written only when
 * that list differs from the last one the Session recorded, so a Session whose
 * plugins did not change gains nothing. The server's own instruction text is not
 * recorded: it is not a plugin's, and it is described by the build.
 */

/** One plugin section as it reaches the prompt: trimmed, never blank, with its contributor. */
export interface AppliedPromptSection {
  readonly id: string;
  readonly pluginId: string;
  readonly text: string;
}

/**
 * The plugin sections that reach the prompt, in the order given. Text is trimmed
 * and blank sections are dropped, exactly as the instructions render them, so
 * what is recorded is what is sent.
 */
export function appliedPromptSections(
  sections: readonly PromptSection[],
): readonly AppliedPromptSection[] {
  const applied: AppliedPromptSection[] = [];
  for (const section of sections) {
    const text = section.text.trim();
    if (text === '') {
      continue;
    }
    if (section.pluginId === undefined) {
      throw new TypeError(
        `Prompt section "${section.id}" does not name the plugin that contributed it`,
      );
    }
    applied.push({ id: section.id, pluginId: section.pluginId, text });
  }
  return applied;
}

/** Raised when the sections a turn would apply cannot be recorded. */
export class PromptAuditError extends Error {
  readonly code = 'prompt-audit-failed';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PromptAuditError';
  }
}

export interface PromptAudit {
  /**
   * Makes the sections a turn applies durable, if they are not already. Resolves
   * once they are; throws {@link PromptAuditError} when they cannot be written,
   * so the caller does not send text that is not on record.
   */
  record(context: { readonly sessionId: string; readonly turnId: string }): Promise<void>;
}

export interface PromptAuditOptions {
  /** The Server's own Session Store: these are core events, which plugins cannot write. */
  readonly store: SessionEventStore;
  readonly sections: readonly AppliedPromptSection[];
}

interface DescribedSection extends AppliedPromptSection {
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * What the log says about one Session, folded from the events read so far. It is
 * only a cache of the log: every `record` reads what was appended since, so a
 * set written by anything else is seen before deciding whether to write.
 */
interface RecordedSession {
  applied: string;
  readonly contents: Set<string>;
  lastSequence: number;
}

type SectionIdentity = Pick<AppliedPromptSection, 'id' | 'pluginId'> & { readonly sha256: string };

/** Two sets are the same when they list the same sections, with the same text, in the same order. */
function fingerprint(sections: readonly SectionIdentity[]): string {
  return JSON.stringify(sections.map(({ id, pluginId, sha256 }) => [id, pluginId, sha256]));
}

function foldInto(recorded: RecordedSession, events: readonly SessionEvent[]): void {
  for (const event of events) {
    recorded.lastSequence = Math.max(recorded.lastSequence, event.sequence);
    if (event.type === 'prompt.section-content') {
      recorded.contents.add(event.payload.sha256);
    } else if (event.type === 'prompt.sections-applied') {
      recorded.applied = fingerprint(event.payload.sections);
    }
  }
}

/** Creates the recorder for the sections of one assembled Agent Runner. */
export function createPromptAudit(options: PromptAuditOptions): PromptAudit {
  const { store } = options;
  const described: readonly DescribedSection[] = options.sections.map((section) => ({
    ...section,
    sha256: createHash('sha256').update(section.text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(section.text, 'utf8'),
  }));
  const current = fingerprint(described);
  // The first read of a Session takes its whole log, which is what keeps a
  // restart from writing again what the log already holds. Later reads take
  // only what came after.
  const sessions = new Map<string, RecordedSession>();

  async function recordedFor(sessionId: string): Promise<RecordedSession> {
    const recorded = sessions.get(sessionId) ?? {
      applied: fingerprint([]),
      contents: new Set<string>(),
      lastSequence: 0,
    };
    foldInto(recorded, await store.read(sessionId, { afterSequence: recorded.lastSequence }));
    sessions.set(sessionId, recorded);
    return recorded;
  }

  return {
    async record({ sessionId, turnId }) {
      try {
        const recorded = await recordedFor(sessionId);
        if (recorded.applied === current) {
          return;
        }
        const missing = [
          ...new Map(
            described
              .filter((section) => !recorded.contents.has(section.sha256))
              .map((section) => [section.sha256, section] as const),
          ).values(),
        ];
        await store.append(sessionId, [
          ...missing.map((section) => ({
            type: 'prompt.section-content' as const,
            payload: { sha256: section.sha256, text: section.text },
          })),
          {
            type: 'prompt.sections-applied' as const,
            payload: {
              turnId,
              sections: described.map(({ id, pluginId, sha256, bytes }) => ({
                id,
                pluginId,
                sha256,
                bytes,
              })),
            },
          },
        ]);
      } catch (error: unknown) {
        throw new PromptAuditError(
          'The plugin prompt sections for this turn could not be recorded in the Session',
          { cause: error },
        );
      }
    },
  };
}
