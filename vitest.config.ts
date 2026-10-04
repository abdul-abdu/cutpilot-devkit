import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url));

// Tests import the packages from source, so `pnpm test` needs no build
// (except the SDK harness tests, which start real plugin processes against dist/).
const alias = [{ find: /^@nodcut\/(plugin-api|plugin-sdk)$/, replacement: pkg('$1/src/index.ts') }];

export default defineConfig({
  resolve: { alias },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'plugins/*/src/**/*.test.ts',
      'plugins/*.test.ts',
      'scripts/*.test.ts',
      'examples/*.test.ts',
    ],
  },
});
