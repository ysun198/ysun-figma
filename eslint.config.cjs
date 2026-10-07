const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    files: [
      'src/**/*.js',
      'scripts/**/*.cjs',
      'test/**/*.cjs',
      'test-support/**/*.cjs',
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
      'scripts/**/*.cjs',
      'test/**/*.cjs',
      'test-support/**/*.cjs',
      'eslint.config.cjs',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: [
      'src/app-ui.js',
      'src/canvas-view.js',
      'src/ui.js',
      'src/account-reader.js',
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/app-ui.js'],
    languageOptions: { globals: { APP_VERSION: 'readonly' } },
  },
  {
    files: [
      'src/core.js',
      'src/account-reader.js',
      'src/design-queries.js',
      'src/version.js',
    ],
    languageOptions: { globals: { module: 'readonly' } },
  },
  {
    // These four files are concatenated, in order, into one native Figma script.
    files: [
      'src/core.js',
      'src/design-queries.js',
      'src/script-runtime.js',
      'src/native-runtime.js',
    ],
    languageOptions: {
      sourceType: 'script',
    },
  },
  {
    files: ['src/script-runtime.js'],
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
    files: ['src/native-runtime.js'],
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
