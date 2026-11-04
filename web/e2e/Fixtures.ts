import { resolve } from 'node:path';
import { test as base, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { installGates } from './Gates.ts';

// What every test file imports in place of @playwright/test (a lint keeps it so). Each test:
// - starts from the same library: the one the server made at start, which GlobalSetup.ts keeps as a template, is copied back
//   over the server's own with SQLite's backup, so no test sees what another left, and the order tests run in doesn't matter;
// - gets a page whose goto and reload wait until it has hydrated, since what is typed or clicked before then is lost;
// - accepts the "leave with unsaved edits?" dialog, since a test that leaves means to;
// - when it fails, has the page's console, the engine's state and the audio context's events attached to its report, which is
//   most of what a failure seen only on CI needs.
// Off unless asked, a stress run (scripts/E2eStress.sh) slows the page as a slower machine would: E2E_CPU throttles its main
// thread that many times, and E2E_COMPILE_DELAY and E2E_LOAD_DELAY hold each compile's answer and each image on its way to the
// engine for that many milliseconds, through the page's own boundaries (Gates.ts). Nothing else about the app changes.
export * from '@playwright/test';

const live = resolve(import.meta.dirname, '../.e2e/Test.sqlite');
export const template = resolve(import.meta.dirname, '../.e2e/Template.sqlite');

const stress = {
	cpu: Number(process.env.E2E_CPU || 1),
	compile: Number(process.env.E2E_COMPILE_DELAY || 0),
	load: Number(process.env.E2E_LOAD_DELAY || 0)
};

// A load waits for the page to hydrate, unless it failed, as an error page never does.
export async function hydrated<T extends { ok(): boolean } | null>(page: Page, response: T) {
	if (response?.ok()) await page.locator('body[data-hydrated]').waitFor({ state: 'attached' });
	return response;
}

// A page the test opens itself, such as a second tab, behaves as the one it is given.
export function prepare(page: Page) {
	const goto = page.goto.bind(page);
	const reload = page.reload.bind(page);
	page.goto = async (...args) => hydrated(page, await goto(...args));
	page.reload = async (...args) => hydrated(page, await reload(...args));
	page.on('dialog', (dialog) => dialog.accept());
	return page;
}

// What the indicators the tests wait on said when the test ended.
const indicators = (page: Page) =>
	page.evaluate(() => {
		const read = (testid: string) => {
			const element = document.querySelector(`[data-testid="${testid}"]`);
			if (!element) return null;
			const data = Object.fromEntries(
				[...element.attributes].filter((a) => /^(data|aria)-/.test(a.name)).map((a) => [a.name, a.value])
			);
			return { ...data, text: element.textContent?.trim().slice(0, 200) };
		};
		return Object.fromEntries(
			['status', 'state', 'generation', 'compiles', 'tick', 'voices', 'hearing', 'unsaved'].map((id) => [id, read(id)])
		);
	});

export const test = base.extend<{ library: void }>({
	library: [
		// Playwright reads which fixtures a fixture needs from the pattern of its first argument, so it must be one, empty here.
		// eslint-disable-next-line no-empty-pattern
		async ({}, use) => {
			const source = new Database(template, { readonly: true });
			await source.backup(live);
			source.close();
			await use();
		},
		{ auto: true }
	],
	page: async ({ page }, use, testInfo) => {
		const said: string[] = [];
		page.on('console', (message) => said.push(`${message.type()}: ${message.text()}`));
		page.on('pageerror', (error) => said.push(`page error: ${error.message}`));
		const audio: string[] = [];
		const cdp = await page.context().newCDPSession(page);
		cdp.on('WebAudio.contextCreated', ({ context }) => audio.push(`created: ${JSON.stringify(context)}`));
		cdp.on('WebAudio.contextChanged', ({ context }) => audio.push(`changed: ${JSON.stringify(context)}`));
		await cdp.send('WebAudio.enable');
		if (stress.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: stress.cpu });
		if (stress.compile || stress.load) await installGates(page, [], { compile: stress.compile, load: stress.load });

		await use(prepare(page));

		if (testInfo.status === testInfo.expectedStatus) return;
		const state = await indicators(page).catch((error: Error) => ({ unreadable: error.message }));
		await testInfo.attach('indicators', { body: JSON.stringify(state, null, 1), contentType: 'application/json' });
		await testInfo.attach('console', { body: said.join('\n') || '(nothing)', contentType: 'text/plain' });
		await testInfo.attach('audio context', { body: audio.join('\n') || '(none made)', contentType: 'text/plain' });
	}
});
