import { expect, test, type Page } from '@playwright/test';

// Leaving with unsaved edits asks first, and a test that leaves means to.
test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

const patchEditor = (page: Page) => page.getByRole('region', { name: 'Patch editor' });
const timelineEditor = (page: Page) => page.getByRole('region', { name: 'Timeline editor' });
const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });

async function startPlaying(page: Page, timeline = 'song') {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') problems.push(m.text());
	});
	await page.goto(`/?timeline=${timeline}`);
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).toHaveText('1', { timeout: 10000 });
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	return problems;
}

async function tab(page: Page, name: 'Notes' | 'Mixer' | 'JSON' | 'Image') {
	await page
		.getByRole('tablist', { name: 'Timeline views' })
		.getByRole('tab', { name: new RegExp(`^${name}`) })
		.click();
}

async function timelineJson(page: Page) {
	await tab(page, 'JSON');
	return page.getByLabel('Timeline JSON');
}

async function graphJson(page: Page) {
	await page.getByRole('tablist', { name: 'Patch views' }).getByRole('tab', { name: 'JSON' }).click();
	return page.getByLabel('Graph JSON');
}

const graphView = (page: Page) =>
	page.getByRole('tablist', { name: 'Patch views' }).getByRole('tab', { name: 'Graph' }).click();

const peaksIn = (scope: ReturnType<Page['getByRole']>) =>
	scope.getByTestId('peak').evaluateAll((list) => list.map((e) => Number(e.getAttribute('data-peak'))));
const mixerPeaks = (page: Page) => peaksIn(page.getByRole('tabpanel'));
const patchPeaks = (page: Page) => peaksIn(patchEditor(page));

test('the seeded library lists patches, timelines and a bundle', async ({ page }) => {
	await page.goto('/');
	await expect(browser(page).getByRole('link', { name: 'Stereo lead' })).toBeVisible();
	await expect(browser(page).getByRole('link', { name: 'Song' })).toBeVisible();
	await expect(browser(page).getByRole('link', { name: 'Demo set' })).toBeVisible();
});

test('a fresh visit opens the timeline saved last, with its patch above', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\?timeline=ballad/);
	await expect(page.getByLabel('Timeline name', { exact: true })).toHaveValue('Ballad');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Stereo lead');
	await expect(page.getByTestId('graph')).toBeVisible();
	await expect(page.getByTestId('arrangement')).toBeVisible();
});

test('a timeline plays in an AudioWorklet and the scopes see every bus', async ({ page }) => {
	const problems = await startPlaying(page);
	await expect(page.getByTestId('voices')).not.toHaveText('0');
	await tab(page, 'Mixer');
	await expect(page.getByRole('heading', { name: 'Master' })).toBeVisible();
	await expect(page.getByText('Lead', { exact: true }).first()).toBeVisible();
	await expect.poll(async () => (await mixerPeaks(page)).filter((p) => p > 0.01).length, { timeout: 8000 }).toBe(4);
	await expect
		.poll(() => page.getByRole('meter', { name: 'Level of Lead' }).getAttribute('data-peak').then(Number))
		.toBeGreaterThan(0.01);
	const before = Number(await page.getByTestId('tick').textContent());
	await page.waitForTimeout(400);
	expect(Number(await page.getByTestId('tick').textContent())).toBeGreaterThan(before);
	expect(problems).toEqual([]);
});

test('editing during playback swaps generations without stopping', async ({ page }) => {
	const problems = await startPlaying(page);
	await expect(page.getByTestId('voices')).not.toHaveText('0');
	const editor = await timelineJson(page);
	const text = await editor.inputValue();
	const before = Number(await page.getByTestId('tick').textContent());
	await editor.fill(text.replace('"gain": 0.8', '"gain": 0.4'));
	await expect(page.getByTestId('generation')).toHaveText('2', { timeout: 8000 });
	expect(Number(await page.getByTestId('tick').textContent())).toBeGreaterThanOrEqual(before);
	// Taps were re-pointed at the new program's registers.
	await tab(page, 'Mixer');
	await expect.poll(async () => (await mixerPeaks(page)).filter((p) => p > 0.01).length, { timeout: 8000 }).toBe(4);
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
	await page.goto('/?timeline=song');
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).toHaveText('1', { timeout: 10000 });
	await page.waitForTimeout(2000);
	await expect(page.getByTestId('generation')).toHaveText('1');
});

test('rapid edits settle on the newest image, with scopes on its registers', async ({ page }) => {
	await startPlaying(page);
	await expect(page.getByTestId('voices')).not.toHaveText('0');
	const editor = await timelineJson(page);
	const text = await editor.inputValue();
	// A send moves bus registers, so scopes left on an older report would read the wrong bus.
	const removed = text.replace(/"sends": \[[^\]]*\]/, '"sends": []');
	expect(removed).not.toBe(text);
	for (const version of [removed, text, removed]) {
		await editor.fill(version);
		await page.waitForTimeout(280); // Just past the debounce, so each compile starts while the last may be loading
	}
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await tab(page, 'Mixer');
	await expect.poll(async () => (await mixerPeaks(page)).filter((p) => p > 0.01).length, { timeout: 8000 }).toBe(4);
});

test('the JSON stays open while it is typed into, and an edit survives opening something else', async ({ page }) => {
	await page.goto('/?timeline=ballad');
	const editor = await timelineJson(page);
	await editor.fill(`${await editor.inputValue()} `);
	await expect(editor).toBeVisible();
	await editor.fill('{ not json');
	await expect(editor).toBeVisible();
	await expect(page.getByText('JSON at position').or(page.getByText('Expected'))).toBeVisible();

	await browser(page).getByRole('link', { name: 'Stereo lead' }).click();
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Stereo lead');
	const graph = await graphJson(page);
	await graph.fill(`${await graph.inputValue()} `);
	await expect(graph).toBeVisible();
	await graph.fill('{ not json');
	await expect(graph).toBeVisible();
	await expect(page.getByText(/^Graph JSON: /)).toBeVisible();

	// Both are still there, unsaved, after another timeline and back.
	await browser(page).getByRole('link', { name: 'Song' }).click();
	await expect(page.getByTestId('unsaved')).toHaveText('2 unsaved');
	await browser(page).getByRole('link', { name: 'Ballad' }).click();
	await expect(await timelineJson(page)).toHaveValue('{ not json');
});

test('a broken edit shows where it failed and the old image keeps playing', async ({ page }) => {
	await startPlaying(page);
	const editor = await timelineJson(page);
	const text = await editor.inputValue();
	await editor.fill(text.replace('"slots": [\n    "lead"\n   ]', '"slots": [\n    "missing"\n   ]'));
	await expect(page.getByTestId('compile-error')).toContainText("no patch 'missing'");
	await expect(page.getByTestId('generation')).toHaveText('1');
	await expect(page.getByTestId('voices')).not.toHaveText('0');
});

