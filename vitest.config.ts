import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'apps/*/test/**/*.test.{ts,tsx}'],
    pool: 'forks',
    // vitest 默认把 CSS 文件（含 ?raw）替换成空串；Studio 的颜色变量守护测试需要读取 CSS 源码。
    css: { include: [/\.css\?raw$/] },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
