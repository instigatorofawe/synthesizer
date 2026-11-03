import { expect, test as base, type Page } from '@playwright/test';
import { loopButton, undoButton } from './Chrome.ts';
import { engineRenders, loudest, settled } from './Engine.ts';
import { openView } from './Views.ts';

// A page load waits until the page has hydrated, as AppTest.ts does: what is typed into it before then is lost.
const test = base.extend({
	page: async ({ page }, use) => {
		const hydrated = async <T extends { ok(): boolean } | null>(response: T) => {
			if (response?.ok()) await page.locator('body[data-hydrated]').waitFor({ state: 'attached' });
			return response;
		};
		const goto = page.goto.bind(page);
		const reload = page.reload.bind(page);
		page.goto = async (...args) => hydrated(await goto(...args));
		page.reload = async (...args) => hydrated(await reload(...args));
		await use(page);
	}
});

// Wide enough that the browser, where patches and timelines are made, sits beside the page.
test.use({ viewport: { width: 1440, height: 900 } });

// Leaving with unsaved edits asks first, and a test that leaves means to.
test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

// A sine as loud as its note's velocity, held while its key is, times a level the song can set: so a meter reads the level
// and the velocity straight off.
function tone(level: { scope: string; default: number }) {
	return {
		params: [{ id: 7, name: 'level', min: 0, max: 1, smooth_ms: 0, ...level }],
		nodes: [
			{ id: 1, type: 'note' },
			{ id: 2, type: 'mtof' },
			{ id: 3, type: 'osc', wave: 'sine' },
			{ id: 4, type: 'env', inputs: { attack: 0.001, decay: 0.01, sustain: 1, release: 0.01 } },
			{ id: 5, type: 'mul' },
			{ id: 6, type: 'param', param: 7 },
			{ id: 8, type: 'mul' },
			{ id: 9, type: 'mul' },
			{ id: 10, type: 'out' }
		],
		edges: [
			{ from: 1, port: 'pitch', to: 2, input: 'in' },
			{ from: 2, to: 3, input: 'freq' },
			{ from: 3, to: 5, input: 'a' },
			{ from: 4, to: 5, input: 'b' },
			{ from: 5, to: 8, input: 'a' },
			{ from: 6, to: 8, input: 'b' },
			{ from: 8, to: 9, input: 'a' },
			{ from: 1, port: 'velocity', to: 9, input: 'b' },
			{ from: 9, to: 10, input: 'l' },
			{ from: 9, to: 10, input: 'r' }
		]
	};
}

// A saw through a filter whose cutoff, from 20 Hz to 20 kHz, is a parameter: a range that calls for a log taper.
const filtered = {
	params: [{ id: 1, name: 'cutoff', scope: 'track', min: 20, max: 20000, default: 1000, smooth_ms: 10 }],
	nodes: [
		{ id: 1, type: 'note' },
		{ id: 2, type: 'mtof' },
		{ id: 3, type: 'osc', wave: 'saw' },
		{ id: 4, type: 'biquad', mode: 'lowpass' },
		{ id: 5, type: 'param', param: 1 },
		{ id: 6, type: 'out' }
	],
	edges: [
		{ from: 1, port: 'pitch', to: 2, input: 'in' },
		{ from: 2, to: 3, input: 'freq' },
		{ from: 3, to: 4, input: 'in' },
		{ from: 5, to: 4, input: 'cutoff' },
		{ from: 4, to: 6, input: 'l' }
	]
};

const masterPeak = (page: Page) =>
	page.getByRole('meter', { name: 'Master level' }).getAttribute('data-peak').then(Number);
// The loudest the master has been since Play, or since the image playing now began.
const masterLoudest = (page: Page) => loudest(page.getByRole('meter', { name: 'Master level' }));
const voices = (page: Page) => page.getByTestId('voices');
const holdButton = (page: Page) => page.getByRole('button', { name: 'Hold', exact: true });
const control = (page: Page, name: string) => page.getByRole('slider', { name: `Control ${name}`, exact: true });
const controlRow = (page: Page, id: number) => page.getByTestId(`control-${id}`);

