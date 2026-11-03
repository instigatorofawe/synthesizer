import { expect, test as base, type Page } from '@playwright/test';
import { fromSongMenu, loopButton, openLight, startAudio, undoButton } from './Chrome.ts';
import { openView } from './Views.ts';

// A page load waits until the page has hydrated, as in AppTest.
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

// The browser sits beside the page at this width, which the menu's test uses to make and find timelines.
test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });
const timelineEditor = (page: Page) => page.getByRole('region', { name: 'Song editor' });
const patchEditor = (page: Page) => page.getByRole('region', { name: 'Patch editor' });
const light = (page: Page) => page.getByTestId('status').getByRole('button', { name: /^Compile status/ });
const settled = (page: Page) =>
	expect(page.getByTestId('status')).toHaveAttribute('aria-busy', 'false', { timeout: 10000 });

async function tab(page: Page, name: 'Notes' | 'JSON') {
	await page
		.getByRole('tablist', { name: 'Song views' })
		.getByRole('tab', { name: new RegExp(`^${name}`) })
		.click();
}

// Changes the open timeline's JSON, as parsed.
async function editTimeline(page: Page, change: (doc: Record<string, unknown>) => void) {
	await tab(page, 'JSON');
	const json = page.getByLabel('Song JSON');
	const doc = JSON.parse(await json.inputValue());
	change(doc);
	await json.fill(JSON.stringify(doc, null, 1));
	await json.blur();
}

const timelineDoc = async (page: Page) => {
	await tab(page, 'JSON');
	const doc = JSON.parse(await page.getByLabel('Song JSON').inputValue());
	await tab(page, 'Notes');
	return doc;
};

type Doc = { tracks: { id: number; gain?: number }[]; master: { gain: number } };

test('the compile light says what is wrong, and each problem goes where it is', async ({ page }) => {
	await page.goto('/?timeline=song');
	await settled(page);
	await expect(light(page)).toHaveText(/\d KB/);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	// The editors' own Undo and Redo are gone, for the top bar's
	await expect(timelineEditor(page).getByRole('button', { name: 'Undo' })).toHaveCount(0);
	await expect(patchEditor(page).getByRole('button', { name: 'Undo', includeHidden: true })).toHaveCount(0);

	// A wire into an input the filter doesn't have
	await openView(page, 'patch');
	await page.getByRole('tablist', { name: 'Side column' }).getByRole('tab', { name: 'JSON' }).click();
	const graph = page.getByLabel('Graph JSON');
	const parsed = JSON.parse(await graph.inputValue()) as { edges: { from: number; to: number; input: string }[] };
	parsed.edges.find((edge) => edge.to === 13 && edge.input === 'cutoff')!.input = 'nope';
	await graph.fill(JSON.stringify(parsed, null, 1));
	await graph.blur();
	await expect(light(page)).toHaveText('1 problem');
	await openView(page, 'song');

	let list = await openLight(page);
	const problem = list.getByTestId('compile-error');
	await expect(problem).toContainText("no input 'nope'");
	await expect(problem).toContainText('Stereo lead › Filter 13');
	await problem.getByRole('button', { name: 'Stereo lead › Filter 13' }).click();
	await expect(page.getByTestId('view-patch')).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('node-13')).toHaveClass(/chosen/);
	await expect(page.getByTestId('node-error')).toContainText("no input 'nope'");
	await expect(list).toBeHidden();

	await undoButton(page).click();
	await settled(page);
	await expect(light(page)).toHaveText(/\d KB/);

	// A note in Pluck's clip that starts where the clip ends
	await openView(page, 'song');
	await editTimeline(page, (doc) => {
		const clip = (doc as { clips: { id: string; notes: object[] }[] }).clips.find((c) => c.id === 'pluck-a')!;
		clip.notes.push({ tick: 1920, note: 60, vel: 100, dur: 240 });
	});
	await expect(light(page)).toHaveText('1 problem');
	await tab(page, 'Notes');
	await page.getByTestId('placement-1-0').locator('rect').first().click();
	await expect(page.getByTestId('track-1')).toHaveAttribute('aria-pressed', 'true');
	await openView(page, 'patch');

	list = await openLight(page);
	await expect(list.getByTestId('compile-error')).toContainText('a note starts after the clip ends');
	await list.getByRole('button', { name: /^Pluck › pluck-a/ }).click();
	await expect(page.getByTestId('view-song')).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('track-2')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('tablist', { name: 'Song views' }).getByRole('tab', { name: /^Notes/ })).toHaveText(
		'Notes: pluck-a'
	);

	// Esc shuts the list, and the light keeps focus
	await openLight(page);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('region', { name: 'Compile status' })).toBeHidden();
	await expect(light(page)).toBeFocused();
});