test('seeking chases held notes and a knob works', async ({ page }) => {
	await startPlaying(page, 'ballad');
	await expect(page.getByTestId('voices')).toHaveText('3');
	// Bars are 96 pixels and 1920 ticks, so this is a little past tick 2000.
	const ruler = (await page.getByTestId('ruler').boundingBox())!;
	await page.mouse.click(ruler.x + 106, ruler.y + ruler.height / 2);
	await expect.poll(async () => Number(await page.getByTestId('tick').textContent())).toBeGreaterThanOrEqual(2000);
	await expect(page.getByTestId('voices')).toHaveText('3');
	await tab(page, 'Mixer');
	const cutoff = page.getByRole('tabpanel').getByLabel('cutoff').first();
	await cutoff.evaluate((e: HTMLInputElement) => {
		e.value = '6000';
		e.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await expect(page.getByTestId('voices')).toHaveText('3');
});

test('a timeline saves, and a stale tab is refused', async ({ page, context }) => {
	await page.goto('/?timeline=ballad');
	const other = await context.newPage();
	other.on('dialog', (dialog) => dialog.accept());
	await other.goto('/?timeline=ballad');

	await page.getByLabel('Timeline name', { exact: true }).fill('Ballad two');
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved.')).toBeVisible();
	await expect(page.getByTestId('unsaved')).toHaveCount(0);

	await other.getByLabel('Timeline name', { exact: true }).fill('Stale');
	await other.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(other.getByText('changed elsewhere')).toBeVisible();
	await expect(other.getByTestId('unsaved')).toHaveText('1 unsaved'); // Refused, so nothing was lost

	await page.reload();
	await expect(page.getByLabel('Timeline name', { exact: true })).toHaveValue('Ballad two');
	await page.getByLabel('Timeline name', { exact: true }).fill('Ballad');
	await page.keyboard.press('ControlOrMeta+s');
	await expect(page.getByText('Saved.')).toBeVisible();
});

test('edits to a timeline and its patches save together', async ({ page }) => {
	await page.goto('/?timeline=ballad');
	await page.getByLabel('Timeline name', { exact: true }).fill('Ballad, edited');
	await browser(page).getByRole('link', { name: 'Sampled pluck' }).click();
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Sampled pluck');
	await page.getByLabel('Patch name', { exact: true }).fill('Pluck, edited');
	await expect(browser(page).getByRole('link', { name: /Pluck, edited/ })).toContainText('•');
	await expect(page.getByTestId('unsaved')).toHaveText('2 unsaved');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved.')).toBeVisible();
	await page.reload();
	await expect(page.getByLabel('Timeline name', { exact: true })).toHaveValue('Ballad, edited');
	await expect(browser(page).getByRole('link', { name: 'Pluck, edited' })).toBeVisible();
	await expect(browser(page).getByRole('link', { name: 'Stereo lead' })).toBeVisible();

	await page.getByLabel('Timeline name', { exact: true }).fill('Ballad');
	await browser(page).getByRole('link', { name: 'Pluck, edited' }).click();
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Pluck, edited');
	await page.getByLabel('Patch name', { exact: true }).fill('Sampled pluck');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved.')).toBeVisible();
});

test('choosing a track shows its patch, and the browser shows another', async ({ page }) => {
	await page.goto('/?timeline=song');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Stereo lead');
	await page.getByTestId('track-2').click();
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Sampled pluck');
	await expect(page.getByTestId('hearing')).toContainText('Keys play it on Pluck');
	await browser(page).getByRole('link', { name: 'Room' }).click();
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Room');
	await expect(page.getByTestId('hearing')).toContainText('An insert has no keys');
	await page.getByTestId('track-1').click();
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Stereo lead');
	await expect(page).not.toHaveURL(/patch=/);

	// A patch the address names stays, whatever track a timeline opens on, as when one is made while it is shown.
	await page.goto('/?timeline=song&patch=unused');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Square, in the library but on no timeline');
	await page.getByLabel('New timeline name').fill('Beside a patch');
	await page.getByLabel('New timeline name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== 'song');
	await expect(page.getByLabel('Timeline name', { exact: true })).toHaveValue('Beside a patch');
	await page.waitForTimeout(300);
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Square, in the library but on no timeline');
	await expect(page).toHaveURL(/patch=unused/);
});

test('keys go to the panel used last', async ({ page }) => {
	await page.goto('/?timeline=song');
	const nodes = patchEditor(page).locator('g.node');
	const count = await nodes.count();
	const osc = page.locator('g.node:has(text:has-text("osc"))').first().locator('rect.title');
	await osc.click(); // Chosen in the graph, which mustn't take the Delete meant for the timeline
	await page.getByTestId('placement-1-0').locator('rect').first().click();
	await page.keyboard.press('Delete');
	await expect(page.getByTestId('placement-1-0')).toHaveCount(0);
	await expect(nodes).toHaveCount(count);
	await osc.click();
	await page.keyboard.press('ControlOrMeta+z'); // Nothing to undo in the graph, and the timeline's edit stays
	await expect(page.getByTestId('placement-1-0')).toHaveCount(0);
	await page.keyboard.press('Delete');
	await expect(nodes).toHaveCount(count - 1);
	await timelineEditor(page).getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByTestId('placement-1-0')).toBeVisible();
	await expect(nodes).toHaveCount(count - 1);
});

test('the browser folds away and stays that way', async ({ page }) => {
	await page.goto('/?timeline=song');
	await expect(browser(page)).toBeVisible();
	const before = (await page.getByTestId('arrangement').boundingBox())!.x;
	await page.getByRole('button', { name: 'Browser' }).click();
	await expect(browser(page)).toHaveCount(0);
	expect((await page.getByTestId('arrangement').boundingBox())!.x).toBeLessThan(before);
	await page.reload();
	await expect(browser(page)).toHaveCount(0);
	await page.getByRole('button', { name: 'Browser' }).click();
	await expect(browser(page)).toBeVisible();
});

test('the browser filters everything by name', async ({ page }) => {
	await page.goto('/?timeline=song');
	await browser(page).getByLabel('Filter the browser').fill('kick');
	await expect(browser(page).getByRole('link', { name: 'Kick808' })).toBeVisible();
	await expect(browser(page).getByRole('link', { name: 'Stereo lead' })).toHaveCount(0);
});

test('the patch editor is resized from the bar under it', async ({ page }) => {
	await page.goto('/?timeline=song');
	const graph = page.getByTestId('graph');
	const before = (await graph.boundingBox())!.height;
	const bar = page.getByRole('separator', { name: 'Resize the patch editor' });
	await bar.focus();
	await page.keyboard.press('Shift+ArrowDown');
	await expect.poll(async () => (await graph.boundingBox())!.height).toBeGreaterThan(before + 40);
	await bar.dblclick();
	await expect.poll(async () => Math.round((await graph.boundingBox())!.height)).toBe(Math.round(before));
});

test('a patch in use cannot be deleted, and says what an edit would change', async ({ page }) => {
	await page.goto('/?patch=lead');
	await expect(page.getByTestId('used-by')).toContainText('2 timelines');
	await page.getByRole('button', { name: 'Delete patch' }).click();
	await expect(page.getByText('used by')).toBeVisible();
});

test('a patch no track plays is heard on its own, and Play brings the song back', async ({ page }) => {
	await page.goto('/?timeline=song&patch=unused');
	await expect(page.getByTestId('hearing')).toHaveAttribute('data-kind', 'alone');
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).toHaveText('1', { timeout: 10000 });
	// The song is playing, so a probe waits for the patch's own image, which the first key brings.
	await page.locator('g.node:has(text:has-text("osc"))').first().locator('rect.title').click();
	await page.getByRole('button', { name: 'Probe out' }).click();
	await expect(page.getByTestId('probe-waiting')).toContainText('shows once the patch plays');
	const key = page.getByRole('button', { name: '60', exact: true });
	await key.dispatchEvent('pointerdown');
	await expect(page.getByTestId('playing-alone')).toBeVisible();
	await expect(page.getByTestId('probe-waiting')).toHaveCount(0);
	await expect.poll(async () => (await patchPeaks(page)).length).toBe(2); // The patch's output and the probe
	// A shared LFO waits for the transport, and a patch on its own has no Play button, so the page starts it.
	await expect(page.getByTestId('state')).toHaveAttribute('data-playing', 'true', { timeout: 10000 });
	await expect.poll(async () => Math.max(0, ...(await patchPeaks(page))), { timeout: 8000 }).toBeGreaterThan(0.01);
	await key.dispatchEvent('pointerup');

	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect(page.getByTestId('playing-alone')).toHaveCount(0);
	await expect(page.getByTestId('voices')).not.toHaveText('0', { timeout: 8000 });
});

test('a patch a track plays is heard in the song, through that track', async ({ page }) => {
	await page.goto('/?timeline=song');
	await expect(page.getByTestId('hearing')).toContainText('Keys play it on Lead, in the song');
	const key = page.getByRole('button', { name: '67', exact: true });
	await key.dispatchEvent('pointerdown'); // Starts audio as well
	await expect(page.getByTestId('generation')).toHaveText('1', { timeout: 10000 });
	await expect
		.poll(() => page.getByRole('meter', { name: 'Level of Lead' }).getAttribute('data-peak').then(Number))
		.toBeGreaterThan(0.01);
	await key.dispatchEvent('pointerup');
	await expect(page.getByTestId('playing-alone')).toHaveCount(0);
});

test('an edit to a patch the song does not use, or opening another, swaps nothing', async ({ page }) => {
	await startPlaying(page);
	await browser(page)
		.getByRole('link', { name: /^Square/ })
		.click();
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue(/^Square/);
	await page.getByLabel('Patch name', { exact: true }).fill('Square, renamed');
	await (
		await graphJson(page)
	).fill(JSON.stringify({ ...JSON.parse(await page.getByLabel('Graph JSON').inputValue()), x: 1 }));
	await browser(page).getByRole('link', { name: 'Room' }).click();
	await page.waitForTimeout(1000); // Past the debounce, so any compile has been and gone
	await expect(page.getByTestId('generation')).toHaveText('1');
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');
});

test('a bundle exports with shared patches, and thin without them', async ({ page }) => {
	await page.goto('/');
	await browser(page).getByRole('link', { name: 'Demo set' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	const download = page.waitForEvent('download');
	await dialog.getByRole('button', { name: 'Export saved bundle' }).click();
	const full = await download;
	expect(full.suggestedFilename()).toBe('Demo set.msimg');
	await expect(dialog.getByText('4 of 4 patches compiled in, 2 chunks shared between 2 programs')).toBeVisible();

	const second = page.waitForEvent('download');
	await dialog.getByLabel('Programs only').check();
	await dialog.getByRole('button', { name: 'Export saved bundle' }).click();
	await second;
	await expect(dialog.getByText('left out for a receiver that already has it')).toBeVisible();
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page).not.toHaveURL(/bundle=/);
});

test('a single timeline exports only what it reaches', async ({ page }) => {
	await page.goto('/?timeline=ballad');
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Export saved version' }).click();
	expect((await download).suggestedFilename()).toBe('Ballad.msimg');
});

test('the old addresses open the same things', async ({ page }) => {
	await page.goto('/timelines/ballad');
	await expect(page).toHaveURL(/\?timeline=ballad/);
	await page.goto('/patches/pluck');
	await expect(page).toHaveURL(/patch=pluck/);
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Sampled pluck');
	await page.goto('/recipes/Kick808');
	await expect(page).toHaveURL(/\?recipe=Kick808/);
	await page.goto('/bundles/demo-set');
	await expect(page.getByRole('dialog')).toBeVisible();
});

async function newPatch(page: Page, name: string) {
	await page.goto('/');
	await page.getByLabel('New patch name').fill(name);
	await page.getByLabel('New patch name').press('Enter');
	await page.waitForURL(/patch=/);
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue(name);
	await expect(page.getByTestId('graph')).toBeVisible();
}

const shownPatchId = (page: Page) => new URL(page.url()).searchParams.get('patch')!;

async function drag(page: Page, from: string, to: string) {
	const start = await page.getByTestId(from).boundingBox();
	const end = await page.getByTestId(to).boundingBox();
	await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
	await page.mouse.down();
	await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, { steps: 5 });
	await page.mouse.up();
}

test('the graph editor draws a patch and colours its wires by rate', async ({ page }) => {
	await page.goto('/?patch=lead');
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
	await patchEditor(page).getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await expect(page.getByTestId('node-2')).toHaveAttribute('data-error', 'false');
});

test('a node added from the toolbar is set up from the inspector', async ({ page }) => {
	await newPatch(page, 'Built from parts');
	const editor = patchEditor(page);
	await editor.getByLabel('Node type').selectOption('math');
	await editor.getByRole('button', { name: 'Add node' }).click();
	await expect(page.getByTestId('node-7')).toHaveAttribute('data-dead', 'true');
	await editor.getByLabel('mode', { exact: true }).selectOption('clip');
	await expect(page.getByTestId('in-7-c')).toBeAttached();
	await editor.getByLabel('source of a').selectOption('3:out');
	await expect(page.getByTestId('wire-7-a')).toHaveClass(/audio/);
	await editor.getByLabel('source of b').selectOption('');
	await editor.getByLabel('value of b').fill('-0.5');
	await editor.getByLabel('value of b').blur();
	await expect(await graphJson(page)).toHaveValue(/"b": -0\.5/);
});

test('a moved node stays where it was put', async ({ page }) => {
	await newPatch(page, 'Rearranged');
	const before = await page.getByTestId('node-6').getAttribute('transform');
	const box = await page.getByRole('button', { name: 'out 6' }).boundingBox();
	await page.mouse.move(box!.x + 40, box!.y + 8);
	await page.mouse.down();
	await page.mouse.move(box!.x - 60, box!.y + 60, { steps: 4 });
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
	const part = shownPatchId(page);
	await newPatch(page, 'Whole');
	const editor = patchEditor(page);
	await editor.getByLabel('Node type').selectOption('subpatch');
	await editor.getByRole('button', { name: 'Add node' }).click();
	await editor.getByLabel('patch', { exact: true }).selectOption(part);
	await expect(page.getByTestId('out-7-l')).toBeAttached();
	await drag(page, 'out-7-l', 'in-6-r');
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await expect(page.getByTestId('wire-6-r')).toHaveClass(/audio/);
	await expect(page.getByTestId('node-7')).toHaveAttribute('data-dead', 'false');

	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved.')).toBeVisible();
	await page.goto(`/?patch=${part}`);
	await page.getByRole('button', { name: 'Delete patch' }).click();
	await expect(page.getByText('used by')).toBeVisible();
});

test('a probe scopes a node inside a voice', async ({ page }) => {
	await page.goto('/?timeline=ballad&patch=lead');
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).not.toHaveText('0', { timeout: 10000 });
	const node = page.locator('g.node:has(text:has-text("osc"))').first();
	const id = (await node.getAttribute('data-testid'))!.replace('node-', '');
	await node.locator('rect.title').click();
	await page.getByRole('button', { name: 'Probe out' }).click();
	const label = page.locator('span').filter({ hasText: new RegExp(`^${id} osc\\.out$`) });
	await expect(label).toBeVisible();
	const key = page.getByRole('button', { name: '60', exact: true });
	await key.dispatchEvent('pointerdown');
	await expect
		.poll(async () => (await patchPeaks(page)).filter((p) => p > 0.5).length, { timeout: 8000 })
		.toBeGreaterThan(0);
	await key.dispatchEvent('pointerup');
	await page.getByRole('button', { name: 'Stop probing out' }).click();
	await expect(label).toHaveCount(0);
});

