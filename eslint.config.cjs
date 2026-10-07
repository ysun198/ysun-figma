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
      'src/workbench/app-ui.js',
      'src/workbench/canvas-view.js',
      'src/figma/ui.js',
      'src/host/account-reader.js',
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/workbench/app-ui.js'],
    languageOptions: { globals: { APP_VERSION: 'readonly' } },
  },
  {
    files: [
      'src/shared/core.js',
      'src/host/account-reader.js',
      'src/figma/design-queries.js',
      'src/shared/version.js',
    ],
    languageOptions: { globals: { module: 'readonly' } },
  },
  {
    // These four files are concatenated, in order, into one native Figma script.
    files: [
      'src/shared/core.js',
      'src/figma/design-queries.js',
      'src/figma/script-runtime.js',
      'src/figma/native-runtime.js',
    ],
    languageOptions: {
      sourceType: 'script',
    },
  },
  {
    files: ['src/figma/script-runtime.js'],
    languageOptions: {
      globals: {
        figma: 'readonly',
        createDesignQueries: 'readonly',
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
        formatBridgeError: 'readonly',
        validArtifactName: 'readonly',
      },
    },
  },
];
