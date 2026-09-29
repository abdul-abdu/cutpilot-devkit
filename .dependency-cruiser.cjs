/**
 * Boundaries for the devkit. Everything here is public (MIT) and must build without the private
 * CutPilot app repo, so nothing may reach outside this repo except npm packages.
 */
const notTest = '(\\.test\\.ts$|/test-helpers/)';

module.exports = {
  forbidden: [
    {
      name: 'plugin-api-only-zod',
      comment:
        'plugin-api describes plugins for the engine, the SDK and third parties: it imports only zod (no node:*, no other package).',
      severity: 'error',
      from: { path: '^packages/plugin-api/src', pathNot: notTest },
      to: {
        pathNot: ['^packages/plugin-api/', 'node_modules/zod/', 'node_modules/\\.pnpm/zod@'],
      },
    },
    {
      name: 'plugin-sdk-only-plugin-api',
      comment: 'Of this repo, plugin-sdk may import only plugin-api.',
      severity: 'error',
      from: { path: '^packages/plugin-sdk/src' },
      to: { path: '^packages/(?!plugin-sdk/|plugin-api/)' },
    },
    {
      name: 'plugins-only-sdk',
      comment:
        'Plugins are built exactly like third-party ones: only the SDK and plugin-api, never another plugin.',
      severity: 'error',
      from: { path: '^plugins/([^/]+)/' },
      to: { path: ['^packages/(?!plugin-sdk/|plugin-api/)', '^plugins/(?!$1/)'] },
    },
    {
      name: 'no-plugin-internals',
      comment: 'Plugins run as separate processes: no package imports a plugin.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^plugins/' },
    },
    {
      name: 'stay-in-repo',
      comment:
        'Nothing reaches outside this repo (e.g. into a sibling cutpilot checkout): the devkit must build on its own.',
      severity: 'error',
      from: { path: '^(packages|plugins)/' },
      to: { path: '^\\.\\./' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules', '^\\.\\./'] },
    exclude: { path: '(^|/)dist/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.test.json' },
    combinedDependencies: true,
    preserveSymlinks: false,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.cts', '.js', '.d.ts'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
