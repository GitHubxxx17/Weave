import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { pluginManifestSchema, type PluginManifest } from '@weave/plugin';
import { z } from 'zod';

import type { DiscoveryResult } from './discovery.js';
import { compareIds, eligibleLocalPlugins, identity } from './host-state.js';
import type {
  ExplicitLocalSelectionInput,
  LocalPluginSourceSnapshot,
  LocalSourceCandidate,
  ManagedLocalCandidate,
} from './local-source-types.js';
import { recordedPluginTrustEventSchema, type PluginTrustRecord } from './trust.js';

export const localPluginIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const localPluginDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const absolutePath = z.string().refine((value) => path.isAbsolute(value) && !value.includes('\0'));

function normalizeManifest(manifest: PluginManifest): PluginManifest {
  // Optional fields with explicit undefined do not occur in a descriptor or persisted log.
  return JSON.parse(JSON.stringify(manifest)) as PluginManifest;
}

const normalizedManifestSchema = pluginManifestSchema.transform(normalizeManifest);

const explicitSelectionSchema = z
  .strictObject({
    manifest: normalizedManifestSchema,
    digest: localPluginDigestSchema,
    activationSequence: z.number().int().positive(),
    ready: z
      .strictObject({
        status: z.literal('ready'),
        id: localPluginIdSchema,
        manifest: normalizedManifestSchema,
        digest: localPluginDigestSchema,
        directory: absolutePath,
        entry: absolutePath,
      })
      .optional(),
    issue: z.strictObject({ code: z.string(), message: z.string() }).optional(),
  })
  .superRefine(({ manifest, digest, ready, issue }, context) => {
    if (ready === undefined) return;
    if (issue !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['issue'],
        message: 'Ready evidence and an issue are mutually exclusive',
      });
    }
    if (
      ready.id !== manifest.id ||
      ready.digest !== digest ||
      !isDeepStrictEqual(ready.manifest, manifest)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ready'],
        message: 'Ready evidence must match the selected identity and manifest',
      });
    }
  });

export const explicitLocalSelectionInputSchema = z
  .strictObject({
    stickyIds: z.array(localPluginIdSchema),
    selections: z.array(explicitSelectionSchema),
    deniedIds: z.array(localPluginIdSchema),
    trustEvents: z.array(recordedPluginTrustEventSchema),
  })
  .superRefine(({ stickyIds, selections, deniedIds }, context) => {
    const sticky = new Set(stickyIds);
    const selectionsById = selections.map(({ manifest }) => manifest.id);
    if (sticky.size !== stickyIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['stickyIds'],
        message: 'Plugin IDs must be unique',
      });
    }
    for (const [key, ids] of [
      ['selections', selectionsById],
      ['deniedIds', deniedIds],
    ] as const) {
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: 'custom', path: [key], message: 'Plugin IDs must be unique' });
      }
      if (ids.some((id) => !sticky.has(id))) {
        context.addIssue({ code: 'custom', path: [key], message: 'Plugin IDs must be sticky' });
      }
    }
  });

export function eligibleManagedLocalCandidates(
  explicit: Pick<ExplicitLocalSelectionInput, 'selections' | 'deniedIds'>,
  declarations: DiscoveryResult | undefined,
  reservedIds: ReadonlySet<string>,
  trust: ReadonlyMap<string, PluginTrustRecord>,
): ManagedLocalCandidate[] {
  if (declarations === undefined || declarations.truncated) return [];

  // An invalid entry or digest still leaves a parsed manifest's declaration intact.
  const claimed = new Set([...reservedIds, ...explicit.deniedIds]);
  for (const candidate of declarations.candidates) {
    if (candidate.manifest !== undefined) claimed.add(candidate.manifest.id);
  }
  return explicit.selections
    .flatMap(({ manifest, digest, activationSequence, ready }): ManagedLocalCandidate[] => {
      const record = trust.get(manifest.id);
      if (
        ready === undefined ||
        claimed.has(manifest.id) ||
        !record?.enabled ||
        record.digest !== digest ||
        !isDeepStrictEqual(normalizeManifest(record.manifest), manifest)
      ) {
        return [];
      }
      return [{ ...ready, manifest, origin: 'managed', activationSequence }];
    })
    .sort(compareIds);
}

export function eligibleLocalSourceCandidates(
  snapshot: LocalPluginSourceSnapshot,
): LocalSourceCandidate[] {
  return [
    ...eligibleLocalPlugins(snapshot).map((candidate) => ({
      ...candidate,
      origin: 'manual' as const,
    })),
    ...snapshot.managedEligible,
  ].sort(compareIds);
}

export function localSourceCandidateIdentity(candidate: LocalSourceCandidate): string {
  return candidate.origin === 'manual'
    ? identity(candidate)
    : JSON.stringify([candidate.id, candidate.digest, 'managed', candidate.activationSequence]);
}