test("the Song tab's menu holds what is done to the song as a whole", async ({ page }) => {
	await page.goto('/?timeline=ballad');
	await settled(page); // So Export WAV can be chosen, and the keys below land where they should
	const opener = page.getByRole('button', { name: 'Song menu' });
	await opener.click();
	const menu = page.getByRole('menu', { name: 'Song' });
	await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'Export WAV', 'Export saved version', 'Delete song']);
	await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
	await expect(opener).toBeFocused();

	// Rename goes to the name, from the Patch view too
	await openView(page, 'patch');
	await fromSongMenu(page, 'Rename');
	await expect(page.getByTestId('view-song')).toHaveAttribute('aria-selected', 'true');
	const name = page.getByLabel('Song name', { exact: true });
	await expect(name).toBeFocused();
	await page.keyboard.type('Ballad, renamed');
	await expect(name).toHaveValue('Ballad, renamed');
	await expect(page.getByTestId('view-song')).toContainText('Ballad, renamed');

	// The keys work it, and a second press on the ▾ shuts it
	await opener.click();
	await expect(menu).toBeVisible();
	await opener.click();
	await expect(menu).toHaveCount(0);
	const download = page.waitForEvent('download');
	await opener.focus();
	await page.keyboard.press('Enter');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await expect(menu.getByRole('menuitem', { name: 'Export saved version' })).toBeFocused();
	await page.keyboard.press('Enter');
	expect((await download).suggestedFilename()).toBe('Ballad.msimg');

	// Delete timeline, on one made for it
	await page.getByRole('button', { name: 'New song', exact: true }).click(); // Its + opens the field
	await page.getByLabel('New song name').fill('Short lived');
	await page.getByLabel('New song name').press('Enter');
	await expect(page.getByLabel('Song name', { exact: true })).toHaveValue('Short lived');
	await expect(browser(page).getByRole('link', { name: 'Short lived' })).toBeVisible();
	await fromSongMenu(page, 'Delete song');
	await expect(browser(page).getByRole('link', { name: 'Short lived' })).toHaveCount(0);

	// An example has no timeline to rename or delete, and goes to the library from here
	await page.goto('/?recipe=Kick808');
	await opener.click();
	await expect(menu.getByRole('menuitem')).toHaveText(['Add to library', 'Export WAV']);
});

const brace = (page: Page) => page.getByTestId('loop-brace');

// Drags along the loop strip from one place to another, each in bars from its left end, where bars are 96 pixels.
async function alongStrip(page: Page, from: number, to: number) {
	const strip = (await page.getByTestId('loop-strip').boundingBox())!;
	const y = strip.y + strip.height / 2;
	await page.mouse.move(strip.x + from * 96, y);
	await page.mouse.down();
	await page.mouse.move(strip.x + to * 96, y, { steps: 6 });
	await page.mouse.up();
}

async function onStrip(page: Page, at: number) {
	const strip = (await page.getByTestId('loop-strip').boundingBox())!;
	await page.mouse.click(strip.x + at * 96, strip.y + strip.height / 2);
}

const loopAt = async (page: Page) => [
	Number(await brace(page).getAttribute('data-start')),
	Number(await brace(page).getAttribute('data-end'))
];

test("the loop is a button in the top bar, a strip under the ruler, and a clip's", async ({ page }) => {
	await page.goto('/?timeline=song');
	// Until one is drawn the loop is the whole song, shown dimmed while it's off
	await expect(loopButton(page)).toHaveAttribute('aria-pressed', 'false');
	await expect(brace(page)).toHaveAttribute('data-on', 'false');
	await expect(brace(page)).toHaveClass(/off/);
	expect(await loopAt(page)).toEqual([0, 7680]);

	await loopButton(page).click();
	await expect(loopButton(page)).toHaveAttribute('aria-pressed', 'true');
	await expect(brace(page)).toHaveAttribute('data-on', 'true');
	await expect(brace(page)).not.toHaveClass(/off/);

	// A click on the strip turns it off and on again
	await onStrip(page, 2.5);
	await expect(loopButton(page)).toHaveAttribute('aria-pressed', 'false');
	await onStrip(page, 6);
	await expect(loopButton(page)).toHaveAttribute('aria-pressed', 'true');

	// A drag draws one, on
	await loopButton(page).click();
	await alongStrip(page, 1, 2);
	await expect(loopButton(page)).toHaveAttribute('aria-pressed', 'true');
	expect(await loopAt(page)).toEqual([1920, 3840]);
	// A drag on it moves it, and on its end stretches it
	await alongStrip(page, 1.5, 2.5);
	expect(await loopAt(page)).toEqual([3840, 5760]);
	await alongStrip(page, 3, 4);
	expect(await loopAt(page)).toEqual([3840, 7680]);
	// Turned off, it stays where it was
	await loopButton(page).click();
	await expect(brace(page)).toHaveAttribute('data-on', 'false');
	expect(await loopAt(page)).toEqual([3840, 7680]);

	// Loop this clip: the placement and its repeats, on, with the playhead in it
	await page.getByTestId('placement-2-0').locator('rect').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Loop this clip' }).click();
	await expect(loopButton(page)).toHaveAttribute('aria-pressed', 'true');
	expect(await loopAt(page)).toEqual([0, 7680]);
	await expect(page.getByTestId('tick')).toHaveText('0');

	// It is the editor's, not the song's
	expect(JSON.stringify(await timelineDoc(page))).not.toMatch(/loop/i);
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
});

