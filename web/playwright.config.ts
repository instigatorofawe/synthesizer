import { defineConfig } from '@playwright/test';

// The suite runs a server of its own, with its own database, so it isn't on the app's 5321: `pnpm e2e` can run beside
// `pnpm start`. E2E_PORT moves it elsewhere. The build trusts only 5321's origin for forms (vite.config.ts), and adapter-node
// fixes ORIGIN when it builds, so the server takes its scheme from a header the tests send, and knows its own origin.
const port = Number(process.env.E2E_PORT || 5331);

export default defineConfig({
	testDir: 'e2e',
	testMatch: '*Test.ts',
	workers: 1,
	timeout: 30000,
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		extraHTTPHeaders: { 'X-Forwarded-Proto': 'http' },
		launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
		// Kept only for a test that fails, for CI to upload.
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure'
	},
	webServer: {
		command: 'rm -rf .e2e && node build/index.js',
		port,
		reuseExistingServer: false,
		env: {
			HOST: '127.0.0.1',
			PORT: String(port),
			PROTOCOL_HEADER: 'x-forwarded-proto',
			DATABASE_PATH: '.e2e/Test.sqlite',
			BODY_SIZE_LIMIT: '64M'
		}
	}
});
