// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SkillPicker } from '../src/features/skills/skill-picker.js';
import { useSessionSkills } from '../src/features/skills/use-session-skills.js';
import { skillCatalogSchema, type SkillSummary } from '../src/features/skills/skill-types.js';
import { planningSkill, projectSkill, skillCatalog } from './support/skill-fixtures.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Harness({ sessionId, root = 'root' }: { sessionId: string; root?: string }) {
  const state = useSessionSkills(sessionId, root);
  return (
    <>
      <button onClick={state.show}>技能列表</button>
      <button onClick={() => void state.refresh()}>外部刷新</button>
      <div aria-label="选择结果">
        {state.draft.selected.map((skill) => (
          <span key={skill.id}>
            {skill.name}:{skill.bundleSha256}
          </span>
        ))}
      </div>
      {state.open ? (
        <SkillPicker
          key={sessionId}
          sessionId={sessionId}
          catalog={state.catalogState.catalog}
          loading={state.catalogState.loading}
          error={state.catalogState.error}
          selected={state.draft.selected}
          onToggle={state.toggle}
          onRefresh={() => void state.refresh()}
          onClose={state.close}
        />
      ) : null}
    </>
  );
}
it('keeps late catalogs and previews from another Session out of the active picker', async () => {
  let finishA: (response: Response) => void = () => undefined;
  let previewA: (response: Response) => void = () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/sessions/A/skills')
        return new Promise<Response>((resolve) => {
          finishA = resolve;
        });
      if (path.endsWith('/preview'))
        return new Promise<Response>((resolve) => {
          previewA = resolve;
        });
      return Promise.resolve(Response.json(skillCatalog([projectSkill])));
    }),
  );
  const view = render(<Harness sessionId="A" />);
  fireEvent.click(screen.getByText('技能列表'));
  view.rerender(<Harness sessionId="B" />);
  fireEvent.click(screen.getByText('技能列表'));
  await screen.findByText(projectSkill.description);
  await act(async () => finishA(Response.json(skillCatalog([planningSkill]))));
  expect(screen.queryByText(planningSkill.description)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '预览 review-code' }));
  view.rerender(<Harness sessionId="C" />);
  fireEvent.click(screen.getByText('技能列表'));
  await act(async () =>
    previewA(Response.json({ schemaVersion: 1, skill: projectSkill, instructions: 'A/B旧预览' })),
  );
  expect(screen.queryByText('A/B旧预览')).toBeNull();
});
it('shows changed bundle identity and incomplete diagnostics without silently replacing the selection', async () => {
  let n = 0;
  const changed = { ...planningSkill, bundleSha256: 'e'.repeat(64) };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        n++ === 0
          ? skillCatalog([planningSkill])
          : {
              ...skillCatalog([changed]),
              complete: false,
              issues: [{ source: '用户技能', code: 'unreadable' }],
            },
      ),
    ),
  );
  render(<Harness sessionId="A" />);
  fireEvent.click(screen.getByText('技能列表'));
  fireEvent.click(await screen.findByRole('checkbox', { name: /weave-planning/ }));
  fireEvent.click(screen.getByRole('button', { name: '刷新技能' }));
  await screen.findByText(/目录尚未完整读取/);
  expect(screen.getByText(/内容已变化/)).toBeTruthy();
  expect(screen.getByLabelText('选择结果').textContent).toContain('b'.repeat(64));
  fireEvent.click(screen.getByRole('checkbox', { name: /weave-planning/ }));
  expect(screen.getByLabelText('选择结果').textContent).toContain('e'.repeat(64));
});
it('searches source labels and prevents selecting model-only Skills', async () => {
  const modelOnly: SkillSummary = { ...projectSkill, invocation: { user: false, model: true } };
  render(
    <SkillPicker
      sessionId="A"
      catalog={skillCatalogSchema.parse(skillCatalog([planningSkill, modelOnly]))}
      loading={false}
      error={undefined}
      selected={[]}
      onToggle={() => undefined}
      onRefresh={() => undefined}
      onClose={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText('搜索技能'), { target: { value: '当前项目' } });
  expect(screen.queryByText(planningSkill.description)).toBeNull();
  expect((screen.getByRole('checkbox', { name: /review-code/ }) as HTMLInputElement).disabled).toBe(
    true,
  );
});
it('clears incompatible project picks and retains builtins when the project root changes', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(skillCatalog())),
  );
  const view = render(<Harness sessionId="A" root="one" />);
  fireEvent.click(screen.getByText('技能列表'));
  fireEvent.click(await screen.findByRole('checkbox', { name: /weave-planning/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /review-code/ }));
  view.rerender(<Harness sessionId="A" root="two" />);
  await waitFor(() =>
    expect(screen.getByLabelText('选择结果').textContent).not.toContain('review-code'),
  );
  expect(screen.getByLabelText('选择结果').textContent).toContain('weave-planning');
});

it('keeps builtin choices but invalidates cached project catalogs when leaving and returning after a root change', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(skillCatalog())),
  );
  const view = render(<Harness sessionId="A" root="one" />);
  fireEvent.click(screen.getByText('技能列表'));
  fireEvent.click(await screen.findByRole('checkbox', { name: /review-code/ }));
  view.rerender(<Harness sessionId="B" root="two" />);
  view.rerender(<Harness sessionId="A" root="changed" />);
  expect(screen.getByLabelText('选择结果').textContent).not.toContain('review-code');
});

it('discards old instruction previews when the same Session changes project root', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/preview')
        ? Response.json({ schemaVersion: 1, skill: planningSkill, instructions: '旧根的预览' })
        : Response.json(skillCatalog()),
    ),
  );
  const view = render(<Harness sessionId="A" root="one" />);
  fireEvent.click(screen.getByText('技能列表'));
  fireEvent.click(await screen.findByRole('button', { name: '预览 weave-planning' }));
  await screen.findByText('旧根的预览');
  view.rerender(<Harness sessionId="A" root="two" />);
  expect(screen.queryByText('旧根的预览')).toBeNull();
});
it('shows ignored frontmatter fields and list-invalid field diagnostics', () => {
  const catalog = skillCatalogSchema.parse({
    ...skillCatalog([{ ...planningSkill, ignoredFields: ['allowed-tools', 'model'] }]),
    complete: false,
    issues: [{ source: 'User', code: 'invalid-document', field: 'license' }],
  });
  render(
    <SkillPicker
      sessionId="A"
      catalog={catalog}
      loading={false}
      error={undefined}
      selected={[]}
      onToggle={() => undefined}
      onRefresh={() => undefined}
      onClose={() => undefined}
    />,
  );
  expect(screen.getByText(/以下字段 Weave 不支持，已忽略：allowed-tools、model/)).toBeTruthy();
  expect(screen.getByText(/字段 license 不能写成列表/)).toBeTruthy();
});
