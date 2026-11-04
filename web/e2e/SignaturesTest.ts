import { expect, test, type Page } from './Fixtures.ts';
import { clickStill, rollPoint } from './Pointer.ts';

// The inspector is open beside the arrangement at this width.
test.use({ viewport: { width: 1440, height: 900 } });

const BAR = 96; // Pixels a bar of 4/4 is at the arrangement's first zoom
const mark = (page: Page, tick: number) => page.getByTestId(`signature-${tick}`);
const inspector = (page: Page) => page.locator('#inspector');
const position = (page: Page) => page.getByTestId('position');

async function tab(page: Page, name: 'Notes' | 'JSON') {
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

// New timeline makes the template: Track 1 with an empty four-bar clip, open in the roll.
async function newSong(page: Page, name: string) {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByRole('button', { name: 'New song', exact: true }).click();
	await page.getByLabel('New song name').fill(name);
	await page.getByLabel('New song name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByTestId('roll')).toBeVisible();
}

// A right-click on the Time & key lane, `bars` bars of 4/4 in, and a little past the line.
async function laneMenu(page: Page, bars: number) {
	const lane = (await page.getByTestId('signature-lane').boundingBox())!;
	await page.mouse.click(lane.x + bars * BAR + 6, lane.y + lane.height / 2, { button: 'right' });
	return page.getByRole('menu', { name: /^Time & key/ });
}

async function goTo(page: Page, text: string) {
	await position(page).fill(text);
	await position(page).press('Enter');
}

test('an example in 3/8 after a pickup counts its bars as its score does, and says so', async ({ page }) => {
	await page.goto('/?recipe=FurElise');
	await expect(mark(page, 0)).toHaveAttribute('aria-label', 'Time & key at bar 0: 3/8 · A minor');
	// The song starts on the pickup's eighth, the last of bar 0, and bar 1 starts after it. A click on the ruler goes to the bar
	// line nearest it, which in 3/8 after the pickup is bar 2's, at tick 960.
	await expect(position(page)).toHaveValue('0.3.000');
	const ruler = (await page.getByTestId('ruler').boundingBox())!;
	await page.mouse.click(ruler.x + (1000 / 1920) * BAR, ruler.y + ruler.height / 2);
	await expect(position(page)).toHaveValue('2.1.000');

	await expect(inspector(page).getByText('Time signature, 3/8')).toBeVisible();
	await expect(inspector(page).getByText('Key, A minor')).toBeVisible();
	await inspector(page).getByText('Time signature, 3/8').click();
	await expect(inspector(page).getByLabel('Pickup')).toHaveValue('1/8');
	await expect(inspector(page).getByLabel('Beats at bar 0')).toBeDisabled();

	// An example can't change, so its lane's menu says why, with what would change it greyed.
	const menu = await laneMenu(page, 4);
	await expect(menu.getByRole('menuitem', { name: /^Time signature from bar/ })).toBeDisabled();
	await expect(menu).toContainText('example');
});

test('a time signature and a key, added from the lane, are changed in the inspector and taken away again', async ({
	page
}) => {
	await newSong(page, 'Waltz');
	await expect(mark(page, 0)).toHaveAttribute('aria-label', 'Time & key at bar 1: 4/4 · C major');

	// The lane's menu adds a change at the bar, as what plays there, and the inspector's field for it takes the keys.
	await (await laneMenu(page, 2)).getByRole('menuitem', { name: 'Time signature from bar 3…' }).click();
	const beats = inspector(page).getByLabel('Beats at bar 3');
	await expect(beats).toBeFocused();
	await beats.fill('3');
	await beats.press('Enter');
	await expect(mark(page, 3840)).toHaveAttribute('aria-label', 'Time & key at bar 3: 3/4');
	await goTo(page, '4');
	await expect(position(page)).toHaveValue('4.1.000');
	expect((await timelineDoc(page)).meter).toEqual([
		{ tick: 0, beats: 4, unit: 4 },
		{ tick: 3840, beats: 3, unit: 4 }
	]);

	// The mark's own menu adds a key where it is.
	await mark(page, 3840).click({ button: 'right' });
	await page
		.getByRole('menu', { name: 'Time & key at bar 3' })
		.getByRole('menuitem', { name: 'Key from here…' })
		.click();
	const key = inspector(page).getByLabel('Key at bar 3', { exact: true });
	await expect(key).toBeFocused();
	await key.selectOption({ label: 'E♭ major, 3♭' });
	await expect(mark(page, 3840)).toHaveAttribute('aria-label', 'Time & key at bar 3: 3/4 · E♭ major');

	// A click on the first mark opens its time signature in the inspector.
	await mark(page, 0).click();
	await expect(inspector(page).getByLabel('Beats at bar 1')).toBeFocused();

	await mark(page, 3840).click({ button: 'right' });
	await page
		.getByRole('menu', { name: 'Time & key at bar 3' })
		.getByRole('menuitem', { name: 'Remove the time signature change' })
		.click();
	await expect(mark(page, 3840)).toHaveAttribute('aria-label', 'Time & key at bar 3: E♭ major');
	await inspector(page).getByRole('button', { name: 'Remove key at bar 3' }).click();
	await expect(mark(page, 3840)).toHaveCount(0);
	expect(await timelineDoc(page)).not.toHaveProperty('meter');
});

test('Split here cuts a clip in two at the pointer, each its own clip, and Mod+E splits at the playhead', async ({
	page
}) => {
	await newSong(page, 'Cut');
	await clickStill(page, await rollPoint(page, 0, 60));
	await expect(page.getByTestId('note-0')).toBeVisible();
	await clickStill(page, await rollPoint(page, 2 * 1920 + 480, 64));
	await expect(page.getByTestId('note-1')).toBeVisible();

	const clip = (await page.getByTestId('placement-1-0').locator('rect').first().boundingBox())!;
	await page.mouse.click(clip.x + 2 * BAR + 6, clip.y + clip.height / 2, { button: 'right' });
	await page
		.getByRole('menu', { name: /^Clip / })
		.getByRole('menuitem', { name: 'Split here, at 3.1.000' })
		.click();
	await expect(page.getByTestId('placement-1-1')).toHaveAttribute('data-tick', '3840');
	// The second part is chosen and open in the roll, with its note at its start.
	await expect(page.getByLabel('Clip name')).toHaveValue('clip-2');
	let doc = await timelineDoc(page);
	expect(
		doc.clips.map((c: { id: string; length: number; notes: { tick: number }[] }) => [
			c.id,
			c.length,
			c.notes.map((n) => n.tick)
		])
	).toEqual([
		['clip', 3840, [0]],
		['clip-2', 3840, [480]]
	]);

	// Mod+E splits the chosen clip at the playhead.
	await goTo(page, '4');
	await page.getByTestId('placement-1-1').locator('rect').first().click();
	await page.keyboard.press('ControlOrMeta+e');
	await expect(page.getByTestId('placement-1-2')).toHaveAttribute('data-tick', '5760');
	doc = await timelineDoc(page);
	expect(doc.tracks[0].placements.map((p: { clip: string; tick: number }) => [p.clip, p.tick])).toEqual([
		['clip', 0],
		['clip-2', 3840],
		['clip-3', 5760]
	]);
});
