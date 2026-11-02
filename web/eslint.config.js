// Lints what the hooks and CI check. Formatting is Prettier's, so the rules that would argue with it are off.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default defineConfig(
	{
		ignores: [
			'build/',
			'.svelte-kit/',
			'.e2e/',
			'test-results/',
			'playwright-report/',
			'src/lib/wasm/*.js',
			'static/wasm/'
		]
	},
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// `const { [key]: _, ...rest } = value` is how a copy leaves one key out.
			'@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', ignoreRestSiblings: true }],
			// A plain Set or Map here is never state: it is a cache, a set of held keys, something built inside a derivation, or
			// the value of a $state.raw that is replaced rather than changed.
			'svelte/prefer-svelte-reactivity': 'off',
			// This exists for an app served under a base path. This one is served at the root, and its links change only the query.
			'svelte/no-navigation-without-resolve': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: { parserOptions: { parser: ts.parser, extraFileExtensions: ['.svelte'] } }
	},
	{
		files: ['static/worklet/**/*.js'],
		languageOptions: { globals: { ...globals.audioWorklet } }
	}
);
