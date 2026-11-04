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
	},
	{
		// Every e2e file takes test and expect from Fixtures.ts, which gives each test a fresh library and a page that waits to
		// hydrate. Only types may come from Playwright directly.
		files: ['e2e/**/*.ts'],
		ignores: ['e2e/Fixtures.ts', 'e2e/GlobalSetup.ts'],
		rules: {
			'no-restricted-syntax': [
				'error',
				{
					// How many images or compiles an edit makes depends on how quickly things came (Engine.ts, rule 2).
					selector:
						"CallExpression[callee.property.name='toHaveText'][arguments.0.value=/^[0-9]+$/][callee.object.arguments.0.callee.property.name='getByTestId'][callee.object.arguments.0.arguments.0.value=/^(generation|compiles)$/]",
					message:
						'Counting images or compiles: read the count before, act, and wait for it to change (swappedFrom), or for newestPlays. Where the count is the claim, say why in a disable comment.'
				},
				{
					// Ctrl on Linux and Windows, ⌘ on a Mac: a key named for one platform tests nothing on the other.
					selector: 'Literal[value=/^(Control|Meta)\\+/]',
					message: "Use 'ControlOrMeta+…', which is Mod on every platform."
				}
			],
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{
					paths: [
						{
							name: '@playwright/test',
							message: "Import from './Fixtures.ts', which gives each test a fresh library.",
							allowTypeImports: true
						}
					]
				}
			]
		}
	}
);
