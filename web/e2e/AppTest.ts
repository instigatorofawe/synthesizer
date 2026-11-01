import { expect, test, type Page } from '@playwright/test';

async function startPlaying(page: Page, timeline = 'song') {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') problems.push(m.text());
	});
	await page.goto(`/timelines/${timeline}`);
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).toHaveText('1', { timeout: 10000 });
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	return problems;
}

const peaks = (page: Page) =>
	page.getByTestId('peak').evaluateAll((list) => list.map((e) => Number(e.getAttribute('data-peak'))));

test('the seeded library lists patches, timelines and a bundle', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('link', { name: 'Stereo lead' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Song' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Demo set' })).toBeVisible();
});

test('a timeline plays in an AudioWorklet and the scopes see every bus', async ({ page }) => {
	const problems = await startPlaying(page);
	await expect(page.getByTestId('voices')).not.toHaveText('0');
	await expect(page.getByText('Master', { exact: true })).toBeVisible();
	await expect(page.getByText('Lead', { exact: true }).first()).toBeVisible();
	await expect.poll(async () => (await peaks(page)).filter((p) => p > 0.01).length, { timeout: 8000 }).toBe(3);
	const before = Number(await page.getByTestId('tick').textContent());
	await page.waitForTimeout(400);
	expect(Number(await page.getByTestId('tick').textContent())).toBeGreaterThan(before);
	expect(problems).toEqual([]);
});

test('editing during playback swaps generations without stopping', async ({ page }) => {
	const problems = await startPlaying(page);
	await expect(page.getByTestId('voices')).not.toHaveText('0');
	const editor = page.getByLabel('Timeline JSON');
	const text = await editor.inputValue();
	const before = Number(await page.getByTestId('tick').textContent());
	await editor.fill(text.replace('"gain": 0.8', '"gain": 0.4'));
	await expect(page.getByTestId('generation')).toHaveText('2', { timeout: 8000 });
	expect(Number(await page.getByTestId('tick').textContent())).toBeGreaterThanOrEqual(before);
	// Taps were re-pointed at the new program's registers.
	await expect.poll(async () => (await peaks(page)).filter((p) => p > 0.01).length, { timeout: 8000 }).toBe(3);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	expect(problems).toEqual([]);
});

test('a compile from page load cannot race the first load', async ({ page }) => {
	// Slow every reply from the compiler, so the compile started at page load finishes after audio has started.
	await page.addInitScript(() => {
		window.Worker = class extends window.Worker {
			set onmessage(handler: (event: MessageEvent) => void) {
				super.onmessage = (event) => setTimeout(() => handler(event), 1200);
			}
		};
	});
	await page.goto('/timelines/song');
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).toHaveText('1', { timeout: 10000 });
	await page.waitForTimeout(2000);
	await expect(page.getByTestId('generation')).toHaveText('1');
});

test('rapid edits settle on the newest image, with scopes on its registers', async ({ page }) => {
	await startPlaying(page);
	await expect(page.getByTestId('voices')).not.toHaveText('0');
	const editor = page.getByLabel('Timeline JSON');
	const text = await editor.inputValue();
	// A send moves bus registers, so scopes left on an older report would read the wrong bus.
	const removed = text.replace(/"sends": \[[^\]]*\]/, '"sends": []');
	expect(removed).not.toBe(text);
	for (const version of [removed, text, removed]) {
		await editor.fill(version);
		await page.waitForTimeout(280); // Just past the debounce, so each compile starts while the last may be loading
	}
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await expect.poll(async () => (await peaks(page)).filter((p) => p > 0.01).length, { timeout: 8000 }).toBe(3);
});

test('a broken edit shows where it failed and the old image keeps playing', async ({ page }) => {
	await startPlaying(page);
	const editor = page.getByLabel('Timeline JSON');
	const text = await editor.inputValue();
	await editor.fill(text.replace('"slots": [\n    "lead"\n   ]', '"slots": [\n    "missing"\n   ]'));
	await expect(page.getByTestId('compile-error')).toContainText("no patch 'missing'");
	await expect(page.getByTestId('generation')).toHaveText('1');
	await expect(page.getByTestId('voices')).not.toHaveText('0');
});

test('seeking chases held notes and a knob works', async ({ page }) => {
	await startPlaying(page, 'ballad');
	await expect(page.getByTestId('voices')).toHaveText('3');
	const position = page.getByLabel('Position');
	await position.evaluate((e: HTMLInputElement) => {
		e.value = '2000';
		e.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await expect.poll(async () => Number(await page.getByTestId('tick').textContent())).toBeGreaterThanOrEqual(2000);
	await expect(page.getByTestId('voices')).toHaveText('3');
	const cutoff = page.getByLabel('cutoff').first();
	await cutoff.evaluate((e: HTMLInputElement) => {
		e.value = '6000';
		e.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await expect(page.getByTestId('voices')).toHaveText('3');
});

test('a timeline saves, and a stale tab is refused', async ({ page, context }) => {
	await page.goto('/timelines/ballad');
	const other = await context.newPage();
	await other.goto('/timelines/ballad');

	await page.getByLabel('Timeline name').fill('Ballad two');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved.')).toBeVisible();

	await other.getByLabel('Timeline name').fill('Stale');
	await other.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(other.getByText('changed elsewhere')).toBeVisible();

	await page.reload();
	await expect(page.getByLabel('Timeline name')).toHaveValue('Ballad two');
	await page.getByLabel('Timeline name').fill('Ballad');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved.')).toBeVisible();
});

test('a patch in use cannot be deleted, and says what an edit would change', async ({ page }) => {
	await page.goto('/patches/lead');
	await expect(page.getByTestId('used-by')).toContainText('2 timelines');
	await page.getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByText('used by')).toBeVisible();
});

test('a patch previews from the keyboard', async ({ page }) => {
	await page.goto('/patches/lead');
	await page.getByRole('button', { name: 'Start audio' }).click();
	const key = page.getByRole('button', { name: '60', exact: true });
	await expect(key).toBeVisible();
	await page.waitForTimeout(500);
	await key.dispatchEvent('pointerdown');
	await expect.poll(async () => Math.max(0, ...(await peaks(page))), { timeout: 8000 }).toBeGreaterThan(0.01);
	await key.dispatchEvent('pointerup');
});

test('a bundle exports with shared patches, and thin without them', async ({ page }) => {
	await page.goto('/bundles/demo-set');
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export saved bundle' }).click();
	const full = await download;
	expect(full.suggestedFilename()).toBe('Demo set.msimg');
	await expect(page.getByText('4 of 4 patches compiled in, 2 chunks shared between 2 programs')).toBeVisible();

	const second = page.waitForEvent('download');
	await page.getByLabel('Programs only').check();
	await page.getByRole('button', { name: 'Export saved bundle' }).click();
	await second;
	await expect(page.getByText('left out for a receiver that already has it')).toBeVisible();
});

test('a single timeline exports only what it reaches', async ({ page }) => {
	await page.goto('/timelines/ballad');
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export saved version' }).click();
	expect((await download).suggestedFilename()).toBe('Ballad.msimg');
});
