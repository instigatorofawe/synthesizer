import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// adapter-node assumes HTTPS unless a proxy says otherwise, so a loopback server over HTTP would fail SvelteKit's
// same-origin check on every form. This trusts only these two origins, and a form posted from any other site is refused.
export const PORT = 5321;

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter(),
			csrf: { trustedOrigins: [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`] }
		})
	],
	server: { fs: { allow: ['..'] } },
	// Vitest keeps transformed modules between runs, keyed on the source, but import.meta.glob expands in that transform. A file
	// added to examples/Recipes would change nothing it can see, and the recipe would read as null until the cache was deleted.
	test: { include: ['src/**/*Test.ts'], fsModuleCache: false }
});