test('a recipe plays from the examples without touching the library', async ({ page }) => {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(e.message));
	await page.goto('/');
	await browser(page).getByText('drums').click();
	await browser(page).getByRole('link', { name: 'Kick808' }).click();
	await expect(page).toHaveURL(/recipe=Kick808/);
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect.poll(async () => Math.max(0, ...(await patchPeaks(page))), { timeout: 8000 }).toBeGreaterThan(0.01);
	await page.goto('/');
	await expect(
		browser(page).getByRole('list', { name: 'Timelines' }).getByRole('link', { name: 'Kick808' })
	).toHaveCount(0);
	expect(problems).toEqual([]);
});

test('a recipe added to the library is an ordinary timeline and patch', async ({ page }) => {
	await page.goto('/?recipe=PluckedString');
	await page.getByRole('button', { name: 'Add to library' }).click();
	await page.waitForURL('**/?timeline=recipe-PluckedString');
	await expect(page.getByLabel('Timeline name', { exact: true })).toHaveValue('PluckedString');
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).toHaveText('1', { timeout: 10000 });
	await expect(page.getByTestId('compile-error')).toHaveCount(0);

	await page.goto('/?patch=recipe-PluckedString-p');
	await expect(page.locator('path.wire.audio').first()).toBeAttached();

	await page.goto('/?recipe=PluckedString');
	await expect(page.getByRole('button', { name: 'Add to library' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Open in the library' })).toBeVisible();
});

test('a recipe with recordings keeps them when it is added', async ({ page }) => {
	await page.goto('/?recipe=OneShotSample');
	await page.getByRole('button', { name: 'Add to library' }).click();
	await page.waitForURL('**/?timeline=recipe-OneShotSample');
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).toHaveText('1', { timeout: 10000 });
});

test('a recipe shows the patch it is made of, with nothing to change', async ({ page }) => {
	await page.goto('/?recipe=Kick808');
	await expect(page.getByTestId('graph')).toBeVisible();
	await expect(page.locator('path.wire.audio').first()).toBeAttached();
	await expect(page.locator('path.wire.control').first()).toBeAttached();
	await expect(page.getByTestId('patch-use')).toContainText('the voice of track 1');
	await expect(page.getByRole('button', { name: 'Add node' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Delete patch' })).toHaveCount(0);

	const node = page.locator('g.node:has(text:has-text("osc"))').first();
	await node.locator('rect.title').click();
	await expect(patchEditor(page).locator('aside.inspector select').first()).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Delete node' })).toHaveCount(0);

	const nodes = await page.getByTestId('graph').locator('g.node').count();
	await page.keyboard.press('Delete');
	await expect(page.getByTestId('graph').locator('g.node')).toHaveCount(nodes);
	await expect(await graphJson(page)).not.toBeEditable();
});

test('a recipe with several patches shows each, and says what it does', async ({ page }) => {
	await page.goto('/?recipe=SidechainDucking');
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
	await page.goto('/?recipe=Kick808');
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	const node = page.locator('g.node:has(text:has-text("env"))').first();
	await node.locator('rect.title').click();
	await page.getByRole('button', { name: 'Probe out' }).click();
	await expect.poll(async () => (await patchPeaks(page)).length, { timeout: 8000 }).toBe(2); // The track and the probe
	await page.getByRole('button', { name: 'Play', exact: true }).click(); // From the start again, once it has ended
	await expect.poll(async () => Math.max(0, ...(await patchPeaks(page))), { timeout: 8000 }).toBeGreaterThan(0.01);
});

async function newTimeline(page: Page, name: string) {
	await page.setViewportSize({ width: 1440, height: 1500 });
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByLabel('New timeline name').fill(name);
	await page.getByLabel('New timeline name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByLabel('Timeline name', { exact: true })).toHaveValue(name);
	await expect(page.getByTestId('arrangement')).toBeVisible();
}

const timelineDoc = async (page: Page) => {
	const doc = JSON.parse(await (await timelineJson(page)).inputValue());
	await tab(page, 'Notes');
	return doc;
};

async function press(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 3 });
	await page.mouse.move(to.x, to.y, { steps: 3 });
	await page.mouse.up();
}

async function centre(page: Page, id: string) {
	const element = page.getByTestId(id);
	const inner = element.locator('rect').first();
	const box = (await ((await inner.count()) ? inner : element).boundingBox())!;
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function trackWithClip(page: Page, name: string) {
	await newTimeline(page, name);
	await page.getByRole('button', { name: 'Add track' }).click();
	await page.getByLabel('Patch slot 1', { exact: true }).selectOption('lead');
	const row = (await page.getByTestId('row-1').boundingBox())!;
	await page.mouse.dblclick(row.x + 10, row.y + 20);
	await expect(page.getByTestId('placement-1-0')).toBeVisible();
	await expect(page.getByTestId('roll')).toBeVisible();
}

// Where a note at this tick lands in the roll.
async function rollPoint(page: Page, tick: number, note: number) {
	const roll = page.getByTestId('roll');
	const box = (await roll.boundingBox())!;
	const key = (await page.getByTestId(`key-${note}`).boundingBox())!;
	return { x: box.x + tick * Number(await roll.getAttribute('data-per-tick')) + 2, y: key.y + key.height / 2 };
}

async function addNoteAt(page: Page, tick: number, note: number) {
	const { x, y } = await rollPoint(page, tick, note);
	await page.mouse.dblclick(x, y);
}

async function startAudio(page: Page) {
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).not.toHaveText('0', { timeout: 10000 });
}

const stripPeak = async (page: Page, chain: string) =>
	Number(await page.getByTestId(`strip-${chain}`).getByTestId('peak').getAttribute('data-peak'));

const undo = (page: Page) => timelineEditor(page).getByRole('button', { name: 'Undo' }).click();

test('a song built from nothing plays, saves and comes back', async ({ page }) => {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(e.message));
	await trackWithClip(page, 'From nothing');
	await addNoteAt(page, 0, 60);
	await addNoteAt(page, 480, 64);
	await addNoteAt(page, 960, 67);
	await expect(page.getByTestId('note-2')).toHaveAttribute('data-note', '67');
	await expect(page.getByTestId('compile-error')).toHaveCount(0);

	await page.getByRole('button', { name: 'Loop off' }).click();
	await startAudio(page);
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await tab(page, 'Mixer');
	await expect.poll(() => stripPeak(page, 'track:1'), { timeout: 8000 }).toBeGreaterThan(0.01);
	await expect.poll(() => stripPeak(page, 'master'), { timeout: 8000 }).toBeGreaterThan(0.01);
	await page.waitForTimeout(2300); // The clip is two seconds, so this has gone round the loop
	expect(Number(await page.getByTestId('tick').textContent())).toBeLessThan(1920);

	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved.')).toBeVisible();
	await page.reload();
	await page.getByTestId('placement-1-0').locator('rect').first().click();
	await expect(page.getByTestId('note-2')).toHaveAttribute('data-note', '67');
	const doc = await timelineDoc(page);
	expect(doc.clips[0].notes.map((n: { note: number }) => n.note)).toEqual([60, 64, 67]);
	expect(doc.tracks[0].slots).toEqual(['lead']);
	expect(problems).toEqual([]);
});

test('notes are moved, stretched, chosen and removed by hand', async ({ page }) => {
	await trackWithClip(page, 'Notes');
	await addNoteAt(page, 0, 60);
	await addNoteAt(page, 480, 62);
	const note = page.getByTestId('note-0');
	await expect(note).toHaveAttribute('data-dur', '480');

	const from = await rollPoint(page, 240, 60);
	const to = await rollPoint(page, 960 + 240, 67);
	await press(page, from, to);
	await expect(note).toHaveAttribute('data-tick', '960');
	await expect(note).toHaveAttribute('data-note', '67');

	const edge = await centre(page, 'edge-0');
	await press(page, edge, {
		x: edge.x + (await rollPoint(page, 480, 60)).x - (await rollPoint(page, 0, 60)).x,
		y: edge.y
	});
	await expect(note).toHaveAttribute('data-dur', '960');

	// The keyboard moves what is chosen, and undo walks all of it back.
	await page.keyboard.press('ArrowUp');
	await expect(note).toHaveAttribute('data-note', '68');
	await page.keyboard.press('Shift+ArrowDown');
	await expect(note).toHaveAttribute('data-note', '56');
	await page.keyboard.press('ArrowRight');
	await expect(note).toHaveAttribute('data-tick', '1440');
	await page.keyboard.press('Control+z');
	await expect(note).toHaveAttribute('data-tick', '960');

	// A band takes both, and they move as one.
	const start = await rollPoint(page, 0, 72);
	const end = await rollPoint(page, 1900, 50);
	await page.keyboard.down('Shift');
	await press(page, start, end);
	await page.keyboard.up('Shift');
	await page.keyboard.press('ArrowUp');
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-note', '57');
	await expect(page.getByTestId('note-1')).toHaveAttribute('data-note', '63');

	await page.keyboard.press('Delete');
	await expect(page.locator('[data-testid^="note-"]')).toHaveCount(0);
	await page.keyboard.press('Control+z');
	await expect(page.locator('[data-testid^="note-"]')).toHaveCount(2);
	const doc = await timelineDoc(page);
	expect(doc.clips[0].notes).toHaveLength(2);
	expect(doc.tracks[0].placements).toHaveLength(1); // Delete in the roll is about notes
});

test('velocity is dragged, and a double-click takes a note away', async ({ page }) => {
	await trackWithClip(page, 'Velocity');
	await addNoteAt(page, 480, 60);
	const bar = (await page.getByTestId('velocity-0').boundingBox())!;
	const lane = (await page.getByTestId('velocity').boundingBox())!;
	await press(page, { x: bar.x + 2, y: bar.y + 2 }, { x: bar.x + 2, y: lane.y + lane.height / 2 });
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-vel', /^6[34]$/);
	const { x, y } = await centre(page, 'note-0');
	await page.mouse.dblclick(x - 20, y);
	await expect(page.locator('[data-testid^="note-"]')).toHaveCount(0);
});

test('a clip is moved, repeated and copied in the arrangement, and an overlap lands on its track', async ({ page }) => {
	await trackWithClip(page, 'Arranged');
	await addNoteAt(page, 0, 60);
	await page.getByRole('button', { name: 'Add track' }).click();
	await page.getByLabel('Patch slot 1', { exact: true }).selectOption('pluck');
	const block = page.getByTestId('placement-1-0');
	const barPixels = 96;

	const body = await centre(page, 'placement-1-0');
	await press(page, body, { x: body.x + barPixels * 2, y: body.y });
	await expect(block).toHaveAttribute('data-tick', '3840');

	const repeat = (await page.getByTestId('repeat-1-0').boundingBox())!;
	const edge = { x: repeat.x + 3, y: repeat.y + 10 };
	await press(page, edge, { x: edge.x + barPixels, y: edge.y });
	await expect(block).toHaveAttribute('data-repeat', '2');

	// Alt copies a placement, on another track, of the same clip.
	const moved = await centre(page, 'placement-1-0');
	await page.keyboard.down('Alt');
	await press(page, { x: moved.x - 20, y: moved.y }, { x: moved.x - 20 + barPixels, y: moved.y + 60 });
	await page.keyboard.up('Alt');
	await expect(page.getByTestId('placement-2-0')).toHaveAttribute('data-repeat', '2');
	await expect(page.getByTestId('clip-uses')).toContainText('Placed 2 times');

	// Dragged onto the copy, it overlaps, which only the compiler can say is wrong.
	await page.getByTestId('track-1').click();
	const first = await centre(page, 'placement-1-0');
	await press(page, first, { x: first.x, y: first.y + 60 });
	await expect(page.getByTestId('compile-error')).toContainText('clips overlap');
	await expect(page.getByTestId('track-2')).toHaveClass(/problem/);
	await undo(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);

	await page.getByRole('button', { name: 'Make unique' }).click();
	const doc = await timelineDoc(page);
	expect(doc.clips).toHaveLength(2);
	await page.getByLabel('Clip name').fill('verse');
	await page.getByLabel('Clip name').blur();
	await expect.poll(async () => (await timelineDoc(page)).clips.map((c: { id: string }) => c.id)).toContain('verse');

	await page.getByTestId('placement-1-0').locator('rect').first().click();
	await page.keyboard.press('Delete');
	await expect(page.getByTestId('placement-1-0')).toHaveCount(0);
	await undo(page);
	await expect(page.getByTestId('placement-1-0')).toBeVisible();
});

test('a drawn loop reaches an engine that starts later', async ({ page }) => {
	await trackWithClip(page, 'Looped');
	await addNoteAt(page, 0, 60);
	const strip = (await page.getByTestId('loop-strip').boundingBox())!;
	await press(page, { x: strip.x + 1, y: strip.y + 5 }, { x: strip.x + 48, y: strip.y + 5 });
	await expect(page.getByTestId('loop-brace')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Loop on' })).toBeVisible();
	await startAudio(page);
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await page.waitForTimeout(1500);
	expect(Number(await page.getByTestId('tick').textContent())).toBeLessThan(960);
	await expect(page.getByTestId('voices')).toBeVisible();
});

test('a lane moves a parameter over a clip, and a mixer lane is heard', async ({ page }) => {
	await trackWithClip(page, 'Lanes');
	await addNoteAt(page, 0, 60);
	await page.getByRole('button', { name: 'Loop off' }).click();
	await page.getByLabel('Add a lane').selectOption({ label: 'cutoff' });
	await expect(page.getByTestId('lane-0')).toBeVisible();

	const lane = (await page.getByTestId('lane-0').boundingBox())!;
	await page.mouse.dblclick(lane.x + 96, lane.y + 10);
	await expect(page.locator('[data-testid^="lane-0-point-"]')).toHaveCount(2);
	await page.getByLabel('cutoff point ramp').fill('480');
	await page.getByLabel('cutoff point ramp').blur();
	await expect.poll(async () => (await timelineDoc(page)).clips[0].automation[1]?.ramp).toBe(480);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);

	const point = (await page.getByTestId('lane-0-point-1').boundingBox())!;
	await press(page, { x: point.x + 5, y: point.y + 5 }, { x: point.x + 5 + 96, y: lane.y + lane.height - 4 });
	await expect.poll(async () => (await timelineDoc(page)).clips[0].automation[1].tick).toBe(960);

	// A fader lane at zero: the track still sounds at its own scope, which is before the fader, and the master goes quiet.
	await page.getByLabel('Add a lane').selectOption({ label: 'Fader' });
	await expect(page.getByTestId('lane-1')).toBeVisible();
	await page.getByTestId('lane-1-point-2').click();
	await page.getByLabel('Fader point value').fill('0');
	await page.getByLabel('Fader point value').blur();
	await expect.poll(async () => (await timelineDoc(page)).clips[0].automation[2].value).toBe(0);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await startAudio(page);
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await tab(page, 'Mixer');
	await expect.poll(() => stripPeak(page, 'track:1'), { timeout: 8000 }).toBeGreaterThan(0.01);
	expect(await stripPeak(page, 'master')).toBeLessThan(0.001);

	await tab(page, 'Notes');
	await page.getByRole('button', { name: 'Remove lane Fader' }).click();
	await expect(page.getByTestId('lane-1')).toHaveCount(0);
	await tab(page, 'Mixer');
	await expect.poll(() => stripPeak(page, 'master'), { timeout: 8000 }).toBeGreaterThan(0.01);
});

test('an insert lane compiles, and two lanes on one mix register are refused where they are', async ({ page }) => {
	await trackWithClip(page, 'Insert lanes');
	await addNoteAt(page, 0, 60);
	await tab(page, 'Mixer');
	await page.getByLabel('Add an insert to Track 1').selectOption('reverb');
	await tab(page, 'Notes');
	await page.getByLabel('Add a lane').selectOption({ label: 'Room room' });
	await expect(page.getByTestId('lane-0')).toBeVisible();
	await expect.poll(async () => (await timelineDoc(page)).clips[0].automation[0].target).toEqual({ insert: 1 });
	await expect(page.getByTestId('compile-error')).toHaveCount(0);

	await page.getByLabel('Add a lane').selectOption({ label: 'Fader' });
	await page.getByLabel('Add a lane').selectOption({ label: 'Pan' });
	await expect(page.getByTestId('compile-error')).toBeVisible();
	await expect(page.getByTestId('track-1')).toHaveClass(/problem/);

	// Taking the insert away takes its lane, so that doesn't become an error of its own.
	await page.getByRole('button', { name: 'Remove lane Pan' }).click();
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await tab(page, 'Mixer');
	await page.getByRole('button', { name: 'Remove insert 1 on Track 1' }).click();
	await expect
		.poll(async () => (await timelineDoc(page)).clips[0].automation.map((p: { target: unknown }) => p.target))
		.toEqual([{ mix: 'fader', track: 1 }]);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
});

test('an insert opens in the patch editor from the mixer', async ({ page }) => {
	await page.goto('/?timeline=song');
	await tab(page, 'Mixer');
	await page.getByRole('button', { name: 'Edit insert 1 on room' }).click();
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Room');
	await expect(page).toHaveURL(/patch=reverb/);
});

test('a fader is heard as it moves, and only compiles when let go', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1500 });
	await startPlaying(page);
	await page.getByRole('button', { name: 'Loop off' }).click();
	await tab(page, 'Mixer');
	await expect.poll(() => stripPeak(page, 'master'), { timeout: 8000 }).toBeGreaterThan(0.01);
	const fader = page.getByLabel('Fader for Master');
	await fader.evaluate((e: HTMLInputElement) => {
		e.value = '0';
		e.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await expect.poll(() => stripPeak(page, 'master'), { timeout: 4000 }).toBeLessThan(0.001);
	await expect(page.getByTestId('generation')).toHaveText('1');

	await fader.evaluate((e: HTMLInputElement) => e.dispatchEvent(new Event('change', { bubbles: true })));
	await expect(page.getByTestId('generation')).toHaveText('2', { timeout: 8000 });
	expect((await timelineDoc(page)).master.gain).toBe(0);
	await tab(page, 'Mixer');
	await page.waitForTimeout(400);
	expect(await stripPeak(page, 'master')).toBeLessThan(0.001);

	await undo(page);
	await expect(page.getByTestId('generation')).toHaveText('3', { timeout: 8000 });
	await expect.poll(() => stripPeak(page, 'master'), { timeout: 4000 }).toBeGreaterThan(0.01);
});

test('a mute silences a track, and buses, sends and inserts are wired from the mixer', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1500 });
	await startPlaying(page);
	await page.getByRole('button', { name: 'Loop off' }).click();
	await tab(page, 'Mixer');
	await page.getByRole('button', { name: 'Mute Lead' }).click();
	await page.getByRole('button', { name: 'Mute Pluck' }).click();
	await expect(page.getByRole('button', { name: 'Mute Lead' })).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(() => stripPeak(page, 'master'), { timeout: 6000 }).toBeLessThan(0.02);
	await page.getByRole('button', { name: 'Mute Lead' }).click();
	await page.getByRole('button', { name: 'Mute Pluck' }).click();

	await page.getByLabel('New bus name').fill('echo');
	await page.getByRole('button', { name: 'Add bus' }).click();
	await expect(page.getByTestId('strip-bus:echo')).toBeVisible();
	await page.getByLabel('Add a send from Lead').selectOption('echo');
	await expect(page.getByLabel('Send from Lead to echo', { exact: true })).toBeVisible();
	await page.getByLabel('Output of Pluck').selectOption('bus:echo');
	await page.getByLabel('Add an insert to echo').selectOption('reverb');
	await page.getByLabel('Insert 1 on echo', { exact: true }).selectOption('reverb');
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await expect
		.poll(async () => (await timelineDoc(page)).buses.map((b: { id: string }) => b.id))
		.toEqual(['room', 'echo']);
	await tab(page, 'Mixer');
	await expect.poll(() => stripPeak(page, 'bus:echo'), { timeout: 8000 }).toBeGreaterThan(0.001);

	await page.getByTestId('strip-bus:echo').getByRole('button', { name: 'Delete bus' }).click();
	await expect(page.getByTestId('strip-bus:echo')).toHaveCount(0);
	const doc = await timelineDoc(page);
	expect(doc.tracks[1].output).toBe('master');
	expect(doc.tracks[0].sends.map((s: { bus: string }) => s.bus)).toEqual(['room']);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
});

