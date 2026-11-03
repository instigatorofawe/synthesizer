import { expect, test as base, type Page } from '@playwright/test';
import { loopButton, undoButton } from './Chrome.ts';
import { engineRenders, goesRound, loudest, settled } from './Engine.ts';

// A page load waits until the page has hydrated, as AppTest's do.
const test = base.extend({
	page: async ({ page }, use) => {
		const goto = page.goto.bind(page);
		page.goto = async (...args) => {
			const response = await goto(...args);
			if (response?.ok()) await page.locator('body[data-hydrated]').waitFor({ state: 'attached' });
			return response;
		};
		await use(page);
	}
});

// The browser sits beside the page at this width, where its New timeline field is.
test.use({ viewport: { width: 1440, height: 900 } });

// Leaving with unsaved edits asks first, and a test that leaves means to.
test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

const BAR = 1920; // Ticks in a bar at a new timeline's 480 ppq
const QUARTER = 480; // A new timeline's Snap
const C3 = 48; // The A key, from the lowest C the keys show
const E3 = 52; // The D key

const recordButton = (page: Page) => page.getByTestId('record');
const notes = (page: Page) => page.locator('[data-testid^="note-"]');
const state = (page: Page) => page.getByTestId('state');
const tick = async (page: Page) => Number(await page.getByTestId('tick').textContent());

