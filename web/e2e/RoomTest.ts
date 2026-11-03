import { expect, test as base, type Page } from '@playwright/test';

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

// A 1280 by 800 laptop, the smallest screen the editor is laid out for, and the one with least room for notes.
test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

const arrangement = (page: Page) => page.getByTestId('arrangement-view');
const expand = (page: Page) => page.getByRole('button', { name: 'Expand' });
const inspector = (page: Page) => page.getByRole('button', { name: 'Inspector' });
const notesTab = (page: Page) => page.getByRole('tablist', { name: 'Song views' }).getByRole('tab', { name: /^Notes/ });

// How the roll's scroller shows the clip: its height, its scroll, and the roll's own size and zoom.
const roll = (page: Page) =>
	page.getByTestId('roll').evaluate((roll) => {
		const scroller = roll.closest('.roll')!;
		return {
			height: scroller.clientHeight,
			left: scroller.scrollLeft,
			top: scroller.scrollTop,
			perTick: Number(roll.getAttribute('data-per-tick')),
			row: Number(roll.getAttribute('data-row-height'))
		};
	});

const box = async (page: Page, id: string) => (await page.getByTestId(id).boundingBox())!;

async function overRoll(page: Page) {
	const at = await box(page, 'roll');
	const view = (await page
		.getByTestId('roll')
		.evaluate((r) => r.closest('.roll')!.getBoundingClientRect().toJSON())) as {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	const point = { x: view.x + view.width / 2, y: view.y + view.height / 2 };
	await page.mouse.move(point.x, point.y);
	return { point, roll: at };
}

async function wheel(page: Page, keys: string[], dx: number, dy: number) {
	for (const key of keys) await page.keyboard.down(key);
	await page.mouse.wheel(dx, dy);
	for (const key of keys.reverse()) await page.keyboard.up(key);
}

test('the arrangement is as tall as its tracks, up to a limit, and the notes have the rest', async ({ page }) => {
	await page.goto('/?timeline=song');
	await expect(page.getByRole('separator', { name: 'Resize the arrangement' })).toHaveCount(0);
	const tracks = await box(page, 'arrangement');
	const shown = (await arrangement(page).boundingBox())!;
	expect(shown.height - tracks.height).toBeGreaterThanOrEqual(0); // Its border, and a scrollbar if the system draws one
	expect(shown.height - tracks.height).toBeLessThan(20);
	await expect.poll(async () => (await roll(page)).height).toBeGreaterThan(270); // Once the track is known to sound

	// Past four tracks or so it scrolls, and the notes keep their room.
	for (let added = 0; added < 5; ++added) {
		await page.getByRole('button', { name: 'Add track' }).click();
		await page.getByRole('listbox', { name: 'Patches' }).locator('[data-patch="lead"]').click();
	}
	await expect(page.getByTestId('track-7')).toBeAttached();
	const crowded = await arrangement(page).evaluate((view) => ({
		height: view.clientHeight,
		scrolls: view.scrollHeight > view.clientHeight
	}));
	expect(crowded.height).toBeLessThanOrEqual(800 * 0.35);
	expect(crowded.scrolls).toBe(true);
	// The roll follows the chosen track, and the new ones have no clip yet, so Track 1 is chosen again to bring its notes back.
	await arrangement(page).evaluate((view) => (view.scrollTop = 0));
	await page.getByTestId('track-1').click();
	await expect.poll(async () => (await roll(page)).height).toBeGreaterThan(120);
});

test('Expand gives the notes the whole view, by ⤢ and by a double-click on a clip, and ⤢ or Esc comes back', async ({
	page
}) => {
	await page.goto('/?timeline=song');
	await expect.poll(async () => (await roll(page)).height).toBeGreaterThan(270); // Once the track is known to sound
	const before = (await roll(page)).height;
	await expect(expand(page)).toHaveAttribute('aria-pressed', 'false');

	await expand(page).click();
	await expect(expand(page)).toHaveAttribute('aria-pressed', 'true');
	await expect(arrangement(page)).toBeHidden();
	await expect.poll(async () => (await roll(page)).height).toBeGreaterThan(before + 140);
	await expand(page).click();
	await expect(arrangement(page)).toBeVisible();
	await expect.poll(async () => (await roll(page)).height).toBe(before);

	// A double-click on a clip opens its notes in the whole view.
	await page.getByTestId('placement-2-0').locator('rect.body').dblclick();
	await expect(notesTab(page)).toHaveText('Notes: pluck-a');
	await expect(arrangement(page)).toBeHidden();
	await expect(expand(page)).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Escape');
	await expect(arrangement(page)).toBeVisible();
	await expect(expand(page)).toHaveAttribute('aria-pressed', 'false');
	await expect(page.getByTestId('placement-2-0')).toBeVisible(); // A double-click makes no clip on a clip

	// Esc closes a menu first, then leaves Expand, and then lets go of the notes.
	await page.getByTestId('placement-1-0').locator('rect.body').dblclick();
	await expect(notesTab(page)).toHaveText('Notes: lead-a');
	const note = (await page.getByTestId('note-0').locator('rect.body').boundingBox())!;
	await page.mouse.click(note.x + note.width / 2, note.y + note.height / 2, { button: 'right' });
	await expect(page.getByRole('menu', { name: 'Note' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('menu', { name: 'Note' })).toHaveCount(0);
	await expect(arrangement(page)).toBeHidden();
	await expect(page.getByTestId('note-0')).toHaveClass(/chosen/);
	await page.keyboard.press('Escape');
	await expect(arrangement(page)).toBeVisible();
	await expect(page.getByTestId('note-0')).toHaveClass(/chosen/);
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('note-0')).not.toHaveClass(/chosen/);

	// Step entry is a mode nearer than Expand, so Esc leaves it first.
	const step = page.getByRole('button', { name: 'Step', exact: true });
	await expand(page).click();
	await page.keyboard.press('r');
	await expect(step).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Escape');
	await expect(step).toHaveAttribute('aria-pressed', 'false');
	await expect(arrangement(page)).toBeHidden();
	await page.keyboard.press('Escape');
	await expect(arrangement(page)).toBeVisible();
});

test('Expand folds the inspector too, I shows it beside the notes, and coming back leaves it as it was', async ({
	page
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/?timeline=song');
	const clipLength = page.getByLabel('Clip length');
	await expect(clipLength).toBeVisible();
	await expand(page).click();
	await expect(clipLength).toBeHidden();
	await expect(inspector(page)).toHaveAttribute('aria-expanded', 'false');
	await page.keyboard.press('i');
	await expect(clipLength).toBeVisible();
	await expect(arrangement(page)).toBeHidden();
	await page.keyboard.press('Escape');
	await expect(arrangement(page)).toBeVisible();
	await expect(clipLength).toBeVisible();
});

test('I folds the inspector, a full-height column, to a rail, and each side of 1400 px remembers its own', async ({
	page
}) => {
	// Wide, it starts open, down the whole height beside the arrangement and the notes.
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/?timeline=song');
	const column = page.locator('#inspector');
	await expect(column).toBeVisible();
	await expect(page.getByRole('button', { name: 'Delete clip' })).toBeVisible(); // The foot of the column, in sight
	const side = (await column.boundingBox())!;
	const tracks = (await arrangement(page).boundingBox())!;
	const notes = (await page.getByRole('region', { name: 'Song editor' }).getByRole('tabpanel').boundingBox())!;
	expect(Math.abs(side.y - tracks.y)).toBeLessThan(2);
	expect(Math.abs(side.y + side.height - (notes.y + notes.height))).toBeLessThan(2);
	expect(side.height).toBeGreaterThan(700);

	// I folds it, a field keeps its I, and the rail unfolds it.
	await page.keyboard.press('i');
	await expect(column).toBeHidden();
	await expect(inspector(page)).toHaveAttribute('aria-expanded', 'false');
	await page.getByLabel('Song name', { exact: true }).press('i');
	await expect(column).toBeHidden();
	await page.reload();
	await expect(column).toBeHidden();
	await inspector(page).click();
	await expect(column).toBeVisible();
	await expect(inspector(page)).toHaveAttribute('aria-expanded', 'true');

	// Narrow, it starts folded, though it is open on a wide screen, and remembers being opened there.
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.reload();
	await expect(column).toBeHidden();
	await page.keyboard.press('i');
	await expect(column).toBeVisible();
	await page.reload();
	await expect(column).toBeVisible();
	await inspector(page).click(); // The column's own control folds it
	await expect(column).toBeHidden();
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(column).toBeVisible();
});

test('each clip keeps its zoom and row height, across clips, tabs and a reload', async ({ page }) => {
	await page.goto('/?timeline=song');
	await expect(notesTab(page)).toHaveText('Notes: lead-a');
	const first = await roll(page);
	await page.getByRole('button', { name: 'Zoom the roll in' }).click();
	await overRoll(page);
	await wheel(page, ['ControlOrMeta', 'Shift'], 0, -100);
	await expect.poll(async () => (await roll(page)).row).toBeGreaterThan(first.row);
	const zoomed = await roll(page);
	expect(zoomed.perTick).toBeCloseTo(first.perTick * 1.5);

	await page.getByTestId('placement-2-0').locator('rect.body').click();
	await expect(notesTab(page)).toHaveText('Notes: pluck-a');
	expect((await roll(page)).row).toBe(first.row);
	const same = async (scroll: boolean) => {
		const now = await roll(page);
		expect(now.perTick).toBeCloseTo(zoomed.perTick);
		expect(now.row).toBe(zoomed.row);
		if (scroll) expect([now.left, now.top]).toEqual([zoomed.left, zoomed.top]);
	};
	await page.getByTestId('placement-1-0').locator('rect.body').click();
	await expect(notesTab(page)).toHaveText('Notes: lead-a');
	await same(true);

	await page.getByRole('tablist', { name: 'Song views' }).getByRole('tab', { name: 'Mixer' }).click();
	await notesTab(page).click();
	await same(true);

	// A reload keeps the zoom and the rows, and scrolls to the notes as a clip first opened does.
	await page.reload();
	await expect(notesTab(page)).toHaveText('Notes: lead-a');
	await same(false);
	await page.getByTestId('placement-2-0').locator('rect.body').click();
	expect((await roll(page)).row).toBe(first.row);
});

test('the wheel scrolls, Shift scrolls sideways, Mod or a pinch zooms, Mod+Shift sets the rows, and . fits', async ({
	page
}) => {
	await page.goto('/?timeline=song');
	const start = await roll(page);
	const { point } = await overRoll(page);

	await wheel(page, [], 0, 120);
	await expect.poll(async () => (await roll(page)).top).toBeGreaterThan(start.top);
	expect((await roll(page)).perTick).toBe(start.perTick);

	await wheel(page, ['Shift'], 0, 120);
	await expect.poll(async () => (await roll(page)).left).toBeGreaterThan(start.left);
	const scrolled = await roll(page);
	expect(scrolled.perTick).toBe(start.perTick);

	// Mod zooms across, and keeps the tick under the pointer where it was.
	const tickUnder = async () => {
		const at = await box(page, 'roll');
		return (point.x - at.x) / (await roll(page)).perTick;
	};
	const under = await tickUnder();
	await wheel(page, ['ControlOrMeta'], 0, -100);
	await expect.poll(async () => (await roll(page)).perTick).toBeGreaterThan(scrolled.perTick);
	expect(Math.abs((await tickUnder()) - under)).toBeLessThan(10);
	expect((await roll(page)).row).toBe(start.row);

	// A pinch is a wheel with Ctrl, which zooms on a Mac too, where Ctrl isn't Mod.
	const pinched = (await roll(page)).perTick;
	await wheel(page, ['Control'], 0, 40);
	await expect.poll(async () => (await roll(page)).perTick).toBeLessThan(pinched);

	await wheel(page, ['ControlOrMeta', 'Shift'], 0, -100);
	await expect.poll(async () => (await roll(page)).row).toBeGreaterThan(start.row);

	// . fits the clip's bars across the roll and scrolls its notes into the middle, at the rows' height as it was, so the zoom
	// buttons take back all it did.
	const taller = await roll(page);
	await page.keyboard.press('.');
	const view = (await page
		.getByTestId('roll')
		.evaluate((r) => r.closest('.roll')!.getBoundingClientRect().toJSON())) as {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	const count = await page.locator('[data-testid^="note-"]').count();
	expect(count).toBeGreaterThan(4);
	const noteBoxes = () =>
		page
			.locator('[data-testid^="note-"] rect.body')
			.evaluateAll((rects) =>
				rects.map((r) => r.getBoundingClientRect().toJSON() as { x: number; y: number; right: number; bottom: number })
			);
	await expect
		.poll(async () => (await noteBoxes()).every((b) => b.x >= view.x && b.right <= view.x + view.width))
		.toBe(true);
	const boxes = await noteBoxes();
	const middle = (Math.min(...boxes.map((b) => b.y)) + Math.max(...boxes.map((b) => b.bottom))) / 2;
	expect(Math.abs(middle - (view.y + view.height / 2))).toBeLessThanOrEqual(taller.row);
	const fitted = await roll(page);
	expect(fitted.row).toBe(taller.row);
	await page.getByRole('button', { name: 'Zoom the roll out' }).click();
	await page.getByRole('button', { name: 'Fit', exact: true }).click(); // The button does what . does
	await expect.poll(async () => (await roll(page)).perTick).toBeCloseTo(fitted.perTick);
});
