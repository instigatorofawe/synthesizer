import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { undoButton } from './Chrome.ts';
import { settled } from './Engine.ts';
import { emptyNewSong } from './NewSong.ts';

// Musical units in the fields, velocity stems as wide as their notes, and lane points joined by lines.

// A page load waits until the page has hydrated, as AppTest.ts does: what is typed into it before then is lost.
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

test.use({ viewport: { width: 1440, height: 900 } }); // The browser and the inspector beside the page

// Leaving with unsaved edits asks first, and a test that leaves means to.
test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

const notes = (page: Page) => page.locator('[data-testid^="note-"]');

// A track playing the lead, with a one-bar clip made by a double-click, open in the roll.
async function trackWithClip(page: Page, name: string) {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByRole('button', { name: 'New song', exact: true }).click(); // Its + opens the field
	await page.getByLabel('New song name').fill(name);
	await page.getByLabel('New song name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByLabel('Song name', { exact: true })).toHaveValue(name);
	await emptyNewSong(page);
	await page.getByRole('button', { name: 'Add track' }).click();
	await page.getByRole('listbox', { name: 'Patches' }).locator('[data-patch="lead"]').click();
	const row = (await page.getByTestId('row-1').boundingBox())!;
	await page.mouse.dblclick(row.x + 10, row.y + 20);
	await expect(page.getByTestId('placement-1-0')).toBeVisible();
	await expect(page.getByTestId('roll')).toBeVisible();
}

const perTick = async (page: Page) => Number(await page.getByTestId('roll').getAttribute('data-per-tick'));

// Where a note at this tick and pitch lands in the roll, a little inside its cell.
async function rollPoint(page: Page, tick: number, note: number) {
	const box = (await page.getByTestId('roll').boundingBox())!;
	const key = (await page.getByTestId(`key-${note}`).boundingBox())!;
	return { x: box.x + tick * (await perTick(page)) + 3, y: key.y + key.height / 2 };
}

async function addNote(page: Page, tick: number, note: number) {
	const count = await notes(page).count();
	const at = await rollPoint(page, tick, note);
	await page.mouse.click(at.x, at.y);
	await expect(notes(page)).toHaveCount(count + 1);
}

async function timelineDoc(page: Page) {
	const tabs = page.getByRole('tablist', { name: 'Song views' });
	await tabs.getByRole('tab', { name: /^JSON/ }).click();
	const doc = JSON.parse(await page.getByLabel('Song JSON').inputValue());
	await tabs.getByRole('tab', { name: /^Notes/ }).click();
	return doc;
}

// Types into a field and leaves it with Enter, as someone would.
async function type(field: Locator, text: string) {
	await field.fill(text);
	await field.press('Enter');
}

// A polyline's corners, and a circle's centre, in the lane's pixels.
async function corners(curve: Locator) {
	const text = (await curve.getAttribute('points')) ?? '';
	return text.split(' ').map((pair) => pair.split(',').map(Number));
}
async function centreOf(point: Locator) {
	return [Number(await point.getAttribute('cx')), Number(await point.getAttribute('cy'))];
}

test("a note's pitch, place and length are typed as music, and what isn't one is refused", async ({ page }) => {
	await trackWithClip(page, 'Typed notes');
	await addNote(page, 0, 60);
	const pitch = page.getByLabel('Note pitch');
	const at = page.getByLabel('Note tick');
	const length = page.getByLabel('Note length');
	const note = page.getByTestId('note-0');
	await expect(pitch).toHaveValue('C4');
	await expect(at).toHaveValue('1.1.000');
	await expect(length).toHaveValue('1/4'); // The Draw length a new timeline starts with

	await type(pitch, 'E4');
	await expect(note).toHaveAttribute('data-note', '64');
	await type(pitch, 'f#4');
	await expect(note).toHaveAttribute('data-note', '66');
	await expect(pitch).toHaveValue('F#4');
	await type(pitch, '62'); // A MIDI number will do
	await expect(pitch).toHaveValue('D4');

	await type(at, '1.3');
	await expect(note).toHaveAttribute('data-tick', '960');
	await expect(at).toHaveValue('1.3.000');
	await type(length, '3/16');
	await expect(note).toHaveAttribute('data-dur', '360');
	await expect(length).toHaveValue('3/16');
	await type(length, '1/8.'); // Dotted, which is the same length, and reads as it did
	await expect(length).toHaveValue('3/16');
	await type(length, '100 ticks'); // Ticks, for a length no note value names
	await expect(note).toHaveAttribute('data-dur', '100');
	await expect(length).toHaveValue('100 ticks');

	// What isn't one says what to type, and the field goes back to what it held.
	await type(pitch, 'H4');
	await expect(page.getByText("“H4” isn't a pitch. Type a note, as E4, F#3 or Bb2")).toBeVisible();
	await expect(pitch).toHaveValue('D4');
	await expect(note).toHaveAttribute('data-note', '62');
	await type(length, 'long');
	await expect(page.getByText("“long” isn't a length.")).toBeVisible();
	await expect(length).toHaveValue('100 ticks');
	await type(at, '1.5');
	await expect(page.getByText("“1.5” isn't a position.")).toBeVisible();
	await expect(at).toHaveValue('1.3.000');

	// A bare number is a bar, as in the top bar, and a note put past the end grows the clip as a clicked one does.
	await type(at, '2');
	await expect(note).toHaveAttribute('data-tick', '1920');
	await expect(page.getByTestId('clip-grown')).toContainText('Clip is now 2 bars');
	await expect(page.getByLabel('Clip length')).toHaveValue('2 bars');
});

test('the inspector reads the clip and its placement in bars and positions', async ({ page }) => {
	await trackWithClip(page, 'Typed clips');
	const length = page.getByLabel('Clip length');
	await expect(length).toHaveValue('1 bar');
	await type(length, '2 bars');
	await expect(length).toHaveValue('2 bars');
	await type(length, '1 bar + 1/2');
	await expect(length).toHaveValue('1 bar + 1/2');
	await type(length, '3840 ticks');
	await expect(length).toHaveValue('2 bars');
	await type(length, '8'); // A bare number is bars, as the field reads, as in Live and Logic
	await expect(length).toHaveValue('8 bars');
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await type(length, '2');

	const start = page.getByLabel('Clip start');
	await expect(start).toHaveValue('1.1.000');
	await type(start, '3');
	await expect(page.getByTestId('placement-1-0')).toHaveAttribute('data-tick', '3840');
	await expect(start).toHaveValue('3.1.000');

	await type(page.getByLabel('Window start'), '1.2');
	await type(page.getByLabel('Window length'), '1/2');
	await expect(page.getByLabel('Window length')).toHaveValue('1/2');
	await type(page.getByLabel('Window start'), '3');
	await expect(page.getByText("“3” is past the clip's end, at 3.1.000.")).toBeVisible();
	await expect(page.getByLabel('Window start')).toHaveValue('1.2.000');
	await expect
		.poll(async () => (await timelineDoc(page)).tracks[0].placements[0])
		.toEqual({ clip: 'clip', tick: 3840, repeat: 1, start: 480, length: 960 });

	await page.getByRole('button', { name: 'Add play change' }).click();
	const change = page.getByLabel('Play change 1 tick');
	await expect(change).toHaveValue('1.1.000');
	await type(change, '2.1.240');
	await expect(change).toHaveValue('2.1.240');
	await expect.poll(async () => (await timelineDoc(page)).clips[0].play[0].tick).toBe(1920 + 240);
	await settled(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
});

test('a tempo change inside a bar reads as where it is', async ({ page }) => {
	await trackWithClip(page, 'Tempo inside');
	const tabs = page.getByRole('tablist', { name: 'Song views' });
	await tabs.getByRole('tab', { name: /^JSON/ }).click();
	const json = page.getByLabel('Song JSON');
	const doc = JSON.parse(await json.inputValue());
	await json.fill(
		JSON.stringify(
			{
				...doc,
				tempo: [
					{ tick: 0, bpm: 120 },
					{ tick: 3840 + 480, bpm: 90 }
				]
			},
			null,
			1
		)
	);
	await page.getByRole('region', { name: 'Song editor' }).getByText('Tempo, 120 BPM').click();
	const inspector = page.locator('#inspector');
	await expect(inspector.getByText('bar 1', { exact: true })).toBeVisible();
	await expect(inspector.getByText('3.2.000', { exact: true })).toBeVisible();
});

test('velocity stems are as wide as their notes, and a drag across them paints, undone in one step', async ({
	page
}) => {
	await trackWithClip(page, 'Painted');
	for (const tick of [0, 480, 960, 1440]) await addNote(page, tick, 60);
	await settled(page);
	for (const index of [0, 1, 2, 3]) {
		const stem = (await page.getByTestId(`velocity-${index}`).boundingBox())!;
		const body = (await page.getByTestId(`note-${index}`).locator('.body').boundingBox())!;
		expect(Math.abs(stem.x - body.x)).toBeLessThan(1.5); // The strip and the roll round their pixels apart
		expect(Math.abs(stem.width - body.width)).toBeLessThan(1.5);
	}

	// From low on the first stem to high past the last note's start: each note takes the height the drag had as it passed.
	const strip = (await page.getByTestId('velocity').boundingBox())!;
	const across = await perTick(page);
	const from = { x: strip.x + 4, y: strip.y + strip.height - 6 };
	const to = { x: strip.x + 1440 * across + 40, y: strip.y + 6 };
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 12 });
	await page.mouse.up();
	const velocities = () =>
		Promise.all([0, 1, 2, 3].map(async (i) => Number(await page.getByTestId(`note-${i}`).getAttribute('data-vel'))));
	await expect.poll(velocities).not.toEqual([100, 100, 100, 100]);
	const painted = await velocities();
	expect(painted[0]).toBeLessThan(30);
	for (let i = 1; i < 4; ++i) expect(painted[i]).toBeGreaterThan(painted[i - 1]);
	expect(painted[3]).toBeGreaterThan(90);
	await expect(page.getByTestId('velocity-2')).toHaveAttribute('data-vel', String(painted[2]));

	await undoButton(page).click();
	await expect.poll(velocities).toEqual([100, 100, 100, 100]);
});