async function savedPatch(page: Page, name: string, graph: object) {
	await newPatch(page, name);
	await (await graphJson(page)).fill(JSON.stringify(graph));
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved.')).toBeVisible();
	return shownPatchId(page);
}

const tone = {
	params: [{ id: 7, name: 'level', scope: 'global', min: 0, max: 1, default: 1, smooth_ms: 0 }],
	nodes: [
		{ id: 1, type: 'note' },
		{ id: 2, type: 'mtof' },
		{ id: 3, type: 'osc', wave: 'sine' },
		{ id: 4, type: 'env', inputs: { attack: 0.001, decay: 0.01, sustain: 1, release: 0.01 } },
		{ id: 5, type: 'mul' },
		{ id: 6, type: 'param', param: 7 },
		{ id: 8, type: 'mul' },
		{ id: 9, type: 'out' }
	],
	edges: [
		{ from: 1, port: 'pitch', to: 2, input: 'in' },
		{ from: 2, to: 3, input: 'freq' },
		{ from: 3, to: 5, input: 'a' },
		{ from: 4, to: 5, input: 'b' },
		{ from: 5, to: 8, input: 'a' },
		{ from: 6, to: 8, input: 'b' },
		{ from: 8, to: 9, input: 'l' },
		{ from: 8, to: 9, input: 'r' }
	]
};

