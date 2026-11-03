import { expect, test as base, type Page } from '@playwright/test';

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

// Leaving with unsaved edits asks first, and a test that leaves means to.
test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

const BAR = 1920; // Ticks in a bar at a new timeline's 480 ppq
const notes = (page: Page) => page.locator('[data-testid^="note-"]');

async function newTrack(page: Page, name: string) {
	await page.setViewportSize({ width: 1440, height: 1500 });
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByLabel('New timeline name').fill(name);
	await page.getByLabel('New timeline name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByLabel('Timeline name', { exact: true })).toHaveValue(name);
	await page.getByRole('button', { name: 'Add track' }).click(); // It asks which patch the track plays
	await page.getByRole('listbox', { name: 'Patches' }).locator('[data-patch="lead"]').click();
}

// A track with a one-bar clip, made by a double-click, open in the roll.
async function trackWithClip(page: Page, name: string) {
	await newTrack(page, name);
	const row = (await page.getByTestId('row-1').boundingBox())!;
	await page.mouse.dblclick(row.x + 10, row.y + 20);
	await expect(page.getByTestId('placement-1-0')).toBeVisible();
	await expect(page.getByTestId('roll')).toBeVisible();
}

// Where a note at this tick and pitch lands in the roll, a little inside its cell.
async function rollPoint(page: Page, tick: number, note: number) {
	const roll = page.getByTestId('roll');
	const box = (await roll.boundingBox())!;
	const key = (await page.getByTestId(`key-${note}`).boundingBox())!;
	return { x: box.x + tick * Number(await roll.getAttribute('data-per-tick')) + 3, y: key.y + key.height / 2 };
}

async function press(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 3 });
	await page.mouse.move(to.x, to.y, { steps: 3 });
	await page.mouse.up();
}

async function centre(page: Page, id: string) {
	const box = (await page.getByTestId(id).locator('rect').first().boundingBox())!;
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('a click adds a note as long as the Draw length, and the ghost says what it would add', async ({ page }) => {
	await trackWithClip(page, 'Clicked');
	const draw = page.getByLabel('Draw length');
	await draw.selectOption({ label: '1/8' });

	const at = await rollPoint(page, 1440, 64);
	await page.mouse.move(at.x, at.y);
	await expect(page.getByTestId('ghost')).toHaveText('E4 · 1/8 · 1.4.000');
	await page.mouse.click(at.x, at.y);
	await expect(notes(page)).toHaveCount(1);
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-tick', '1440');
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-note', '64');
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-dur', '240');
	await expect(page.getByTestId('clip-grown')).toHaveCount(0); // A note inside the clip leaves its length alone

	// [ and ] step it, by where the keys are, and choosing a note brings its length back.
	await page.keyboard.press(']');
	await expect(draw).toHaveValue('480');
	await page.keyboard.press('[');
	await page.keyboard.press('[');
	await expect(draw).toHaveValue('120');
	const next = await rollPoint(page, 0, 60);
	await page.mouse.click(next.x, next.y);
	await expect(page.getByTestId('note-1')).toHaveAttribute('data-dur', '120');
	const first = await centre(page, 'note-0');
	await page.mouse.click(first.x, first.y);
	await expect(draw).toHaveValue('240');
	await expect(notes(page)).toHaveCount(2);

	// A field keeps them.
	await page.getByLabel('Note velocity').focus();
	await page.keyboard.press(']');
	await expect(draw).toHaveValue('240');
});

test('dragging before letting go sets a new note to a length in Snap steps', async ({ page }) => {
	await trackWithClip(page, 'Drawn notes');
	await page.getByLabel('Snap', { exact: true }).selectOption({ label: '1/8' });
	await press(page, await rollPoint(page, 0, 60), await rollPoint(page, 600, 60));
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-dur', '720'); // To the end of the 1/8 the pointer is in
	await expect(page.getByLabel('Draw length')).toHaveValue('720'); // A dotted 1/4, which the Draw length takes on
	await expect(page.getByLabel('Draw length').locator('option:checked')).toHaveText('3/8');
});

// A click that adds a note chooses it, and the roll's toolbar then shows the note's fields in place of the hint. If that
// changed the toolbar's height, the roll would move under the pointer, and a double-click's second click would add a
// second note on another row. CI's fonts wrapped the hint where a Mac's didn't, so a narrow window checks that here.
for (const width of [1280, 700]) {
	test(`choosing a note leaves the roll where it was, and a double-click adds one note, at ${width} px`, async ({
		page
	}) => {
		await trackWithClip(page, 'Still'); // At its own size
		await page.setViewportSize({ width, height: 720 });
		await page.getByTestId('key-62').scrollIntoViewIfNeeded();
		const roll = page.getByTestId('roll');
		const before = (await roll.boundingBox())!.y;
		const at = await rollPoint(page, 480, 60);
		await page.mouse.click(at.x, at.y);
		await expect(notes(page)).toHaveCount(1);
		expect((await roll.boundingBox())!.y).toBe(before);
		const next = await rollPoint(page, 0, 64);
		await page.mouse.dblclick(next.x, next.y);
		await expect(notes(page)).toHaveCount(2);
		await expect(page.locator('[data-testid^="note-"][data-note="64"]')).toHaveCount(1);
		expect((await roll.boundingBox())!.y).toBe(before);
	});
}

test('a right-click on a note opens its menu, which deletes and duplicates, and a double-click never deletes', async ({
	page
}) => {
	await trackWithClip(page, 'Menus');
	const at = await rollPoint(page, 480, 60);
	await page.mouse.click(at.x, at.y);
	await page.mouse.dblclick(at.x, at.y);
	await expect(notes(page)).toHaveCount(1);

	const menu = page.getByRole('menu', { name: 'Note' });
	await page.mouse.click(at.x, at.y, { button: 'right' });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole('menuitem')).toHaveText(['Delete', 'Duplicate']);
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
	await expect(notes(page)).toHaveCount(1);

	// The arrows and Enter work in it.
	await page.mouse.click(at.x, at.y, { button: 'right' });
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(notes(page)).toHaveCount(2);
	await expect(page.getByTestId('note-1')).toHaveAttribute('data-tick', '960');

	await page.mouse.click(at.x, at.y, { button: 'right' });
	await menu.getByRole('menuitem', { name: 'Delete' }).click();
	await expect(notes(page)).toHaveCount(1);
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-tick', '960');
	await expect(page.getByTestId('placement-1-0')).toBeVisible(); // Delete in the menu is about the note
});

