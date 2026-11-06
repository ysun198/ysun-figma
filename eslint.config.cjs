const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    files: [
      'src/**/*.js',
      'src/**/*.cjs',
      'scripts/**/*.cjs',
      'test/**/*.cjs',
      'eslint.config.cjs',
    ],
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['src/**/*.js', 'src/**/*.cjs'],
    // Keep production functions reviewable; a growing dispatcher should expose
    // its actual responsibilities before it becomes another branching monolith.
    rules: { complexity: ['error', 25], 'max-depth': ['error', 4] },
  },
  {
    files: [
      'src/host/**/*.cjs',
      'scripts/**/*.cjs',
      'test/**/*.cjs',
      'eslint.config.cjs',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: [
      'src/figma/ui.js',
      'src/host/account-reader.js',
      'src/host/editor-reader.js',
      'src/host/community-reader.js',
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'src/shared/core.js',
      'src/host/account-reader.js',
      'src/host/editor-reader.js',
      'src/host/community-reader.js',
      'src/figma/design-queries.js',
      'src/shared/version.js',
    ],
    languageOptions: { globals: { module: 'readonly' } },
  },
  {
    // Native source files are concatenated into one Figma script.
    files: [
      'src/shared/core.js',
      'src/figma/observation.js',
      'src/figma/design-queries.js',
      'src/figma/script-runtime.js',
      'src/figma/native-runtime.js',
      'src/figma/widget-runtime.js',
      'src/figma/dev-runtime.js',
    ],
    languageOptions: {
      sourceType: 'script',
      globals: { setTimeout: 'readonly', clearTimeout: 'readonly' },
    },
  },
  {
    files: ['src/figma/design-queries.js', 'src/figma/queries/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { setTimeout: 'readonly', clearTimeout: 'readonly' },
    },
  },
  {
    files: ['src/figma/script-runtime.js'],
    languageOptions: {
      globals: {
        figma: 'readonly',
        createDesignQueries: 'readonly',
        nativeObservation: 'readonly',
        formatBridgeError: 'readonly',
        validArtifactName: 'readonly',
      },
    },
  },
  {
    files: ['src/figma/native-runtime.js'],
    languageOptions: {
      globals: {
        figma: 'readonly',
        __html__: 'readonly',
        FIGMA_PLUGIN_BUILD: 'readonly',
        BRIDGE_RUNTIME_VERSION: 'readonly',
        BRIDGE_PROTOCOL_VERSION: 'readonly',
        executeScript: 'readonly',
        startWidgetPlugin: 'readonly',
        startCodegenPlugin: 'readonly',
        formatBridgeError: 'readonly',
        validArtifactName: 'readonly',
      },
    },
  },
  {
    files: ['src/figma/widget-runtime.js', 'src/figma/dev-runtime.js'],
    languageOptions: {
      globals: { figma: 'readonly', startNativePlugin: 'readonly' },
    },
  },
];
