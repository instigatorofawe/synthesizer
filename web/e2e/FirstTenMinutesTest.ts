import { expect, test as base, type Page } from '@playwright/test';
import { loopButton, startAudio, undoButton } from './Chrome.ts';
import { engineRenders, loudest, settled } from './Engine.ts';

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
const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });
const keys = (page: Page) => page.getByRole('group', { name: 'Keys' });

// A new timeline, as New timeline in the browser makes one.
async function newSong(page: Page, name: string) {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByRole('button', { name: 'New song', exact: true }).click(); // Its + opens the field
	await page.getByLabel('New song name').fill(name);
	await page.getByLabel('New song name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByLabel('Song name', { exact: true })).toHaveValue(name);
}

async function tab(page: Page, name: 'Notes' | 'Mixer' | 'JSON') {
	await page
		.getByRole('tablist', { name: 'Song views' })
		.getByRole('tab', { name: new RegExp(`^${name}`) })
		.click();
}

async function timelineDoc(page: Page) {
	await tab(page, 'JSON');
	const doc = JSON.parse(await page.getByLabel('Song JSON').inputValue());
	await tab(page, 'Notes');
	return doc;
}

const noteTicks = async (page: Page, clip = 'clip') =>
	(await timelineDoc(page)).clips
		.find((c: { id: string }) => c.id === clip)
		.notes.map((n: { tick: number; note: number }) => [n.tick, n.note]);

// The loudest a meter has been since Play or since the image playing now began. A piano dies away while its key is held, so
// its level may be gone when it's read, but not this.
const level = (page: Page, name: string) => loudest(page.getByRole('meter', { name, includeHidden: true }));

const stripPeak = async (page: Page, chain: string) =>
	Number(await page.getByTestId(`strip-${chain}`).getByTestId('peak').getAttribute('data-peak'));

// Where a note at this tick and pitch lands in the roll, a little inside its cell.
async function rollPoint(page: Page, tick: number, note: number) {
	const roll = page.getByTestId('roll');
	const box = (await roll.boundingBox())!;
	const key = (await page.getByTestId(`key-${note}`).boundingBox())!;
	return { x: box.x + tick * Number(await roll.getAttribute('data-per-tick')) + 3, y: key.y + key.height / 2 };
}

// Whether the last key pressed was kept from the browser, which would bookmark the page for Mod+D. This listens after the page's
// own handlers.
async function watchPrevented(page: Page) {
	await page.evaluate(() => {
		const seen = window as unknown as { prevented: boolean };
		window.addEventListener('keydown', (event) => (seen.prevented = event.defaultPrevented));
	});
}
const prevented = (page: Page) => page.evaluate(() => (window as unknown as { prevented: boolean }).prevented);

test('a new timeline opens on a track with a built-in patch and a four-bar clip in the roll, and its keys sound at once', async ({
	page
}) => {
	await newSong(page, 'First minutes');
	await expect(page.getByTestId('track-1')).toBeVisible();
	await expect(page.getByTestId('track-2')).toHaveCount(0);
	await expect(page.getByTestId('track-patch-1')).toHaveText('FurElise Electric piano');
	// Its clip is chosen and open in the roll, around middle C
	await expect(page.getByTestId('placement-1-0')).toHaveClass(/chosen/);
	await expect(page.getByTestId('placement-1-0')).toHaveAttribute('data-tick', '0');
	await expect(page.getByRole('tab', { name: 'Notes: clip' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('key-60')).toBeInViewport({ ratio: 0.9 });

	// The keys play the track before it has a note, on its own
	await expect(keys(page)).toHaveAttribute('title', /^Keys play Track 1, on its own until it has notes\./);
	await expect(keys(page).getByRole('button', { name: 'C4', exact: true })).toBeEnabled();
	await page.getByTestId('roll').focus();
	await page.keyboard.down('a'); // Starts audio, as a key does
	await expect.poll(() => level(page, 'Master level'), { timeout: 10000 }).toBeGreaterThan(0.005);
	await page.keyboard.up('a');

	// It is an ordinary timeline: one track, its patch, and an empty clip four bars long at bar 1
	const doc = await timelineDoc(page);
	expect(doc.tracks.map((t: { slots: string[] }) => t.slots)).toEqual([['builtin-FurElise-piano']]);
	expect(doc.tracks[0].placements).toEqual([{ clip: 'clip', tick: 0, repeat: 1 }]);
	expect(doc.clips).toEqual([{ id: 'clip', length: 4 * BAR, notes: [], automation: [], play: [] }]);
	await expect(page.getByTestId('unsaved')).toHaveCount(0);

	// A note in the roll puts the track in the song, where the keys then play it
	const at = await rollPoint(page, 0, 60);
	await page.mouse.click(at.x, at.y);
	await expect(page.getByTestId('note-0')).toBeVisible();
	await expect(keys(page)).toHaveAttribute('title', /^Keys play Track 1\./, { timeout: 8000 });
	// The song's image is playing, and long enough that the meter holds only what it has played
	await settled(page);
	await engineRenders(page, 0.1);
	await page.getByTestId('roll').focus();
	await page.keyboard.down('k');
	await expect.poll(() => level(page, 'Level of Track 1'), { timeout: 10000 }).toBeGreaterThan(0.005);
	await page.keyboard.up('k');
});

test('M and S in the track heads and the Mixer agree: a mute is saved and undone, and a solo is never saved', async ({
	page
}) => {
	await page.goto('/?timeline=song');
	const heads = (name: string) => page.getByRole('group', { name: `Mute and solo ${name}` });
	const headMute = (name: string) => heads(name).getByRole('button', { name: 'Mute', exact: true });
	const headSolo = (name: string) => heads(name).getByRole('button', { name: 'Solo', exact: true });
	const mixerMute = (name: string) =>
		page.getByTestId('mixer').getByRole('button', { name: `Mute ${name}`, exact: true });
	const mixerSolo = (name: string) =>
		page.getByTestId('mixer').getByRole('button', { name: `Solo ${name}`, exact: true });
	const undo = undoButton(page);
	await tab(page, 'Mixer');

	// A head's M is the track's mute, which the Mixer shows and the document holds, and it is one step of undo
	await expect(headMute('Lead')).toHaveAttribute('aria-pressed', 'false');
	await expect(headMute('Lead')).toHaveAttribute('title', /saved with the song/);
	await headMute('Lead').click();
	await expect(headMute('Lead')).toHaveAttribute('aria-pressed', 'true');
	await expect(mixerMute('Lead')).toHaveAttribute('aria-pressed', 'true');
	expect((await timelineDoc(page)).tracks.map((t: { mute: boolean }) => t.mute)).toEqual([true, false]);
	await undo.click();
	await expect(headMute('Lead')).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await tab(page, 'Mixer');
	await expect(mixerMute('Lead')).toHaveAttribute('aria-pressed', 'false');
	// And the Mixer's Mute shows in the head
	await mixerMute('Pluck').click();
	await expect(headMute('Pluck')).toHaveAttribute('aria-pressed', 'true');
	await mixerMute('Pluck').click();
	await expect(headMute('Pluck')).toHaveAttribute('aria-pressed', 'false');

	// A solo shows in both, from either, and isn't in the document
	await headSolo('Pluck').click();
	await expect(headSolo('Pluck')).toHaveAttribute('aria-pressed', 'true');
	await expect(mixerSolo('Pluck')).toHaveAttribute('aria-pressed', 'true');
	await mixerSolo('Pluck').click();
	await expect(headSolo('Pluck')).toHaveAttribute('aria-pressed', 'false');
	await headSolo('Lead').click();
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	const doc = await timelineDoc(page);
	expect(doc.tracks.map((t: { mute: boolean }) => t.mute)).toEqual([false, false]);
	expect(JSON.stringify(doc)).not.toContain('solo');

	// It is heard: with Lead soloed and muted, nothing plays, and without the solo Pluck comes back. The first click above
	// started audio, and how many images the edits since made depends on how quickly they came, so this waits for the newest.
	await startAudio(page);
	await settled(page);
	await loopButton(page).click();
	await expect(loopButton(page)).toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await tab(page, 'Mixer');
	await headMute('Lead').click();
	await expect.poll(() => stripPeak(page, 'master'), { timeout: 6000 }).toBeLessThan(0.002);
	// Pluck plays, as its own scope shows, which is before its mute, and the master hears none of it
	await expect.poll(() => stripPeak(page, 'track:2'), { timeout: 8000 }).toBeGreaterThan(0.01);
	await expect.poll(() => stripPeak(page, 'master')).toBeLessThan(0.002);
	await headSolo('Lead').click();
	await expect.poll(() => stripPeak(page, 'master'), { timeout: 8000 }).toBeGreaterThan(0.01);
	await headMute('Lead').click();
});

test('Mod+C, Mod+V and Mod+D copy, paste and duplicate notes in the roll', async ({ page }) => {
	await newSong(page, 'Copied notes');
	for (const [tick, note] of [
		[0, 60],
		[480, 64]
	]) {
		const at = await rollPoint(page, tick, note);
		await page.mouse.click(at.x, at.y);
	}
	await expect(page.getByTestId('note-1')).toBeVisible();
	await watchPrevented(page);
	await page.getByTestId('roll').focus();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('ControlOrMeta+c');
	// Each paste lands straight after the last, where they came from
	await page.keyboard.press('ControlOrMeta+v');
	await page.keyboard.press('ControlOrMeta+v');
	await expect(page.getByTestId('note-5')).toBeVisible();
	// A duplicate follows the chosen notes, which are the last pasted
	await page.keyboard.press('ControlOrMeta+d');
	expect(await prevented(page)).toBe(true);
	await expect(page.getByTestId('note-7')).toBeVisible();
	await expect(page.getByTestId('note-7')).toHaveClass(/chosen/);
	// Duplicating past the end grows the clip, as a note put there does
	for (let i = 0; i < 5; ++i) await page.keyboard.press('ControlOrMeta+d');
	await expect(page.getByTestId('clip-grown')).toContainText('Clip is now 5 bars');
	const ticks = await noteTicks(page);
	expect(ticks).toHaveLength(18);
	expect(ticks.slice(0, 8)).toEqual([
		[0, 60],
		[480, 64],
		[960, 60],
		[1440, 64],
		[1920, 60],
		[2400, 64],
		[2880, 60],
		[3360, 64]
	]);

	// In another clip, a paste lands where the notes were in theirs
	const row = (await page.getByTestId('row-1').boundingBox())!;
	const bar = (await page.getByTestId('placement-1-0').locator('rect').first().boundingBox())!.width / 5;
	await page.mouse.dblclick(row.x + bar * 6.5, row.y + 20);
	await expect(page.getByRole('tab', { name: 'Notes: clip-2' })).toBeVisible();
	await page.getByTestId('roll').focus();
	await page.keyboard.press('ControlOrMeta+v');
	await expect(page.getByTestId('note-1')).toBeVisible();
	expect(await noteTicks(page, 'clip-2')).toEqual([
		[0, 60],
		[480, 64]
	]);
});

test('Mod+C, Mod+V and Mod+D copy, paste and duplicate clips in the arrangement, and a copy reaches another timeline', async ({
	page
}) => {
	await newSong(page, 'Copied clips');
	await watchPrevented(page);
	const placed = (track: number) =>
		page
			.locator(`[data-testid^="placement-${track}-"]`)
			.evaluateAll((list) => list.map((block) => Number(block.getAttribute('data-tick'))));

	await page.getByTestId('placement-1-0').locator('rect').first().click();
	await page.keyboard.press('ControlOrMeta+c');
	await page.keyboard.press('ControlOrMeta+v');
	await page.keyboard.press('ControlOrMeta+v');
	await expect(page.getByTestId('placement-1-2')).toHaveClass(/chosen/);
	await page.keyboard.press('ControlOrMeta+d');
	expect(await prevented(page)).toBe(true);
	await expect(page.getByTestId('placement-1-3')).toHaveClass(/chosen/);
	expect(await placed(1)).toEqual([0, 4 * BAR, 8 * BAR, 12 * BAR]);
	// They all play the one clip, as a copy dragged off with Mod does
	expect((await timelineDoc(page)).clips.map((c: { id: string }) => c.id)).toEqual(['clip']);

	// Not while typing in a field, which keeps its keys
	await page.getByLabel('Song name', { exact: true }).press('ControlOrMeta+d');
	expect(await prevented(page)).toBe(false);
	expect(await placed(1)).toHaveLength(4);

	// A copy from an example, read-only as it is, pastes into this timeline as a clip of its own
	const filter = browser(page).getByLabel('Filter the browser');
	await filter.fill('Arpeggio');
	await browser(page).locator('a[href*="recipe=Arpeggio"]').click();
	await page.waitForURL(/recipe=Arpeggio/);
	await page.getByTestId('placement-1-0').locator('rect').first().click();
	await page.keyboard.press('ControlOrMeta+c');
	await filter.fill('Copied clips');
	await browser(page).getByRole('link', { name: 'Copied clips' }).click();
	await expect(page.getByLabel('Song name', { exact: true })).toHaveValue('Copied clips');
	await page.getByRole('button', { name: 'Add track' }).click();
	await page.getByRole('listbox', { name: 'Patches' }).locator('[data-patch="lead"]').click();
	await expect(page.getByTestId('track-2')).toHaveAttribute('aria-pressed', 'true');
	// + Track's own clip goes, so the paste is the track's only clip.
	await page.getByTestId('placement-2-0').locator('rect').first().click({ button: 'right' });
	await page
		.getByRole('menu', { name: /^Clip / })
		.getByRole('menuitem', { name: 'Delete clip' })
		.click();
	await expect(page.getByTestId('placement-2-0')).toHaveCount(0);
	await page.keyboard.press('ControlOrMeta+v');
	await expect(page.getByTestId('placement-2-0')).toHaveAttribute('data-tick', '0'); // Where it was, on a track of its own
	const doc = await timelineDoc(page);
	expect(doc.clips.map((c: { id: string; notes: unknown[] }) => [c.id, c.notes.length])).toEqual([
		['clip', 0],
		['phrase', 32]
	]);
	expect(doc.tracks[1].placements).toEqual([{ clip: 'phrase', tick: 0, repeat: 1 }]);
});

// The keys play a track with no notes in an image of its own, whose transport runs for its LFOs. The song that takes over
// once the track has a note comes back as it was left, stopped, rather than inheriting that running transport.
test('the keys leave the song stopped when it takes over from a track heard on its own', async ({ page }) => {
	await newSong(page, 'Stays stopped');
	const state = page.getByTestId('state');
	await page.getByTestId('roll').focus();
	await page.keyboard.press('a'); // Starts audio, and plays the track on its own
	await expect(state).toHaveAttribute('data-live', 'alone', { timeout: 10000 });
	await expect(state).toHaveAttribute('data-playing', 'true');

	const at = await rollPoint(page, 0, 60);
	await page.mouse.click(at.x, at.y);
	await expect(keys(page)).toHaveAttribute('title', /^Keys play Track 1\./, { timeout: 8000 });
	await page.getByTestId('roll').focus();
	await page.keyboard.press('a'); // The song's image takes over
	await expect(state).toHaveAttribute('data-live', 'song', { timeout: 10000 });
	await expect(state).toHaveAttribute('data-playing', 'false');
	await expect(page.getByTestId('tick')).toHaveText('0');

	// Play still plays it.
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect(state).toHaveAttribute('data-playing', 'true');
});

// The roll follows the chosen track, so what it and step entry write goes where the keys play. A new track comes with a clip of its
// own, which the roll opens on, rather than editing the clip of the track chosen before. One with none says so and offers one.
test("after + Track the roll is the new track's, and its notes go into a clip of its own", async ({ page }) => {
	await newSong(page, 'Own clip');
	await page.getByRole('button', { name: 'Add track' }).click();
	await page.getByRole('combobox', { name: 'Patch for the new track' }).fill('Kick808');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('track-2')).toBeVisible();
	await expect(page.getByTestId('placement-2-0')).toHaveClass(/chosen/);
	await expect(page.getByRole('tab', { name: 'Notes: clip-2' })).toHaveAttribute('aria-selected', 'true');
	const own = (await timelineDoc(page)).tracks[1].placements[0];
	expect(own).toEqual({ clip: 'clip-2', tick: 0, repeat: 1 });
	expect((await timelineDoc(page)).clips.find((c: { id: string }) => c.id === own.clip).length).toBe(4 * BAR);

	// Step entry writes into it, and so does a click.
	await page.getByTestId('roll').focus();
	await page.keyboard.press('r');
	await page.keyboard.press('a');
	await expect(page.getByTestId('note-0')).toBeVisible();
	await page.keyboard.press('Escape');
	const at = await rollPoint(page, 1920, 64);
	await page.mouse.click(at.x, at.y);
	await expect(page.getByTestId('note-1')).toBeVisible();
	expect((await noteTicks(page, own.clip)).length).toBe(2);
	expect(await noteTicks(page)).toEqual([]);

	// A track whose clip is deleted has none, and the roll says so and offers one.
	await page.getByTestId('placement-2-0').locator('rect').first().click({ button: 'right' });
	await page
		.getByRole('menu', { name: /^Clip / })
		.getByRole('menuitem', { name: 'Delete clip' })
		.click();
	await expect(page.getByTestId('no-clip')).toHaveText(/^Track 2 has no clip yet\./);
	await page.getByTestId('no-clip').getByRole('button', { name: 'New clip' }).click();
	await expect(page.getByTestId('placement-2-0')).toHaveClass(/chosen/);

	// Choosing Track 1 again brings its own clip back into the roll.
	await page.getByTestId('track-1').click();
	await expect(page.getByRole('tab', { name: 'Notes: clip', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('note-0')).toHaveCount(0);
});