// The patch's JSON is the side column's last tab, and the Controls are over its Node and Patch tabs.
async function graphJson(page: Page) {
	await page.getByRole('tablist', { name: 'Side column' }).getByRole('tab', { name: 'JSON' }).click();
	return page.getByLabel('Graph JSON');
}

async function graphView(page: Page) {
	const tab = page.getByRole('tablist', { name: 'Side column' }).getByRole('tab', { name: 'Patch' });
	await tab.click();
	await expect(tab).toHaveAttribute('aria-selected', 'true');
}

const patchGraph = async (page: Page) => {
	const graph = JSON.parse(await (await graphJson(page)).inputValue());
	await graphView(page);
	return graph;
};

// A new patch with this graph, heard on its own in the Patch view.
async function newPatch(page: Page, name: string, graph: object) {
	await page.goto('/');
	await page.getByRole('button', { name: 'New patch', exact: true }).click(); // Its + opens the field
	await page.getByLabel('New patch name').fill(name);
	await page.getByLabel('New patch name').press('Enter');
	await page.waitForURL(/patch=/);
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue(name);
	await (await graphJson(page)).fill(JSON.stringify(graph));
	await graphView(page);
	await settled(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	return new URL(page.url()).searchParams.get('patch')!;
}

async function timelineJson(page: Page) {
	await page.getByRole('tablist', { name: 'Timeline views' }).getByRole('tab', { name: /^JSON/ }).click();
	return page.getByLabel('Timeline JSON');
}

async function timelineDoc(page: Page) {
	const doc = JSON.parse(await (await timelineJson(page)).inputValue());
	await page
		.getByRole('tablist', { name: 'Timeline views' })
		.getByRole('tab', { name: /^Notes/ })
		.click();
	return doc;
}

// A saved song of one track playing the tone, which holds one note for its one bar, looped so the note is always sounding. It
// opens in the Song view with the track chosen.
async function toneSong(page: Page, name: string) {
	const patch = await newPatch(page, `${name} tone`, tone({ scope: 'track', default: 1 }));
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByRole('button', { name: 'New timeline', exact: true }).click(); // Its + opens the field
	await page.getByLabel('New timeline name').fill(name);
	await page.getByLabel('New timeline name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByLabel('Timeline name', { exact: true })).toHaveValue(name);
	const doc = {
		ppq: 480,
		tempo: [{ tick: 0, bpm: 120 }],
		// One note held through eight bars, so the loop comes round only after 16 s. The first wrap after a live swap is louder
		// for a moment, as if the note let go rang on under the one that starts, which a freshly loaded image doesn't do. That's
		// the engine's, not the Controls', and no measurement here should take it in: on CI's slower runner a one-bar loop came
		// round inside one and read 1.8 times the level the Control had set.
		clips: [{ id: 'held', length: 15360, notes: [{ tick: 0, note: 69, vel: 127, dur: 15360 }] }],
		tracks: [{ id: 1, name: 'Tone', voices: 4, slots: [patch], placements: [{ clip: 'held', tick: 0 }] }]
	};
	await (await timelineJson(page)).fill(JSON.stringify(doc, null, 1));
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await page.reload();
	await expect(page.getByTestId('track-1')).toHaveAttribute('aria-pressed', 'true');
	return patch;
}

async function play(page: Page) {
	await settled(page);
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).not.toHaveText('0', { timeout: 10000 });
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect(page.getByTestId('state')).toHaveAttribute('data-playing', 'true');
}

// Moves a slider to one of its steps, as a drag does, and lets go of it there unless `letGo` is false.
async function slide(page: Page, name: string, step: number, letGo = true) {
	await control(page, name).evaluate(
		(e: HTMLInputElement, [to, done]) => {
			e.value = String(to);
			e.dispatchEvent(new Event('input', { bubbles: true }));
			if (done) e.dispatchEvent(new Event('change', { bubbles: true }));
		},
		[step, letGo] as const
	);
}

test("a Control on a track's patch is the track's value: saved with the song as it is let go, and heard after a reload", async ({
	page
}) => {
	await toneSong(page, 'Control saved');
	await loopButton(page).click();
	await play(page);
	await expect.poll(() => masterPeak(page), { timeout: 8000 }).toBeGreaterThan(0.1);
	await engineRenders(page, 0.3);
	const full = await masterLoudest(page); // At a level of 1

	await openView(page, 'patch');
	await expect(page.getByTestId('hearing')).toHaveAttribute('data-kind', 'song');
	const level = control(page, 'level');
	await expect(level).toHaveAttribute('aria-valuetext', '1');
	await expect(level).toHaveAttribute('title', /saved with the song as Tone's value/);
	await expect(controlRow(page, 7)).toHaveAttribute('data-own', 'false');

	// Dragged, it moves the sound and compiles nothing.
	const compiles = await page.getByTestId('compiles').textContent();
	await slide(page, 'level', 125, false);
	await expect(level).toHaveAttribute('aria-valuetext', '0.25');
	await expect.poll(() => masterPeak(page), { timeout: 4000 }).toBeLessThan(0.3 * full);
	expect(await masterPeak(page)).toBeGreaterThan(0.2 * full);
	expect(await page.getByTestId('compiles').textContent()).toBe(compiles);

	// Let go, the song holds it, and compiles once.
	await slide(page, 'level', 125);
	await expect(controlRow(page, 7)).toHaveAttribute('data-own', 'true');
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');
	await settled(page);
	await expect(page.getByTestId('compiles')).toHaveText(String(Number(compiles) + 1));
	await engineRenders(page, 0.3);
	expect(await masterLoudest(page)).toBeLessThan(0.3 * full); // Since the new image began, which settled the song's value
	expect(await masterPeak(page)).toBeGreaterThan(0.2 * full);

	// It is one step of the song's undo.
	await openView(page, 'song');
	expect((await timelineDoc(page)).tracks[0].params).toEqual({ '7': 0.25 });
	await undoButton(page).click();
	expect((await timelineDoc(page)).tracks[0].params).toEqual({});
	await openView(page, 'patch');
	await expect(level).toHaveAttribute('aria-valuetext', '1');
	await openView(page, 'song');
	await page.keyboard.press('ControlOrMeta+Shift+z');
	expect((await timelineDoc(page)).tracks[0].params).toEqual({ '7': 0.25 });

	// Saved and loaded again, the slider starts there, and that is what plays.
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await page.reload();
	await openView(page, 'patch');
	await expect(level).toHaveAttribute('aria-valuetext', '0.25');
	await play(page);
	await expect.poll(() => masterPeak(page), { timeout: 8000 }).toBeGreaterThan(0.2 * full);
	await engineRenders(page, 0.3);
	expect(await masterLoudest(page)).toBeLessThan(0.3 * full);
});

test('Make default writes the value into the patch, as a step of its undo, and the way back takes the track’s away', async ({
	page
}) => {
	await toneSong(page, 'Made default');
	await openView(page, 'patch');
	await expect(page.getByTestId('hearing')).toHaveAttribute('data-kind', 'song'); // Once the song has compiled
	const level = control(page, 'level');
	const make = page.getByRole('button', { name: 'Make default for level' });
	const reset = page.getByRole('button', { name: 'Reset level' });
	await expect(make).toHaveCount(0);
	await expect(reset).toBeHidden(); // There is nothing to go back from

	// A double-click on the value types one, which is saved as a slider let go is.
	await controlRow(page, 7).getByRole('button', { name: '1', exact: true }).dblclick();
	const typed = page.getByLabel('Control level, typed');
	await expect(typed).toBeFocused();
	await typed.fill('0.6');
	await typed.press('Enter');
	await expect(level).toHaveAttribute('aria-valuetext', '0.6');
	await expect(controlRow(page, 7)).toHaveAttribute('data-own', 'true');
	await expect(reset).toBeVisible();

	// Make default puts it in the patch, and the track keeps its own value, which is the same.
	await make.click();
	expect((await patchGraph(page)).params[0].default).toBe(0.6);
	await expect(make).toHaveCount(0);
	await expect(controlRow(page, 7)).toHaveAttribute('data-own', 'true');
	await expect(level).toHaveAttribute('aria-valuetext', '0.6');
	await expect(page.getByTestId('unsaved')).toHaveText('2 unsaved');

	// The Patch view's Undo takes it back out of the patch.
	await undoButton(page).click();
	expect((await patchGraph(page)).params[0].default).toBe(1);
	await expect(make).toBeVisible();

	// Enter on the value types one too, and Esc leaves it as it was.
	await controlRow(page, 7).getByRole('button', { name: '0.6', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(typed).toBeFocused();
	await typed.fill('0.1');
	await typed.press('Escape');
	await expect(typed).toHaveCount(0);
	await expect(level).toHaveAttribute('aria-valuetext', '0.6');

	// The way back to the patch's default takes the track's value away.
	await reset.click();
	await expect(controlRow(page, 7)).toHaveAttribute('data-own', 'false');
	await expect(level).toHaveAttribute('aria-valuetext', '1');
	await openView(page, 'song');
	expect((await timelineDoc(page)).tracks[0].params).toEqual({});

	// So does the menu a right-click opens.
	await openView(page, 'patch');
	await slide(page, 'level', 400);
	await expect(controlRow(page, 7)).toHaveAttribute('data-own', 'true');
	await controlRow(page, 7).click({ button: 'right' });
	await page
		.getByRole('menu', { name: 'Control level' })
		.getByRole('menuitem', { name: /^Back to the default/ })
		.click();
	await expect(controlRow(page, 7)).toHaveAttribute('data-own', 'false');
});

test('a slider over a wide range is logarithmic, its middle near the geometric middle, and Make default works heard alone', async ({
	page
}) => {
	await newPatch(page, 'Filtered', filtered);
	await expect(page.getByTestId('hearing')).toHaveAttribute('data-kind', 'alone');
	const cutoff = control(page, 'cutoff');
	await expect(cutoff).toHaveAttribute('data-taper', 'log');
	await expect(cutoff).toHaveAttribute('aria-valuetext', '1000 Hz');
	await expect(cutoff).toHaveAttribute('title', /No track plays this patch, so this moves the sound and saves nothing/);

	await slide(page, 'cutoff', 250);
	const middle = Number.parseFloat((await cutoff.getAttribute('aria-valuetext'))!);
	expect(middle / Math.sqrt(20 * 20000)).toBeGreaterThan(0.98);
	expect(middle / Math.sqrt(20 * 20000)).toBeLessThan(1.02);
	await expect(cutoff).toHaveAttribute('aria-valuetext', /^\d+ Hz$/);
	await slide(page, 'cutoff', 0);
	await expect(cutoff).toHaveAttribute('aria-valuetext', '20 Hz');
	await slide(page, 'cutoff', 500);
	await expect(cutoff).toHaveAttribute('aria-valuetext', '20000 Hz');

	// Heard on its own it saves nothing, but stays where it was left, and the patch's default can still be made.
	await slide(page, 'cutoff', 250);
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved'); // The patch, as it was made
	await expect(cutoff).toHaveAttribute('aria-valuetext', `${middle} Hz`);
	await page.getByRole('button', { name: 'Make default for cutoff' }).click();
	expect((await patchGraph(page)).params[0].default).toBe(middle);
});

test('Hold keeps a note sounding after its key comes up, until it is played again, Esc, or Hold off', async ({
	page
}) => {
	await newPatch(page, 'Held', tone({ scope: 'track', default: 1 }));
	await expect(page.getByTestId('hearing')).toHaveAttribute('data-kind', 'alone');
	const key = (note: number) => page.getByRole('button', { name: String(note), exact: true });

	// The keys play at the velocity by them: this tone is as loud as its velocity.
	const velocity = page.getByLabel('Velocity of the keys');
	await velocity.fill('127');
	await velocity.press('Enter');
	await velocity.blur(); // A field keeps the piano's keys
	await page.keyboard.down('a'); // C3, which starts audio
	await expect(page.getByTestId('generation')).not.toHaveText('0', { timeout: 10000 });
	await expect.poll(() => masterPeak(page), { timeout: 8000 }).toBeGreaterThan(0.1);
	await engineRenders(page, 0.2);
	const full = await masterLoudest(page); // Since this image began
	await page.keyboard.up('a');
	await expect(voices(page)).toHaveText('0');
	await velocity.fill('32');
	await velocity.press('Enter');
	await velocity.blur();
	await page.keyboard.down('a');
	await expect.poll(() => masterPeak(page), { timeout: 4000 }).toBeLessThan(0.3 * full);
	expect(await masterPeak(page)).toBeGreaterThan(0.2 * full);
	await page.keyboard.up('a');
	await expect(voices(page)).toHaveText('0');

	await holdButton(page).click();
	await expect(holdButton(page)).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.down('a');
	await expect(voices(page)).toHaveText('1');
	await page.keyboard.up('a');
	await expect(key(48)).toHaveClass(/latched/);
	await expect(holdButton(page)).toHaveAttribute('data-held', '1');
	await engineRenders(page, 0.5);
	await expect(voices(page)).toHaveText('1');
	expect(await masterPeak(page)).toBeGreaterThan(0.2 * full);

	// Played again, it goes.
	await page.keyboard.press('a');
	await expect(voices(page)).toHaveText('0');
	await expect(key(48)).not.toHaveClass(/latched/);

	// A mouse on the keys latches too, and Esc lets go.
	await key(52).dispatchEvent('pointerdown');
	await key(52).dispatchEvent('pointerup');
	await expect(key(52)).toHaveClass(/latched/);
	await expect(voices(page)).toHaveText('1');
	await page.keyboard.press('Escape');
	await expect(voices(page)).toHaveText('0');
	await expect(holdButton(page)).toHaveAttribute('aria-pressed', 'true');

	// Hold off lets go of everything it held.
	await page.keyboard.press('a');
	await page.keyboard.press('d');
	await expect(voices(page)).toHaveText('2');
	await engineRenders(page, 0.3);
	await expect(voices(page)).toHaveText('2');
	await holdButton(page).click();
	await expect(holdButton(page)).toHaveAttribute('aria-pressed', 'false');
	await expect(voices(page)).toHaveText('0');
	await expect(holdButton(page)).toHaveAttribute('data-held', '0');
	await expect(page.locator('.key.latched')).toHaveCount(0);
});

test("the keys' velocity is the roll's Vel: set in either view, it is what step entry writes", async ({ page }) => {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByRole('button', { name: 'New timeline', exact: true }).click(); // Its + opens the field
	await page.getByLabel('New timeline name').fill('Velocities');
	await page.getByLabel('New timeline name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByTestId('roll')).toBeVisible();
	const keys = page.getByLabel('Velocity of the keys');
	const roll = page.getByLabel('Velocity of new notes');
	await expect(keys).toHaveValue('100');
	await expect(roll).toHaveValue('100');

	await keys.fill('64');
	await keys.press('Enter');
	await expect(roll).toHaveValue('64');
	await keys.blur();
	await page.keyboard.press('r');
	await expect(page.getByTestId('step-cursor')).toHaveAttribute('data-tick', '0');
	await page.keyboard.press('a');
	const notes = page.locator('[data-testid^="note-"]');
	await expect(notes).toHaveCount(1);
	await expect(notes.first()).toHaveAttribute('data-vel', '64');

	// C and V step it in the Patch view as well, and the roll writes what the keys now play.
	await openView(page, 'patch');
	await page.keyboard.press('v');
	await expect(keys).toHaveValue('70');
	await openView(page, 'song');
	await expect(roll).toHaveValue('70');
	await page.keyboard.press('s');
	await expect(notes).toHaveCount(2);
	await expect(page.getByTestId('note-1')).toHaveAttribute('data-vel', '70');

	// The roll's field sets the keys' too.
	await roll.fill('20');
	await roll.press('Enter');
	await expect(keys).toHaveValue('20');
});
