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
	await expect.poll(async () => (await peaks(page)).filter((p) => p > 0.01).length, { timeout: 8000 }).toBe(4);
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
	await expect.poll(async () => (await peaks(page)).filter((p) => p > 0.01).length, { timeout: 8000 }).toBe(4);
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
	await expect.poll(async () => (await peaks(page)).filter((p) => p > 0.01).length, { timeout: 8000 }).toBe(4);
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
	// A shared LFO waits for the transport, and this page has no Play button.
	await expect(page.getByTestId('engine')).toHaveAttribute('data-playing', 'true', { timeout: 10000 });
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

async function newPatch(page: Page, name: string) {
	await page.goto('/');
	await page.getByLabel('New patch name').fill(name);
	await page.getByLabel('New patch name').press('Enter');
	await page.waitForURL(/\/patches\//);
	await expect(page.getByTestId('graph')).toBeVisible();
}

async function drag(page: Page, from: string, to: string) {
	const start = await page.getByTestId(from).boundingBox();
	const end = await page.getByTestId(to).boundingBox();
	await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
	await page.mouse.down();
	await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, { steps: 5 });
	await page.mouse.up();
}

test('the graph editor draws a patch and colours its wires by rate', async ({ page }) => {
	await page.goto('/patches/lead');
	await expect(page.getByTestId('graph')).toBeVisible();
	await expect(page.locator('[data-testid^="node-"]').first()).toBeVisible();
	await expect(page.locator('path.wire.audio').first()).toBeAttached();
	await expect(page.locator('path.wire.control').first()).toBeAttached();
});

test('a wire drawn by hand compiles, and an error lands on its node until it is undone', async ({ page }) => {
	await newPatch(page, 'Wired by hand');
	await expect(page.getByTestId('wire-2-in')).toHaveClass(/control/);
	await drag(page, 'out-4-out', 'in-2-in'); // Audio into a pitch read once a frame
	await expect(page.getByTestId('compile-error')).toContainText('put a snap node on the wire');
	await expect(page.getByTestId('node-2')).toHaveAttribute('data-error', 'true');
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await expect(page.getByTestId('node-2')).toHaveAttribute('data-error', 'false');
});

test('a node added from the toolbar is set up from the inspector', async ({ page }) => {
	await newPatch(page, 'Built from parts');
	await page.getByLabel('Node type').selectOption('math');
	await page.getByRole('button', { name: 'Add node' }).click();
	await expect(page.getByTestId('node-7')).toHaveAttribute('data-dead', 'true');
	await page.getByLabel('mode', { exact: true }).selectOption('clip');
	await expect(page.getByTestId('in-7-c')).toBeAttached();
	await page.getByLabel('source of a').selectOption('3:out');
	await expect(page.getByTestId('wire-7-a')).toHaveClass(/audio/);
	await page.getByLabel('source of b').selectOption('');
	await page.getByLabel('value of b').fill('-0.5');
	await page.getByLabel('value of b').blur();
	await expect(page.getByLabel('Graph JSON')).toHaveValue(/"b": -0\.5/);
});

test('a moved node stays where it was put', async ({ page }) => {
	await newPatch(page, 'Rearranged');
	const before = await page.getByTestId('node-6').getAttribute('transform');
	const box = await page.getByRole('button', { name: 'out 6' }).boundingBox();
	await page.mouse.move(box!.x + 40, box!.y + 8);
	await page.mouse.down();
	await page.mouse.move(box!.x - 60, box!.y + 100, { steps: 4 });
	await page.mouse.up();
	await expect.poll(() => page.getByTestId('node-6').getAttribute('transform')).not.toBe(before);
	const moved = await page.getByTestId('node-6').getAttribute('transform');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved.')).toBeVisible();
	await page.reload();
	await expect(page.getByTestId('node-6')).toHaveAttribute('transform', moved!);
});

test('a patch uses another as a subpatch, and it plays', async ({ page }) => {
	await newPatch(page, 'Part');
	const part = new URL(page.url()).pathname.split('/').pop();
	await newPatch(page, 'Whole');
	await page.getByLabel('Node type').selectOption('subpatch');
	await page.getByRole('button', { name: 'Add node' }).click();
	await page.getByLabel('patch', { exact: true }).selectOption(part!);
	await expect(page.getByTestId('out-7-l')).toBeAttached();
	await drag(page, 'out-7-l', 'in-6-r');
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await expect(page.getByTestId('wire-6-r')).toHaveClass(/audio/);
	await expect(page.getByTestId('node-7')).toHaveAttribute('data-dead', 'false');

	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved.')).toBeVisible();
	await page.goto(`/patches/${part}`);
	await page.getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByText('used by')).toBeVisible();
});