test('typing a position moves the playhead, and typing a tempo changes the one playing there', async ({ page }) => {
	await page.goto('/?timeline=song');
	const position = page.getByLabel('Position', { exact: true });
	const tempo = page.getByTestId('tempo');
	await expect(position).toHaveValue('1.1.000');
	await expect(tempo).toHaveValue('140');

	await position.fill('3.1.000');
	await position.press('Enter');
	await expect(page.getByTestId('tick')).toHaveText('3840', { timeout: 10000 });
	await expect(position).toHaveValue('3.1.000');
	await expect(page.getByTestId('playhead')).toHaveAttribute('x1', '192'); // Bars are 96 pixels
	await position.fill('2.3');
	await position.press('Enter');
	await expect(page.getByTestId('tick')).toHaveText('2880');
	// What isn't a position says so, and changes nothing
	await position.fill('nine');
	await position.press('Enter');
	await expect(page.getByText("isn't a position")).toBeVisible();
	await expect(position).toHaveValue('2.3.000');
	// Esc puts it back
	await position.fill('7');
	await position.press('Escape');
	await expect(position).toHaveValue('2.3.000');
	await expect(page.getByTestId('tick')).toHaveText('2880');

	// One tempo for the whole song
	await tempo.fill('120');
	await tempo.press('Enter');
	await expect(tempo).toHaveValue('120');
	expect((await timelineDoc(page)).tempo).toEqual([{ tick: 0, bpm: 120 }]);
	await undoButton(page).click();
	await expect(tempo).toHaveValue('140');

	// A second, from bar 3: each part of the song reads, and is typed into, as its own
	await position.fill('3');
	await position.press('Enter');
	await expect(page.getByTestId('tick')).toHaveText('3840');
	await timelineEditor(page).getByText('Tempo, 140 BPM').click();
	await timelineEditor(page).getByRole('button', { name: 'Add a change at the playhead' }).click();
	await tempo.fill('90');
	await tempo.press('Enter');
	expect((await timelineDoc(page)).tempo).toEqual([
		{ tick: 0, bpm: 140 },
		{ tick: 3840, bpm: 90 }
	]);
	await expect(page.locator('label.tempo')).toHaveAttribute('title', /from bar 3, one of the song's 2 tempos/);
	await position.fill('1');
	await position.press('Enter');
	await expect(tempo).toHaveValue('140');

	// A glide reads how far it has got, and typing into it sets where it starts
	await page.getByLabel('Glide from bar 1').check();
	await position.fill('2');
	await position.press('Enter');
	await expect(tempo).toHaveValue('115');
	await expect(page.locator('label.tempo')).toHaveAttribute('title', /Gliding from 140 BPM at bar 1 to 90 at bar 3/);
	await tempo.focus();
	await expect(tempo).toHaveValue('140');
	await tempo.press('Escape');
	await expect(tempo).toHaveValue('115');

	// Neither can be typed into on an example
	await page.goto('/?recipe=Kick808');
	await expect(position).not.toBeEditable();
	await expect(tempo).not.toBeEditable();
});

test('the master meter lights while the limiter turns the song down', async ({ page }) => {
	await page.goto('/?timeline=song');
	await expect(page.getByTestId('limiting')).toHaveCount(0);
	// Everything as loud as it goes, sixteen times louder than it was
	await editTimeline(page, (doc) => {
		const song = doc as Doc;
		song.master.gain = 4;
		for (const track of song.tracks) track.gain = 4;
	});
	await settled(page);
	await startAudio(page);
	await expect(page.getByTestId('generation')).not.toHaveText('0', { timeout: 10000 });
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	const limiting = page.getByTestId('limiting');
	await expect(limiting).toBeVisible({ timeout: 8000 });
	await expect(limiting).toHaveAttribute('title', /turned the song down by as much as \d+\.\d dB/);
});
