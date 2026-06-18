// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import sonarjs from 'eslint-plugin-sonarjs';
import prettierPlugin from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', '.astro/**', 'node_modules/**', 'eslint.config.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Astro plugin (includes flat/recommended which turns off prettier/prettier
  // for *.astro/*.js and *.astro/*.ts virtual files)
  ...astro.configs['flat/recommended'],
  sonarjs.configs.recommended,
  prettierPlugin,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Disable prettier/prettier for .astro files and their virtual script blocks.
  // The standalone prettier CLI handles Astro formatting; the ESLint prettier
  // plugin cannot parse Astro-specific attributes (is:inline, client:load, etc.).
  {
    files: ['**/*.astro', '**/*.astro/*.js', '**/*.astro/*.ts'],
    rules: {
      'prettier/prettier': 'off',
    },
  },
);
