import { defineConfig } from '@playwright/test';

// The suite runs a server of its own, with its own database, so it isn't on the app's 5321: `pnpm e2e` can run beside
// `pnpm start`. E2E_PORT moves it elsewhere. The build trusts only 5321's origin for forms (vite.config.ts), and adapter-node
// fixes ORIGIN when it builds, so the server takes its scheme from a header the tests send, and knows its own origin.
const port = Number(process.env.E2E_PORT || 5331);

const ci = Boolean(process.env.CI);

export default defineConfig({
	testDir: 'e2e',
	testMatch: '*Test.ts',
	workers: 1,
	// Tests are independent (Fixtures.ts gives each a fresh library), so they may run in any order, inside a file as well: CI
	// shuffles them, seeded by the PR's number so a rerun replays the order. One worker, since they share the one server.
	fullyParallel: true,
	timeout: 30000,
	expect: { timeout: 5000 },
	// Keeps the library the server made at start, which each test is given a fresh copy of (Fixtures.ts).
	globalSetup: './e2e/GlobalSetup.ts',
	// On CI: a test.only left in a file fails the run rather than running alone, a run stops after 10 failures, since by then
	// something shared is broken, and the log names each test and its time, with a JSON report kept beside the traces.
	forbidOnly: ci,
	maxFailures: ci ? 10 : 0,
	// On CI a failed test runs once more, to tell a flake from a failure, and a test that passes only on its retry still fails
	// the run: the log names it as flaky, and nothing merges on a pass by luck.
	retries: ci ? 1 : 0,
	failOnFlakyTests: ci,
	reporter: ci ? [['list'], ['github'], ['json', { outputFile: 'test-results/Report.json' }]] : 'list',
	use: {
		// A click or a fill that waits this long for its target is waiting on something that won't come.
		actionTimeout: 10000,
		baseURL: `http://127.0.0.1:${port}`,
		extraHTTPHeaders: { 'X-Forwarded-Proto': 'http' },
		launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
		// Kept only for a test that fails, and its retry, for CI to upload.
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure-and-retries'
	},
	// The layout's own tests run at a laptop's two sizes: in the first project at Playwright's 1280 by 720, as every file that
	// sets no size does, and again at 1280 by 800.
	projects: [
		{ name: 'default' },
		{
			name: '1280x800',
			testMatch: /(Views|Room|BrowserAddress)Test\.ts$/,
			use: { viewport: { width: 1280, height: 800 } }
		}
	],
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