const trim = {
	params: [{ id: 3, name: 'trim', scope: 'track', min: 0, max: 1, default: 1, smooth_ms: 0 }],
	nodes: [
		{ id: 1, type: 'in' },
		{ id: 2, type: 'param', param: 3 },
		{ id: 4, type: 'mul' },
		{ id: 5, type: 'mul' },
		{ id: 6, type: 'out' }
	],
	edges: [
		{ from: 1, port: 'l', to: 4, input: 'a' },
		{ from: 1, port: 'r', to: 5, input: 'a' },
		{ from: 2, to: 4, input: 'b' },
		{ from: 2, to: 5, input: 'b' },
		{ from: 4, to: 6, input: 'l' },
		{ from: 5, to: 6, input: 'r' }
	]
};

const moveSlider = (page: Page, label: string, value: string, event: 'input' | 'change') =>
	page
		.getByRole('tabpanel')
		.getByLabel(label, { exact: true })
		.evaluate(
			(e: HTMLInputElement, [to, kind]) => {
				e.value = to;
				e.dispatchEvent(new Event(kind, { bubbles: true }));
			},
			[value, event]
		);

test('insert and global sliders are heard as they move, and stay where they are put', async ({ page }) => {
	const voice = await savedPatch(page, 'Tone', tone);
	const insert = await savedPatch(page, 'Trim', trim);
	await trackWithClip(page, 'Sliders');
	await page.getByLabel('Patch slot 1', { exact: true }).selectOption(voice);
	const { x, y } = await rollPoint(page, 0, 60);
	await page.mouse.dblclick(x, y);
	await page.getByLabel('Note length').fill('1900');
	await page.getByLabel('Note length').blur();
	await tab(page, 'Mixer');
	await page.getByLabel('Add an insert to Track 1').selectOption(insert);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await page.getByRole('button', { name: 'Loop off' }).click();
	await startAudio(page);
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect.poll(() => stripPeak(page, 'master'), { timeout: 8000 }).toBeGreaterThan(0.1);
	const generation = await page.getByTestId('generation').textContent();

	const trimmed = page.getByTestId('strip-track:1').getByRole('slider', { name: 'trim' });
	await trimmed.evaluate((e: HTMLInputElement) => {
		e.value = '0';
		e.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await expect.poll(() => stripPeak(page, 'master'), { timeout: 4000 }).toBeLessThan(0.001);
	await expect(page.getByTestId('generation')).toHaveText(generation!);
	await trimmed.evaluate((e: HTMLInputElement) => e.dispatchEvent(new Event('change', { bubbles: true })));
	await expect.poll(async () => (await timelineDoc(page)).tracks[0].inserts[0].params).toEqual({ '3': 0 });
	await tab(page, 'Mixer');
	await expect(page.getByTestId('generation')).not.toHaveText(generation!, { timeout: 8000 });
	await page.waitForTimeout(300);
	expect(await stripPeak(page, 'master')).toBeLessThan(0.001);

	// The document says 1 again, and that has to win over the 0 the swap would carry.
	await undo(page);
	await expect.poll(() => stripPeak(page, 'master'), { timeout: 8000 }).toBeGreaterThan(0.1);

	await moveSlider(page, 'level', '0', 'input');
	await expect.poll(() => stripPeak(page, 'master'), { timeout: 4000 }).toBeLessThan(0.001);
	await moveSlider(page, 'level', '0', 'change');
	await expect.poll(async () => (await timelineDoc(page)).globals).toEqual({ '7': 0 });
	await tab(page, 'Mixer');
	await page.waitForTimeout(500);
	expect(await stripPeak(page, 'master')).toBeLessThan(0.001);
	await undo(page);
	await expect.poll(() => stripPeak(page, 'master'), { timeout: 8000 }).toBeGreaterThan(0.1);
});

test('a value edited in the JSON is what plays, over what a swap would carry', async ({ page }) => {
	const voice = await savedPatch(page, 'Tone two', { ...tone, params: [{ ...tone.params[0], scope: 'track' }] });
	await trackWithClip(page, 'Edited values');
	await page.getByLabel('Patch slot 1', { exact: true }).selectOption(voice);
	const { x, y } = await rollPoint(page, 0, 60);
	await page.mouse.dblclick(x, y);
	await page.getByLabel('Note length').fill('1900');
	await page.getByLabel('Note length').blur();
	await page.getByRole('button', { name: 'Loop off' }).click();
	await startAudio(page);
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect
		.poll(() => page.getByRole('meter', { name: 'Master level' }).getAttribute('data-peak').then(Number), {
			timeout: 8000
		})
		.toBeGreaterThan(0.1);
	const editor = await timelineJson(page);
	await editor.fill((await editor.inputValue()).replace('"params": {}', '"params": { "7": 0 }'));
	await expect
		.poll(() => page.getByRole('meter', { name: 'Master level' }).getAttribute('data-peak').then(Number), {
			timeout: 8000
		})
		.toBeLessThan(0.001);
});

test('a patch edit is heard in the song as it is made', async ({ page }) => {
	await startPlaying(page, 'ballad');
	await expect(page.getByTestId('voices')).toHaveText('3');
	const graph = await graphJson(page);
	// Silence the voice by unwiring its output, which the compiler refuses, so the old sound plays on and the node says why.
	const text = await graph.inputValue();
	type Edge = { from: number; port?: string; to: number; input?: string };
	const edited = JSON.parse(text);
	const out = edited.nodes.find((node: { type: string }) => node.type === 'out');
	const into = edited.edges.find((edge: Edge) => edge.to === out.id) as Edge;
	edited.edges = edited.edges.filter((edge: Edge) => edge.to !== out.id);
	await graph.fill(JSON.stringify(edited, null, 1));
	await expect(page.getByTestId('compile-error')).toContainText('out node has no input');
	await expect(page.getByTestId('generation')).toHaveText('1');
	// Through a multiply by zero, it compiles, and the song swaps to that without stopping.
	edited.nodes.push({ id: 999, type: 'mul', inputs: { b: 0 } });
	edited.edges.push(
		{ from: into.from, port: into.port, to: 999, input: 'a' },
		{ from: 999, to: out.id, input: 'l' },
		{ from: 999, to: out.id, input: 'r' }
	);
	await graph.fill(JSON.stringify(edited, null, 1));
	await expect(page.getByTestId('generation')).toHaveText('2', { timeout: 8000 });
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await expect
		.poll(() => page.getByRole('meter', { name: 'Master level' }).getAttribute('data-peak').then(Number), {
			timeout: 8000
		})
		.toBeLessThan(0.001);
	await expect(page.getByTestId('voices')).not.toHaveText('0');
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');
	await graphView(page);
	await expect(page.getByTestId(`node-${out.id}`)).toHaveAttribute('data-error', 'false');
});

test('a recipe shows its notes and mix, and none of it can be changed', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1500 });
	await page.goto('/?recipe=FrenchHorn');
	await expect(page.getByTestId('placement-1-0')).toBeVisible();
	await expect(page.getByTestId('note-0')).toBeAttached();
	await expect(page.getByLabel('Play mode')).toHaveValue('legato');
	await expect(page.getByLabel('Play mode')).toBeDisabled();
	await tab(page, 'Mixer');
	await expect(page.getByLabel('Fader for Master')).toBeDisabled();
	await tab(page, 'Notes');
	await expect(page.getByRole('button', { name: 'Add track' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
	await expect(page.getByTestId('repeat-1-0')).toHaveCount(0);

	const row = (await page.getByTestId('row-1').boundingBox())!;
	await page.mouse.dblclick(row.x + 700, row.y + 20);
	await expect(page.getByTestId('placement-1-1')).toHaveCount(0);

	const notes = await page.locator('[data-testid^="note-"]').count();
	const body = await centre(page, 'placement-1-0');
	await page.mouse.move(body.x, body.y);
	await page.mouse.down();
	await page.mouse.move(body.x + 200, body.y, { steps: 3 });
	await expect(page.getByTestId('placement-1-0')).toHaveAttribute('data-tick', '0'); // Not even while it is held
	await page.mouse.up();
	await expect(page.getByTestId('placement-1-0')).toHaveAttribute('data-tick', '0');
	await page.keyboard.press('Delete');
	await page.getByTestId('roll').focus();
	await page.keyboard.press('Control+a');
	await page.keyboard.press('Delete');
	await expect(page.getByTestId('placement-1-0')).toBeVisible();
	await expect(page.locator('[data-testid^="note-"]')).toHaveCount(notes);
});

test('a recipe with automation shows its lanes', async ({ page }) => {
	await page.goto('/?recipe=PitchBend');
	await expect(page.getByTestId('lane-0')).toBeVisible();
	await expect(page.locator('[data-testid^="lane-0-point-"]').first()).toBeAttached();
	await expect(page.getByRole('button', { name: /^Remove lane/ })).toHaveCount(0);
	await expect(page.getByLabel('Add a lane')).toHaveCount(0);
});

// A short sine, so that a test doesn't depend on a file.
function wavBytes(seconds: number, frequency = 440, rate = 48000) {
	const frames = Math.round(seconds * rate);
	const out = Buffer.alloc(44 + frames * 2);
	out.write('RIFF', 0, 'latin1');
	out.writeUInt32LE(36 + frames * 2, 4);
	out.write('WAVEfmt ', 8, 'latin1');
	out.writeUInt32LE(16, 16);
	out.writeUInt16LE(1, 20);
	out.writeUInt16LE(1, 22);
	out.writeUInt32LE(rate, 24);
	out.writeUInt32LE(rate * 2, 28);
	out.writeUInt16LE(2, 32);
	out.writeUInt16LE(16, 34);
	out.write('data', 36, 'latin1');
	out.writeUInt32LE(frames * 2, 40);
	for (let i = 0; i < frames; ++i) {
		out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 24000), 44 + i * 2);
	}
	return out;
}

