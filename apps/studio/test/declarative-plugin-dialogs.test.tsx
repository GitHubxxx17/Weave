// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ManagedPluginDialog,
  type ManagedDraft,
} from '../src/features/plugins/managed-plugin-dialog.js';
import { managedManifestSchema } from '../src/features/plugins/managed-plugin-types.js';
import { createPluginReview } from '../src/features/plugins/plugin-review.js';
import { PluginTrustDialog } from '../src/features/plugins/plugin-trust-dialog.js';
import { pluginListItemSchema } from '../src/features/plugins/plugin-types.js';
import { declarativeManifest, declarativePreview } from './support/declarative-plugin-fixtures.js';
import {
  firstDigest,
  managedManifest,
  managedPluginId,
} from './support/managed-plugin-fixtures.js';

afterEach(cleanup);

describe('declarative package review disclosures', () => {
  it.each(['import', 'activate', 'rollback', 'enable'] as const)(
    'reviews %s as text data and forwards the unchanged explicit review',
    async (action) => {
      const manifest = managedManifestSchema.parse(declarativeManifest);
      const draft: ManagedDraft =
        action === 'import'
          ? { review: { kind: 'import', preview: declarativePreview }, sourceDirectory: '/skills' }
          : action === 'enable'
            ? {
                review: {
                  kind: 'enable',
                  pluginId: managedPluginId,
                  selectedDigest: firstDigest,
                  expectedInstallSequence: 3,
                  expectedTrustSequence: 4,
                },
                selectedManifest: manifest,
              }
            : {
                review: {
                  kind: 'activate',
                  pluginId: managedPluginId,
                  digest: firstDigest,
                  manifest,
                  intent: action === 'rollback' ? 'rollback' : 'activate',
                  previousSelection: action === 'rollback' ? 'b'.repeat(64) : null,
                  expectedInstallSequence: 3,
                  expectedTrustSequence: 4,
                },
              };
      const onSubmit = vi.fn(async () => ({ kind: 'saved' as const }));
      render(
        <ManagedPluginDialog
          draft={draft}
          blocked={false}
          onSubmit={onSubmit}
          onCancel={() => {}}
          onReviewAgain={() => {}}
          getFallbackFocus={() => null}
        />,
      );
      const dialog = within(screen.getByRole('dialog'));
      expect(dialog.getByText('Skills 文本包')).toBeTruthy();
      expect(dialog.getByText('无可执行入口')).toBeTruthy();
      expect(dialog.getByText('review-change')).toBeTruthy();
      expect(dialog.queryByText(/插件代码拥有与 Weave/)).toBeNull();
      if (action !== 'import') {
        const description = document.getElementById(
          screen.getByRole('dialog').getAttribute('aria-describedby') ?? '',
        );
        expect(description?.textContent).toContain('工具权限');
      }
      expect(onSubmit).not.toHaveBeenCalled();
      const label = { import: '导入', activate: '激活', rollback: '回退', enable: '启用' }[action];
      fireEvent.click(dialog.getByRole('button', { name: `确认${label}` }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(draft.review));
    },
  );

  it('retains executable disclosure for an ESM plugin that also contributes Skills', () => {
    render(
      <ManagedPluginDialog
        draft={{
          review: {
            kind: 'activate',
            pluginId: managedPluginId,
            digest: firstDigest,
            manifest: {
              ...managedManifest,
              capabilities: [...managedManifest.capabilities, 'skill'],
              contributes: { ...managedManifest.contributes, skills: ['review-change'] },
            },
            previousSelection: null,
            expectedInstallSequence: 3,
            expectedTrustSequence: 4,
            intent: 'activate',
          },
        }}
        blocked={false}
        onSubmit={async () => ({ kind: 'saved' })}
        onCancel={() => {}}
        onReviewAgain={() => {}}
        getFallbackFocus={() => null}
      />,
    );
    expect(screen.getByText(/插件代码拥有与 Weave/)).toBeTruthy();
    expect(screen.queryByText('无可执行入口')).toBeNull();
  });

  it('uses the same validated text package disclosure for manual local trust and content updates', () => {
    const manifest = managedManifestSchema.parse(declarativeManifest);
    const parsed = pluginListItemSchema.parse({
      ...manifest,
      origin: 'local',
      state: 'changed',
      provides: { tools: [], providers: [], promptSections: [], services: [], skills: [] },
      local: {
        directory: '/skills',
        digest: firstDigest,
        enabled: false,
        manifest,
        trusted: { digest: 'c'.repeat(64), trustedAt: 'today', manifest },
      },
    });
    const review = createPluginReview(parsed);
    expect(review).toBeDefined();
    render(
      <PluginTrustDialog
        review={review!}
        busy={false}
        onCancel={() => {}}
        onTrust={async () => {}}
        getFallbackFocus={() => null}
      />,
    );
    expect(screen.getByText('Skills 文本包')).toBeTruthy();
    expect(screen.getByText('无可执行入口')).toBeTruthy();
    expect(screen.getByText('声明没有变化，但文本包内容已更新')).toBeTruthy();
    expect(screen.queryByText(/这个插件的代码会/)).toBeNull();
  });

  it.each([
    { capabilities: ['tool'] },
    { permissions: ['workspace:read'] },
    { contributes: { skills: ['review-change'], tools: [] } },
    { unrecognizedExecutableField: 'run.js' },
  ])('rejects a manual manifest claiming a text-only host with invalid shape: %j', (change) => {
    expect(
      pluginListItemSchema.safeParse({
        ...declarativeManifest,
        origin: 'local',
        state: 'pending-trust',
        provides: { tools: [], providers: [], promptSections: [], services: [] },
        local: {
          directory: '/skills',
          digest: firstDigest,
          enabled: false,
          manifest: { ...declarativeManifest, ...change },
        },
      }).success,
    ).toBe(false);
  });
});
