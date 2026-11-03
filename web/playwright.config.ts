import { defineConfig } from '@playwright/test';

const port = 5321;

export default defineConfig({
	testDir: 'e2e',
	testMatch: '*Test.ts',
	workers: 1,
	timeout: 30000,
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
		// Kept only for a test that fails, for CI to upload.
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure'
	},
	webServer: {
		command: 'rm -rf .e2e && node build/index.js',
		port,
		reuseExistingServer: false,
		env: { HOST: '127.0.0.1', PORT: String(port), DATABASE_PATH: '.e2e/Test.sqlite', BODY_SIZE_LIMIT: '64M' }
	}
});
