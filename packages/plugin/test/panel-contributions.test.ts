import { describe, expect, it } from 'vitest';
import {
  attributedPanelSchema,
  createPluginKernel,
  createPluginSdk,
  definePlugin,
  panelsExtensionPoint,
  pluginManifestSchema,
  type AttributedPanel,
  type DeclarativePanel,
  type PluginManifest,
} from '../src/index.js';
const panel: DeclarativePanel = {
  schemaVersion: 1,
  id: 'report',
  title: 'Report',
  icon: 'info',
  placement: 'right',
  sources: [],
  blocks: [{ id: 'summary', type: 'text', value: { literal: 'Ready' } }],
};
function manifest(id = 'quality-report', over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id,
    name: 'Quality',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['panel'],
    contributes: { panels: ['report'] },
    ...over,
  };
}
describe('governed declarative panel contributions', () => {
  it('delivers a detached frozen attributed definition and accounts accepted panels', async () => {
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest(),
        setup(env) {
          env.contribute(panelsExtensionPoint, (api) => api.addPanel(panel));
        },
      }),
    );
    const generation = await kernel.seal();
    const delivered: AttributedPanel[] = [];
    kernel.extensions.collect(panelsExtensionPoint, {
      addPanel(value) {
        delivered.push(attributedPanelSchema.parse(value));
        expect(Object.isFrozen(value)).toBe(true);
        expect(Object.isFrozen(value.blocks[0])).toBe(true);
      },
    });
    expect(delivered).toEqual([{ ...panel, pluginId: 'quality-report' }]);
    expect(delivered[0]).not.toBe(panel);
    expect(generation.plugins()[0]?.contributed.panels).toEqual(['report']);
    expect(Object.isFrozen(generation.plugins()[0]?.contributed.panels)).toBe(true);
    await kernel.dispose();
  });
  it('uses real SDK panel vocabulary', async () => {
    const sdk = createPluginSdk();
    expect(sdk.panelsExtensionPoint).toBe(panelsExtensionPoint);
    expect(sdk.cloneDeclarativePanel(panel)).toEqual(panel);
    expect(sdk.attributedPanelSchema).toBe(attributedPanelSchema);
    expect(sdk.panelLimits.definitionBytes).toBe(65536);
    expect(sdk.declarativePanelSchema.parse(panel)).toEqual(panel);
  });
  it.each([{ contributes: {} }, { contributes: undefined }])(
    'requires an explicit declared panel name %j',
    async (over) => {
      const kernel = createPluginKernel();
      await kernel.register({
        manifest: manifest('quality-report', over),
        setup(env) {
          env.contribute(panelsExtensionPoint, (api) => api.addPanel(panel));
        },
      });
      await kernel.seal();
      let additions = 0;
      expect(() =>
        kernel.extensions.collect(panelsExtensionPoint, {
          addPanel() {
            additions += 1;
          },
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'plugin-contributes-exceeds-manifest',
          pluginId: 'quality-report',
        }),
      );
      expect(additions).toBe(0);
      expect(kernel.plugins()[0]?.contributed.panels).toEqual([]);
      await kernel.dispose();
    },
  );
  it('rejects contribution without the panel capability before author callback', async () => {
    const kernel = createPluginKernel();
    let called = false;
    await expect(
      kernel.register({
        manifest: manifest('quality-report', { capabilities: ['tool'], contributes: undefined }),
        setup(env) {
          env.contribute(panelsExtensionPoint, () => {
            called = true;
          });
        },
      }),
    ).rejects.toMatchObject({ code: 'plugin-capability-not-declared', pluginId: 'quality-report' });
    expect(called).toBe(false);
    await kernel.dispose();
  });
  it('rejects a duplicate across separate owner callbacks before a second host add', async () => {
    const kernel = createPluginKernel();
    await kernel.register({
      manifest: manifest(),
      setup(env) {
        for (let index = 0; index < 2; index += 1)
          env.contribute(panelsExtensionPoint, (api) => api.addPanel(panel));
      },
    });
    await kernel.seal();
    let additions = 0;
    expect(() =>
      kernel.extensions.collect(panelsExtensionPoint, {
        addPanel() {
          additions += 1;
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'plugin-invalid-definition', pluginId: 'quality-report' }),
    );
    expect(additions).toBe(1);
    expect(kernel.plugins()[0]?.contributed.panels).toEqual(['report']);
    await kernel.dispose();
  });
  it('allows the same local panel ID for different owners', async () => {
    const kernel = createPluginKernel();
    const delivered: AttributedPanel[] = [];
    for (const id of ['one', 'two'])
      await kernel.register({
        manifest: manifest(id),
        setup(env) {
          env.contribute(panelsExtensionPoint, (api) => api.addPanel(panel));
        },
      });
    await kernel.seal();
    kernel.extensions.collect(panelsExtensionPoint, {
      addPanel(value) {
        delivered.push(attributedPanelSchema.parse(value));
      },
    });
    expect(delivered.map((value) => value.pluginId)).toEqual(['one', 'two']);
    expect(kernel.plugins().map((value) => value.contributed.panels)).toEqual([
      ['report'],
      ['report'],
    ]);
    await kernel.dispose();
  });
  it('rejects author-supplied owner spoofing and attributes invalid definition to its real owner', async () => {
    const kernel = createPluginKernel();
    await kernel.register({
      manifest: manifest(),
      setup(env) {
        env.contribute(panelsExtensionPoint, (api) =>
          api.addPanel({ ...panel, pluginId: 'forged' } as DeclarativePanel),
        );
      },
    });
    await kernel.seal();
    let additions = 0;
    expect(() =>
      kernel.extensions.collect(panelsExtensionPoint, {
        addPanel() {
          additions += 1;
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'plugin-invalid-definition', pluginId: 'quality-report' }),
    );
    expect(additions).toBe(0);
    expect(kernel.plugins()[0]?.contributed.panels).toEqual([]);
    await kernel.dispose();
  });
  it('never accounts false host acceptance and permits a later successful retry', async () => {
    for (const retry of [false, true]) {
      const kernel = createPluginKernel();
      await kernel.register({
        manifest: manifest(),
        setup(env) {
          env.contribute(panelsExtensionPoint, (api) => {
            api.addPanel(panel);
            if (retry) api.addPanel(panel);
          });
        },
      });
      const generation = await kernel.seal();
      let calls = 0;
      kernel.extensions.collect(panelsExtensionPoint, {
        addPanel() {
          calls += 1;
          if (calls === 1) return false;
        },
      });
      expect(generation.plugins()[0]?.contributed.panels).toEqual(retry ? ['report'] : []);
      await kernel.dispose();
    }
  });
  it('attributes a throwing host acceptance and records no panel', async () => {
    const kernel = createPluginKernel();
    await kernel.register({
      manifest: manifest(),
      setup(env) {
        env.contribute(panelsExtensionPoint, (api) => api.addPanel(panel));
      },
    });
    await kernel.seal();
    expect(() =>
      kernel.extensions.collect(panelsExtensionPoint, {
        addPanel() {
          throw new Error('host refuses');
        },
      }),
    ).toThrowError(expect.objectContaining({ pluginId: 'quality-report' }));
    expect(kernel.plugins()[0]?.contributed.panels).toEqual([]);
    await kernel.dispose();
  });
  it('permits eight declared panels and rejects manifest overflow', async () => {
    const ids = Array.from({ length: 8 }, (_, index) => `report-${index}`);
    const kernel = createPluginKernel();
    await kernel.register({
      manifest: manifest('quality-report', { contributes: { panels: ids } }),
      setup(env) {
        for (const id of ids)
          env.contribute(panelsExtensionPoint, (api) => api.addPanel({ ...panel, id }));
      },
    });
    await kernel.seal();
    kernel.extensions.collect(panelsExtensionPoint, { addPanel() {} });
    expect(kernel.plugins()[0]?.contributed.panels).toEqual(ids);
    expect(
      pluginManifestSchema.safeParse(
        manifest('quality-report', { contributes: { panels: [...ids, 'report-8'] } }),
      ).success,
    ).toBe(false);
    await kernel.dispose();
  });
});
describe('optional panel manifest vocabulary', () => {
  it('requires panel capability for declared panel names', () => {
    expect(pluginManifestSchema.safeParse(manifest()).success).toBe(true);
    expect(
      pluginManifestSchema.safeParse(manifest('quality-report', { capabilities: ['tool'] }))
        .success,
    ).toBe(false);
  });
  it('rejects invalid/duplicate names and keeps declarative hosts Skills-only', () => {
    for (const panels of [['Bad'], ['a'.repeat(65)], ['report', 'report']])
      expect(
        pluginManifestSchema.safeParse(manifest('quality-report', { contributes: { panels } }))
          .success,
      ).toBe(false);
    expect(
      pluginManifestSchema.safeParse(
        manifest('quality-report', { host: 'declarative', permissions: [] }),
      ).success,
    ).toBe(false);
  });
  it('bounds panel owner metadata without tightening legacy plugin metadata', () => {
    const oversized = [
      { id: 'a'.repeat(65) },
      { name: 'n'.repeat(121) },
      { version: `${'1'.repeat(61)}.0.0` },
    ];
    for (const over of oversized) {
      expect(pluginManifestSchema.safeParse(manifest('quality-report', over)).success).toBe(false);
      expect(
        pluginManifestSchema.safeParse(
          manifest('quality-report', { ...over, capabilities: ['tool'], contributes: undefined }),
        ).success,
      ).toBe(true);
    }
  });
});