const wavFile = (name: string, seconds = 0.5, frequency = 440) => ({
	name,
	mimeType: 'audio/wav',
	buffer: wavBytes(seconds, frequency)
});

const samples = (page: Page) => browser(page).getByRole('list', { name: 'Samples' });

test('WAV files become an instrument that plays, and its samples stay while it does', async ({ page }) => {
	await page.goto('/');
	await page.getByLabel('WAV files').setInputFiles([wavFile('Sine_A3.wav'), wavFile('Sine_A4.wav')]);
	await page.getByLabel('Instrument name').fill('Imported sines');
	await page.getByRole('button', { name: 'Import' }).click();
	await page.waitForURL(/patch=/);
	const id = shownPatchId(page);
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Imported sines');
	await expect(page.getByTestId('compile-error')).toHaveCount(0);

	await page.getByRole('button', { name: 'sample 2' }).click();
	await expect(page.getByLabel('Zone 1 highest key')).toHaveValue('63');
	await expect(page.getByLabel('Zone 2 lowest key')).toHaveValue('64');
	await expect(page.getByLabel('Zone 1 root')).toHaveValue('57');
	await expect(page.getByLabel('Zone 2 root')).toHaveValue('69');
	await page.getByLabel('Zone 2 root').fill('60');
	await page.getByLabel('Zone 2 root').blur();
	await expect(await graphJson(page)).toHaveValue(/"root": 60/);
	await graphView(page);

	const key = page.getByRole('button', { name: '60', exact: true });
	await key.dispatchEvent('pointerdown'); // Starts audio, with the instrument on its own since no track plays it
	await expect(page.getByTestId('state')).toHaveAttribute('data-playing', 'true', { timeout: 10000 });
	await expect.poll(async () => Math.max(0, ...(await patchPeaks(page))), { timeout: 8000 }).toBeGreaterThan(0.1);
	await key.dispatchEvent('pointerup');

	await page.goto('/');
	await expect(samples(page).getByText('Sine_A3')).toBeVisible();
	await page.getByRole('button', { name: 'Delete Sine_A3' }).click();
	await expect(page.getByText('used by Imported sines')).toBeVisible();
	await expect(samples(page).getByText('Sine_A3')).toBeVisible();

	await page.goto(`/?patch=${id}`);
	await page.getByRole('button', { name: 'Delete patch' }).click();
	await page.waitForURL((url) => !url.searchParams.has('patch'));
	await page.getByRole('button', { name: 'Delete Sine_A3' }).click();
	await expect(samples(page).getByText('Sine_A3')).toHaveCount(0);
});

