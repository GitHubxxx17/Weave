import { describe, expect, it } from 'vitest';
import { resolveSkillsDirectory } from '../src/skill-path.js';
describe('Skill root configuration', () => {
  it('prefers explicit path, environment and data directory without filesystem effects', () => {
    expect(
      resolveSkillsDirectory({ skillsDirectory: false, environment: { WEAVE_SKILLS_DIR: '/env' } }),
    ).toBe(false);
    expect(
      resolveSkillsDirectory({
        skillsDirectory: '/explicit',
        environment: { WEAVE_SKILLS_DIR: '/env' },
      }),
    ).toBe('/explicit');
    expect(resolveSkillsDirectory({ environment: { WEAVE_SKILLS_DIR: '/env' } })).toBe('/env');
    expect(resolveSkillsDirectory({ dataDirectory: '/data', environment: {} })).toBe(
      '/data/skills',
    );
    expect(
      resolveSkillsDirectory({ databaseFile: '/isolated/weave.sqlite', environment: {} }),
    ).toBe('/isolated/skills');
    expect(() => resolveSkillsDirectory({ skillsDirectory: '' })).toThrow();
  });
});
