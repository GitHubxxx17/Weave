import { describe, expect, it } from 'vitest';

import { prepareManagedRequest } from '../src/features/plugins/managed-plugin-api.js';
import {
  githubManagedPreviewSchema,
  managedCatalogSchema,
  managedManifestSchema,
  managedPreviewSchema,
  type ManagedReview,
} from '../src/features/plugins/managed-plugin-types.js';
import { pluginMarketplaceSchema } from '../src/features/plugins/plugin-marketplace-types.js';
import { declarativeManifest, declarativePreview } from './support/declarative-plugin-fixtures.js';
import {
  firstCandidate,
  managedCatalog,
  managedPlugin,
  managedPluginId,
} from './support/managed-plugin-fixtures.js';

const github = {
  repository: 'https://github.com/developer/skills',
  commit: 'a'.repeat(40),
  subdirectory: 'review',
};

describe('declarative Skill package wire mirrors', () => {
  it('accepts the same full manifest in local preview, GitHub preview and candidate history', () => {
    expect(managedPreviewSchema.parse(declarativePreview)).toEqual(declarativePreview);
    expect(githubManagedPreviewSchema.parse({ ...declarativePreview, github })).toEqual({
      ...declarativePreview,
      github,
    });
    const catalog = {
      ...managedCatalog,
      plugins: [
        {
          ...managedPlugin,
          candidates: managedPlugin.candidates.map((candidate) => ({
            ...candidate,
            manifest: { ...declarativeManifest, version: candidate.manifest.version },
          })),
        },
      ],
    };
    expect(managedCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(managedManifestSchema.parse(firstCandidate.manifest)).toEqual(firstCandidate.manifest);
  });

  it('uses the existing version-1 marketplace release without another artifact type', () => {
    const catalog = {
      schemaVersion: 1,
      hostVersion: '0.0.0',
      communityStatus: 'ready',
      entries: [
        {
          id: managedPluginId,
          kind: 'github',
          category: 'community',
          name: 'Review Skills',
          description: 'Review instructions',
          publisher: 'Independent Developer',
          tags: ['Skills'],
          releases: [
            { manifest: declarativeManifest, source: github, compatibility: 'compatible' },
          ],
        },
      ],
    };
    expect(pluginMarketplaceSchema.parse(catalog)).toEqual(catalog);
  });

  it('sends the exact reviewed manifest and digest in the existing activation request', () => {
    const review = {
      kind: 'activate',
      pluginId: managedPluginId,
      digest: declarativePreview.candidate.digest,
      manifest: managedManifestSchema.parse(declarativeManifest),
      previousSelection: null,
      expectedInstallSequence: 3,
      expectedTrustSequence: 4,
      intent: 'activate',
    } satisfies ManagedReview;
    expect(JSON.parse(prepareManagedRequest(review, 'data-review').body)).toEqual({
      requestId: 'data-review',
      digest: review.digest,
      manifest: declarativeManifest,
      previousSelection: null,
      expectedInstallSequence: 3,
      expectedTrustSequence: 4,
      intent: 'activate',
    });
  });

  it.each([
    { host: 'future-host' },
    { capabilities: ['tool'] },
    { capabilities: ['skill', 'tool'] },
    { capabilities: ['skill', 'skill'] },
    { permissions: ['workspace:read'] },
    { contributes: {} },
    { contributes: { skills: [] } },
    { contributes: { skills: ['Bad Name'] } },
    { contributes: { skills: ['review-change', 'review-change'] } },
    { contributes: { skills: ['review-change'], tools: [] } },
    { contributes: { skills: Array.from({ length: 17 }, (_, index) => `review-${index}`) } },
    { entry: 'index.mjs' },
    { artifactType: 'skills' },
  ])('rejects a declarative claim that violates the closed data-package contract: %j', (change) => {
    expect(managedManifestSchema.safeParse({ ...declarativeManifest, ...change }).success).toBe(
      false,
    );
  });
});
