import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { themePreferenceSchema } from './theme.js';

/** File name inside the Desktop user data directory. */
export const desktopStateFileName = 'desktop-state.json';

/**
 * Shape of `<userData>/desktop-state.json`. Unknown fields are ignored on read
 * and are not carried over by later writes. New fields must be optional so older
 * files stay valid.
 */
export const desktopStateSchema = z.object({
  version: z.literal(1),
  /** Port of the embedded Server last used, kept so the Studio origin stays stable. */
  serverPort: z.number().int().min(1024).max(65535).optional(),
  /** Theme preference last reported by Studio, so the first window already has the right background. */
  theme: themePreferenceSchema.optional(),
});

export type DesktopState = z.infer<typeof desktopStateSchema>;

/** Fields a caller may change; `undefined` leaves a field as it is. */
export type DesktopStatePatch = Partial<Omit<DesktopState, 'version'>>;

export function getDesktopStatePath(userDataDirectory: string): string {
  return join(userDataDirectory, desktopStateFileName);
}

/**
 * Reads the state file. A missing, unreadable, malformed or invalid file counts
 * as "no record" and never throws, so a bad file cannot block startup.
 */
export async function readDesktopState(userDataDirectory: string): Promise<DesktopState> {
  try {
    const text = await readFile(getDesktopStatePath(userDataDirectory), 'utf8');
    const parsed = desktopStateSchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Treated as no record.
  }
  return { version: 1 };
}

/**
 * Merges `patch` into the stored state and writes it through a temporary file
 * and `rename`, so a crash never leaves a half-written file.
 */
export async function writeDesktopState(
  userDataDirectory: string,
  patch: DesktopStatePatch,
): Promise<DesktopState> {
  const current = await readDesktopState(userDataDirectory);
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const next = desktopStateSchema.parse({ ...current, ...definedPatch, version: 1 });
  const target = getDesktopStatePath(userDataDirectory);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(userDataDirectory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return next;
}