test('a probe scopes a node inside a voice', async ({ page }) => {
	await page.goto('/patches/lead');
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('engine')).toHaveAttribute('data-playing', 'true', { timeout: 10000 });
	const node = page.locator('g.node:has(text:has-text("osc"))').first();
	const id = (await node.getAttribute('data-testid'))!.replace('node-', '');
	await node.locator('rect.title').click();
	await page.getByRole('button', { name: 'Probe out' }).click();
	const label = page.locator('span').filter({ hasText: new RegExp(`^${id} osc\\.out$`) });
	await expect(label).toBeVisible();
	const key = page.getByRole('button', { name: '60', exact: true });
	await key.dispatchEvent('pointerdown');
	await expect.poll(async () => (await peaks(page)).filter((p) => p > 0.5).length, { timeout: 8000 }).toBeGreaterThan(0);
	await key.dispatchEvent('pointerup');
	await page.getByRole('button', { name: 'Stop probing out' }).click();
	await expect(label).toHaveCount(0);
});

test('a recipe plays from the catalogue without touching the library', async ({ page }) => {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(e.message));
	await page.goto('/');
	await page.getByRole('link', { name: 'Recipes' }).click();
	await expect(page.getByRole('heading', { name: 'drums' })).toBeVisible();
	await page.getByRole('link', { name: 'Kick808' }).click();
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect.poll(async () => Math.max(0, ...(await peaks(page))), { timeout: 8000 }).toBeGreaterThan(0.01);
	await page.goto('/');
	await expect(page.getByRole('link', { name: 'Kick808' })).toHaveCount(0);
	expect(problems).toEqual([]);
});

test('a recipe added to the library is an ordinary timeline and patch', async ({ page }) => {
	await page.goto('/recipes/PluckedString');
	await page.getByRole('button', { name: 'Add to library' }).click();
	await page.waitForURL('**/timelines/recipe-PluckedString');
	await expect(page.getByLabel('Timeline name')).toHaveValue('PluckedString');
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).toHaveText('1', { timeout: 10000 });
	await expect(page.getByTestId('compile-error')).toHaveCount(0);

	await page.goto('/patches/recipe-PluckedString-p');
	await expect(page.locator('path.wire.audio').first()).toBeAttached();

	await page.goto('/recipes/PluckedString');
	await expect(page.getByRole('button', { name: 'Add to library' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Open in the library' })).toBeVisible();
});

test('a recipe with recordings keeps them when it is added', async ({ page }) => {
	await page.goto('/recipes/OneShotSample');
	await page.getByRole('button', { name: 'Add to library' }).click();
	await page.waitForURL('**/timelines/recipe-OneShotSample');
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).toHaveText('1', { timeout: 10000 });
});

test('a recipe shows the patch it is made of, with nothing to change', async ({ page }) => {
	await page.goto('/recipes/Kick808');
	await expect(page.getByTestId('graph')).toBeVisible();
	await expect(page.locator('path.wire.audio').first()).toBeAttached();
	await expect(page.locator('path.wire.control').first()).toBeAttached();
	await expect(page.getByTestId('patch-use')).toContainText('the voice of track 1');
	await expect(page.getByRole('button', { name: 'Add node' })).toHaveCount(0);

	const node = page.locator('g.node:has(text:has-text("osc"))').first();
	await node.locator('rect.title').click();
	await expect(page.locator('aside.inspector select').first()).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Delete node' })).toHaveCount(0);

	const before = await page.getByLabel('Graph JSON').inputValue();
	await page.keyboard.press('Delete');
	await expect(page.getByTestId('graph').locator('g.node')).not.toHaveCount(0);
	expect(await page.getByLabel('Graph JSON').inputValue()).toBe(before);
});

test('a recipe with several patches shows each, and says what it does', async ({ page }) => {
	await page.goto('/recipes/SidechainDucking');
	const buttons = page.getByRole('group', { name: 'Patches in this recipe' }).getByRole('button');
	await expect(buttons).not.toHaveCount(0);
	const count = await buttons.count();
	expect(count).toBeGreaterThan(1);
	const uses = new Set<string>();
	for (let index = 0; index < count; ++index) {
		await buttons.nth(index).click();
		await expect(buttons.nth(index)).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('path.wire').first()).toBeAttached();
		uses.add((await page.getByTestId('patch-use').textContent()) ?? '');
	}
	expect(uses.size).toBe(count);
	expect([...uses].join()).toContain('an insert on');
});

test('a probe in a recipe reads the voice of the patch on screen', async ({ page }) => {
	await page.goto('/recipes/Kick808');
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	const node = page.locator('g.node:has(text:has-text("env"))').first();
	await node.locator('rect.title').click();
	await page.getByRole('button', { name: 'Probe out' }).click();
	await expect.poll(async () => (await peaks(page)).length, { timeout: 8000 }).toBe(3); // Master, the track and the probe
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect.poll(async () => Math.max(0, ...(await peaks(page))), { timeout: 8000 }).toBeGreaterThan(0.01);
});

test('an unknown recipe is a 404', async ({ page }) => {
	expect((await page.goto('/recipes/Nothing'))?.status()).toBe(404);
});