test('a note past the end grows the clip to the bar that holds it, and Undo takes both back', async ({ page }) => {
	await trackWithClip(page, 'Grown');
	await expect(page.getByLabel('Clip length')).toHaveValue(String(BAR));
	const at = await rollPoint(page, BAR + 480, 62);
	await page.mouse.move(at.x, at.y);
	await expect(page.getByTestId('ghost')).toHaveText('D4 · 1/4 · 2.2.000 · makes the clip 2 bars');
	await page.mouse.click(at.x, at.y);
	await expect(page.getByTestId('clip-grown')).toContainText('Clip is now 2 bars');
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-tick', String(BAR + 480));
	await expect(page.getByLabel('Clip length')).toHaveValue(String(2 * BAR));

	await page.getByTestId('clip-grown').getByRole('button', { name: 'Undo' }).click();
	await expect(notes(page)).toHaveCount(0);
	await expect(page.getByLabel('Clip length')).toHaveValue(String(BAR));
	await expect(page.getByTestId('clip-grown')).toHaveCount(0);
});

test('a clip that would grow into the next placement offers to lengthen instead, and does only if asked', async ({
	page
}) => {
	await trackWithClip(page, 'Not grown');
	await page.getByTestId('placement-1-0').locator('rect').first().click({ button: 'right' });
	await page.getByRole('menu', { name: 'Clip clip' }).getByRole('menuitem', { name: 'Duplicate after' }).click();
	await expect(page.getByTestId('placement-1-1')).toHaveAttribute('data-tick', String(BAR));

	const at = await rollPoint(page, BAR + 480, 62);
	await page.mouse.click(at.x, at.y);
	const offer = page.getByTestId('lengthen-offer');
	await expect(offer).toContainText('would run it into the next clip');
	await expect(notes(page)).toHaveCount(0);
	await expect(page.getByLabel('Clip length')).toHaveValue(String(BAR));

	await offer.getByRole('button', { name: 'Lengthen to 2 bars' }).click();
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-tick', String(BAR + 480));
	await expect(page.getByLabel('Clip length')).toHaveValue(String(2 * BAR));
	await expect(page.getByTestId('compile-error')).toContainText('clips overlap');
});