test('a file that is not audio is refused and leaves nothing behind', async ({ page }) => {
	await page.goto('/');
	await page
		.getByLabel('WAV files')
		.setInputFiles([
			wavFile('Good.wav'),
			{ name: 'Notes.wav', mimeType: 'audio/wav', buffer: Buffer.from('these are not samples') }
		]);
	await page.getByRole('button', { name: 'Import' }).click();
	await expect(page.getByText("Notes.wav can't be imported: it is not a WAV file")).toBeVisible();
	await expect(samples(page).getByText('Good', { exact: true })).toHaveCount(0);
});

test('an image too large for the engine says so instead of going quiet', async ({ page }) => {
	test.setTimeout(60000);
	const ids: string[] = [];
	// Two different sounds, because two the same would be one chunk and fit.
	for (const [name, frequency] of [
		['Big one', 440],
		['Big two', 330]
	] as const) {
		await page.goto('/');
		await page.getByLabel('WAV files').setInputFiles([wavFile(`${name}.wav`, 90, frequency)]);
		await page.getByLabel('Instrument name').fill(name);
		await page.getByRole('button', { name: 'Import' }).click();
		await page.waitForURL(/patch=/);
		ids.push(shownPatchId(page));
	}
	await trackWithClip(page, 'Too large');
	await page.getByLabel('Patch slot 1', { exact: true }).selectOption(ids[0]);
	await addNoteAt(page, 0, 60);
	await page.getByRole('button', { name: 'Add track' }).click();
	await page.getByLabel('Patch slot 1', { exact: true }).selectOption(ids[1]);
	const row = (await page.getByTestId('row-2').boundingBox())!;
	await page.mouse.dblclick(row.x + 10, row.y + 20);
	await expect(page.getByTestId('placement-2-0')).toBeVisible();
	await addNoteAt(page, 0, 60);
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('load-rejected')).toContainText('larger than the image slot', { timeout: 20000 });
});