// What the roll's clip holds, as tick, pitch, length and velocity, in tick and then pitch order.
async function written(page: Page) {
	const all = await notes(page).evaluateAll((found) =>
		found.map((note) => ['tick', 'note', 'dur', 'vel'].map((name) => Number(note.getAttribute(`data-${name}`))))
	);
	return all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// A new timeline, as New timeline in the browser makes one: a piano track and an empty four-bar clip, open in the roll.
async function newSong(page: Page, name: string) {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByLabel('New timeline name').fill(name);
	await page.getByLabel('New timeline name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByLabel('Timeline name', { exact: true })).toHaveValue(name);
	await expect(page.getByTestId('roll')).toBeVisible();
	await settled(page);
}

async function tab(page: Page, name: 'Notes' | 'JSON') {
	await page
		.getByRole('tablist', { name: 'Timeline views' })
		.getByRole('tab', { name: new RegExp(`^${name}`) })
		.click();
}

// The song open, as its JSON has it.
async function timelineDoc(page: Page) {
	await tab(page, 'JSON');
	const doc = JSON.parse(await page.getByLabel('Timeline JSON').inputValue());
	await tab(page, 'Notes');
	return doc;
}

// Waits for the count-in, which the worklet clicks through, and for the take to start once it is over.
async function countedIn(page: Page) {
	await expect(recordButton(page)).toHaveAttribute('data-state', /counting|recording/, { timeout: 10000 });
	await expect(recordButton(page)).toHaveAttribute('data-state', 'recording', { timeout: 15000 });
	await expect(state(page)).toHaveAttribute('data-playing', 'true');
}

// A piano key played into the take: down, held while the engine renders `seconds`, and up.
async function playKey(page: Page, code: string, seconds = 0.3) {
	await page.keyboard.down(code);
	await engineRenders(page, seconds);
	await page.keyboard.up(code);
}

test('Record counts a bar in, then writes what the keys play into the clip, snapped, as one step to undo', async ({
	page
}) => {
	await newSong(page, 'Take one');
	await expect(recordButton(page)).toHaveAttribute('data-state', 'off');
	await expect(notes(page)).toHaveCount(0);

	// The template's track has no notes yet, so the take waits for an image that plays it, and then counts a bar in.
	await recordButton(page).click();
	await countedIn(page);
	expect(Number(await state(page).getAttribute('data-clicks'))).toBeGreaterThanOrEqual(5); // Four counted in, and the downbeat
	await expect(page.getByRole('group', { name: 'Keys' })).toHaveAttribute('title', /Recording/);

	const before = await tick(page);
	await playKey(page, 'KeyA');
	await expect(notes(page)).toHaveCount(1);
	const after = await tick(page);
	const [[at, pitch, dur, vel]] = await written(page);
	expect(pitch).toBe(C3);
	expect(vel).toBe(100);
	expect(at % QUARTER).toBe(0);
	expect(dur % QUARTER).toBe(0);
	expect(dur).toBeGreaterThanOrEqual(QUARTER);
	// Where it was heard, which latency puts no later than where the playhead had got to.
	expect(at).toBeGreaterThanOrEqual(Math.floor(before / QUARTER) * QUARTER - QUARTER);
	expect(at).toBeLessThanOrEqual(after + QUARTER);
	// The key sounded in the song, which plays on, rather than on its own.
	expect(await loudest(page.getByRole('meter', { name: 'Master level', includeHidden: true }))).toBeGreaterThan(0.01);

	// Record again stops recording, and the song plays on.
	await recordButton(page).click();
	await expect(recordButton(page)).toHaveAttribute('data-state', 'off');
	await expect(state(page)).toHaveAttribute('data-recording', '0');
	await expect(state(page)).toHaveAttribute('data-playing', 'true');
	await playKey(page, 'KeyD', 0.1);
	await engineRenders(page, 0.1);
	await expect(notes(page)).toHaveCount(1);
	await page.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect(state(page)).toHaveAttribute('data-playing', 'false');

	await undoButton(page).click();
	await expect(notes(page)).toHaveCount(0);
});

test('Shift+R records round a loop, each pass adding to the clip', async ({ page }) => {
	await newSong(page, 'Round and round');
	// A one-bar clip at 240 BPM, so a pass takes a second.
	const doc = await timelineDoc(page);
	doc.clips[0].length = BAR;
	doc.tempo = [{ tick: 0, bpm: 240 }];
	await tab(page, 'JSON');
	await page.getByLabel('Timeline JSON').fill(JSON.stringify(doc, null, 1));
	await tab(page, 'Notes');
	await settled(page);
	await loopButton(page).click();
	await expect(loopButton(page)).toHaveAttribute('aria-pressed', 'true');

	await page.keyboard.press('Shift+KeyR');
	await countedIn(page);
	await playKey(page, 'KeyA', 0.1);
	await expect(notes(page)).toHaveCount(1);
	await goesRound(page, 1, BAR);
	await playKey(page, 'KeyD', 0.1);
	await expect(notes(page)).toHaveCount(2);
	expect((await written(page)).map(([, pitch]) => pitch).sort()).toEqual([C3, E3]);
	expect((await written(page)).every(([at]) => at >= 0 && at < BAR)).toBe(true);

	// Space stops the song and the take, and the take undoes in one step.
	await page.keyboard.press('Space');
	await expect(recordButton(page)).toHaveAttribute('data-state', 'off');
	await expect(state(page)).toHaveAttribute('data-playing', 'false');
	expect((await timelineDoc(page)).clips).toHaveLength(1);
	await undoButton(page).click();
	await expect(notes(page)).toHaveCount(0);
});

test('a take past the last clip starts a clip of its own, and the song plays on past its end', async ({ page }) => {
	await newSong(page, 'Further on');
	const position = page.getByTestId('position');
	await position.click();
	await position.fill('6');
	await position.press('Enter');
	await expect(position).toHaveValue('6.1.000');

	await recordButton(page).click();
	await countedIn(page);
	await playKey(page, 'KeyA');
	await expect(page.getByTestId('placement-1-1')).toBeVisible();
	expect(await tick(page)).toBeGreaterThan(5 * BAR);
	await page.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect(recordButton(page)).toHaveAttribute('data-state', 'off');

	const doc = await timelineDoc(page);
	const placed = doc.tracks[0].placements[1];
	expect(placed.tick).toBe(5 * BAR);
	const clip = doc.clips.find((c: { id: string }) => c.id === placed.clip);
	expect(clip.length).toBe(BAR);
	expect(clip.notes).toHaveLength(1);
	expect(clip.notes[0].note).toBe(C3);
	// The roll shows the clip the take wrote into.
	await expect(notes(page)).toHaveCount(1);
});

test("an example can't be recorded into", async ({ page }) => {
	await page.goto('/?recipe=PluckedString');
	await expect(recordButton(page)).toBeDisabled();
	await expect(recordButton(page)).toHaveAttribute('title', /example can't be recorded into/);
});