test('points clicked into a lane are joined by lines, as drawn and as compiled, and one becomes a step', async ({
	page
}) => {
	await trackWithClip(page, 'Joined');
	await page.getByLabel('Add a lane').selectOption({ label: 'cutoff' });
	const lane = page.getByTestId('lane-0');
	const points = page.locator('[data-testid^="lane-0-point-"]');
	await expect(points).toHaveCount(1);

	const box = (await lane.boundingBox())!;
	const across = await perTick(page);
	for (const [tick, y] of [
		[480, 10],
		[960, 54],
		[1440, 32]
	]) {
		const count = await points.count();
		await page.mouse.click(box.x + tick * across, box.y + y);
		await expect(points).toHaveCount(count + 1);
	}
	for (const [index, tick] of [
		[1, '480'],
		[2, '960'],
		[3, '1440']
	]) {
		await expect(page.getByTestId(`lane-0-point-${index}`)).toHaveAttribute('data-tick', tick);
		await expect(page.getByTestId(`lane-0-point-${index}`)).toHaveAttribute('data-shape', 'line');
	}

	// Drawn: a straight line from each point to the next, and the last held to the clip's end.
	const curve = page.getByTestId('lane-0-curve');
	const dots = await Promise.all([0, 1, 2, 3].map((i) => centreOf(page.getByTestId(`lane-0-point-${i}`))));
	const drawn = await corners(curve);
	expect(drawn).toHaveLength(5);
	dots.forEach(([x, y], i) => {
		expect(drawn[i][0]).toBeCloseTo(x, 0);
		expect(drawn[i][1]).toBeCloseTo(y, 0);
	});

	// Compiled: each ramps from the point before, over the gap to it.
	await settled(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	const joined = (await timelineDoc(page)).clips[0].automation;
	expect(joined.map((p: { tick: number; ramp?: number }) => [p.tick, p.ramp])).toEqual([
		[0, undefined],
		[0, 480],
		[480, 480],
		[960, 480]
	]);

	// The middle one becomes a step: the lane holds until it and then jumps, and the line out of it stays.
	await page.getByTestId('lane-0-point-2').click({ button: 'right' });
	await page.getByRole('menu', { name: 'cutoff point' }).getByRole('menuitem', { name: 'Step' }).click();
	await expect(page.getByTestId('lane-0-point-2')).toHaveAttribute('data-shape', 'step');
	await expect(page.getByLabel('cutoff point shape')).toHaveValue('step');
	await expect(page.getByLabel('cutoff point over')).toHaveCount(0);
	await expect.poll(async () => (await corners(curve)).length).toBe(6);
	const stepped = await corners(curve);
	expect(stepped[2][0]).toBeCloseTo(dots[2][0], 0); // Held at the second point's value until the third's tick
	expect(stepped[2][1]).toBeCloseTo(dots[1][1], 0);
	expect(stepped[3][1]).toBeCloseTo(dots[2][1], 0);
	await settled(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	const doc = (await timelineDoc(page)).clips[0].automation;
	expect(doc.map((p: { tick: number; ramp?: number }) => [p.tick, p.ramp])).toEqual([
		[0, undefined],
		[0, 480],
		[960, undefined],
		[960, 480]
	]);

	// The last one's ramp, typed as a note value, is shorter than its gap, so it holds and then ramps.
	await page.getByTestId('lane-0-point-3').click();
	await type(page.getByLabel('cutoff point over'), '1/8');
	await expect(page.getByLabel('cutoff point over')).toHaveValue('1/8');
	await expect(page.getByTestId('lane-0-point-3')).toHaveAttribute('data-tick', '1440');
	await expect
		.poll(async () => (await timelineDoc(page)).clips[0].automation[3])
		.toMatchObject({ tick: 1200, ramp: 240 });
});