test('dragging across an empty row draws a clip of whole bars, and a double-click still makes one bar', async ({
	page
}) => {
	await newTrack(page, 'Drawn clips');
	const row = (await page.getByTestId('row-1').boundingBox())!;
	const barPixels = 96;
	await press(page, { x: row.x + 10, y: row.y + 20 }, { x: row.x + barPixels * 2 + 40, y: row.y + 20 });
	await expect(page.getByTestId('placement-1-0')).toHaveAttribute('data-tick', '0');
	await expect(page.getByLabel('Clip length')).toHaveValue(String(3 * BAR));
	await expect(page.getByTestId('roll')).toBeVisible();

	await page.mouse.dblclick(row.x + barPixels * 5 + 10, row.y + 20);
	await expect(page.getByTestId('placement-1-1')).toBeVisible();
	await expect(page.getByLabel('Clip length')).toHaveValue(String(BAR));
});

test('Mod-drag copies a placement, and its menu makes it unique and takes it away', async ({ page }) => {
	await trackWithClip(page, 'Copied');
	const body = await centre(page, 'placement-1-0');
	await page.keyboard.down('ControlOrMeta');
	await press(page, body, { x: body.x + 96 * 2, y: body.y });
	await page.keyboard.up('ControlOrMeta');
	await expect(page.getByTestId('placement-1-0')).toHaveAttribute('data-tick', '0');
	await expect(page.getByTestId('placement-1-1')).toHaveAttribute('data-tick', String(2 * BAR));
	await expect(page.getByTestId('clip-uses')).toContainText('Placed 2 times');

	const menu = page.getByRole('menu', { name: /^Clip / });
	await page.getByTestId('placement-1-1').locator('rect').first().click({ button: 'right' });
	await expect(menu.getByRole('menuitem')).toHaveText([
		'Open notes',
		'Duplicate after',
		'Make unique',
		'Remove from track',
		'Delete clip'
	]);
	await menu.getByRole('menuitem', { name: 'Make unique' }).click();
	await expect(page.getByLabel('Clip name')).toHaveValue('clip-2');
	await expect(page.getByTestId('clip-uses')).toHaveCount(0);

	await page.getByTestId('placement-1-1').locator('rect').first().click({ button: 'right' });
	await expect(menu.getByRole('menuitem', { name: 'Make unique' })).toBeDisabled();
	await menu.getByRole('menuitem', { name: 'Remove from track' }).click();
	await expect(page.getByTestId('placement-1-1')).toHaveCount(0);
	await expect(page.getByTestId('placement-1-0')).toBeVisible();
});

test('a click on a lane adds a point, and Delete or its menu removes one, but a double-click never does', async ({
	page
}) => {
	await trackWithClip(page, 'Points');
	await page.getByLabel('Add a lane').selectOption({ label: 'cutoff' });
	const points = page.locator('[data-testid^="lane-0-point-"]');
	await expect(points).toHaveCount(1);

	const lane = (await page.getByTestId('lane-0').boundingBox())!;
	await page.mouse.click(lane.x + 96, lane.y + 10);
	await expect(points).toHaveCount(2);
	const point = (await page.getByTestId('lane-0-point-1').boundingBox())!;
	await page.mouse.dblclick(point.x + 5, point.y + 5);
	await expect(points).toHaveCount(2);
	await page.keyboard.press('Delete');
	await expect(points).toHaveCount(1);
	await expect(page.getByTestId('placement-1-0')).toBeVisible(); // Delete in a lane is about its points

	await page.mouse.dblclick(lane.x + 192, lane.y + 30);
	await expect(points).toHaveCount(2);
	const added = (await page.getByTestId('lane-0-point-1').boundingBox())!;
	await page.mouse.click(added.x + 5, added.y + 5, { button: 'right' });
	await page.getByRole('menu', { name: 'cutoff point' }).getByRole('menuitem', { name: 'Delete' }).click();
	await expect(points).toHaveCount(1);
});