test("a probe stops when another patch is chosen, even one that can't be probed", async ({ page }) => {
	await page.goto('/?recipe=SidechainDucking');
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await page.getByRole('group', { name: 'Patches in this recipe' }).getByRole('button', { name: 'pad' }).click();
	await page.locator('g.node:has(text:has-text("env"))').first().locator('rect.title').click();
	await page.getByRole('button', { name: 'Probe out' }).click();
	const label = page.locator('span').filter({ hasText: /env\.out$/ });
	await expect(label).toBeVisible();
	await page.getByRole('group', { name: 'Patches in this recipe' }).getByRole('button', { name: 'duck' }).click();
	await expect(label).toHaveCount(0);
	await expect(page.getByTestId('patch-use')).toContainText("can't be probed");
});

test('a clip repeated as far as a document allows leaves the page working', async ({ page }) => {
	await trackWithClip(page, 'Very long');
	const editor = await timelineJson(page);
	await editor.fill((await editor.inputValue()).replace('"repeat": 1', '"repeat": 100000'));
	await expect(page.getByTestId('placement-1-0')).toHaveAttribute('data-repeat', '100000', { timeout: 8000 });
	await page.getByRole('button', { name: 'Add track' }).click();
	await expect(page.getByTestId('row-2')).toBeAttached();
});

test('an unknown recipe is a 404', async ({ page }) => {
	expect((await page.goto('/recipes/Nothing'))?.status()).toBe(404);
	expect((await page.goto('/?recipe=Nothing'))?.status()).toBe(404);
});
