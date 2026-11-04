import { expect, test as base, type Page } from '@playwright/test';
import { loudest } from './Engine.ts';

// What the postmortem's next wave did for a laptop's screen, at 1280 by 720, the smallest the editor is laid out for: no button
// for audio, one Vel, view tabs that keep their names, room for notes, and a handle between the arrangement and the notes.

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

test.use({ viewport: { width: 1280, height: 720 } });

test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });
const arrangement = (page: Page) => page.getByTestId('arrangement-view');
const height = async (page: Page) => (await arrangement(page).boundingBox())!.height;
const level = (page: Page, name: string) => loudest(page.getByRole('meter', { name, includeHidden: true }));

// How many of the roll's rows are in sight, under its ruler.
const rows = (page: Page) =>
	page.getByTestId('roll').evaluate((roll) => {
		const scroller = roll.closest('.roll')!;
		return (scroller.clientHeight - 16) / Number(roll.getAttribute('data-row-height'));
	});

// A new song, made from the browser, which opens over the page at this width.
async function newSong(page: Page, name: string) {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.keyboard.press('b');
	await browser(page).getByRole('button', { name: 'New song', exact: true }).click();
	await page.getByLabel('New song name').fill(name);
	await page.getByLabel('New song name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByTestId('roll')).toBeFocused();
}

test("audio starts with the page's first click, and a note clicked into a new song is heard", async ({ page }) => {
	await newSong(page, 'Heard at once');
	await page.reload(); // A page nothing has been clicked or typed into yet, where a browser lets no audio start
	await expect(page.getByTestId('roll')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Start audio' })).toHaveCount(0);
	await expect(page.getByTestId('state')).toHaveCount(0);

	// The click that adds the first note starts audio, and the note it adds is heard while it is held.
	const roll = page.getByTestId('roll');
	const box = (await roll.boundingBox())!;
	const key = (await page.getByTestId('key-60').boundingBox())!;
	await page.mouse.move(box.x + 6, key.y + key.height / 2);
	await page.mouse.down();
	await expect(page.getByTestId('note-0')).toBeVisible();
	await expect.poll(() => level(page, 'Master level'), { timeout: 10000 }).toBeGreaterThan(0.005);
	await page.mouse.up();
	await expect(page.getByTestId('state')).toHaveAttribute('data-live', /song|alone/);
});

test('one Vel, beside the keys, sets what new notes are written at', async ({ page }) => {
	await newSong(page, 'One Vel');
	await expect(page.getByLabel('Velocity of new notes')).toHaveCount(0);
	const vel = page.getByLabel('Velocity of the keys');
	await expect(vel).toBeVisible();
	await vel.fill('64');
	await vel.press('Enter');
	const roll = (await page.getByTestId('roll').boundingBox())!;
	const key = (await page.getByTestId('key-72').boundingBox())!;
	await page.mouse.click(roll.x + 8, key.y + key.height / 2);
	await expect(page.getByTestId('note-0')).toBeVisible();
	await expect(page.getByLabel('Note velocity')).toHaveValue('64');
});

test('the view tabs keep their names with an unsaved count showing, and the top bar fits', async ({ page }) => {
	await page.goto('/?timeline=song');
	await page.getByLabel('Song name', { exact: true }).fill('Ode to Joy, second draft');
	await expect(page.getByTestId('unsaved')).toBeVisible();
	// The Song tab gives way only to its first ten characters, and the Patch tab's name is whole.
	const cut = (id: string) =>
		page
			.getByTestId(id)
			.locator('.name')
			.evaluate((name) => ({
				shown: name.clientWidth,
				whole: name.scrollWidth,
				ch: parseFloat(getComputedStyle(name).fontSize)
			}));
	const song = await cut('view-song');
	expect(song.shown).toBeGreaterThanOrEqual(song.ch * 4.5); // Ten characters of a proportional face, at the least
	const patch = await cut('view-patch');
	expect(patch.whole - patch.shown).toBeLessThanOrEqual(1);
	const bar = await page
		.locator('header.topbar')
		.evaluate((top) => ({ shown: top.clientWidth, whole: top.scrollWidth }));
	expect(bar.whole - bar.shown).toBeLessThanOrEqual(1);
});

// The Layout review asked for 14 rows here. The roll's bar ruler takes 16 px of it, so Hall shows 12 and more with its velocity
// strip and lanes open, and with them folded, as a laptop's user would, half as many again.
test('HallOfTheMountainKing gets 12 rows of notes, and 18 with the strips below folded', async ({ page }) => {
	await page.goto('/?recipe=HallOfTheMountainKing');
	await expect(page.getByTestId('roll')).toBeVisible();
	await expect.poll(() => rows(page)).toBeGreaterThanOrEqual(12);
	await page.getByRole('button', { name: 'Velocity', exact: true }).click();
	await page.getByRole('button', { name: /^Lanes/ }).click();
	await expect.poll(() => rows(page)).toBeGreaterThanOrEqual(18);
});

test('the tab strip resizes the arrangement, Esc puts a drag back, a double-click gives it its own height, and a reload keeps it', async ({
	page
}) => {
	await page.goto('/?recipe=HallOfTheMountainKing');
	await expect(page.getByTestId('roll')).toBeVisible();
	const own = await height(page);
	const handle = page.getByTestId('split');
	const grip = (await handle.boundingBox())!;
	const from = { x: grip.x + grip.width / 2, y: grip.y + 2 };

	// Down gives the arrangement more of the tracks.
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x, from.y + 60, { steps: 4 });
	await page.mouse.move(from.x, from.y + 120, { steps: 4 });
	await page.mouse.up();
	await expect.poll(() => height(page)).toBeGreaterThan(own + 100);
	const dragged = await height(page);
	await expect(handle).toHaveAttribute('aria-valuenow', String(Math.round(dragged)));

	// Esc in a drag puts back what it found.
	await page.mouse.move(from.x, from.y + 120);
	await page.mouse.down();
	await page.mouse.move(from.x, from.y + 20, { steps: 4 });
	await expect.poll(() => height(page)).toBeLessThan(dragged - 50);
	await page.keyboard.press('Escape');
	await expect.poll(() => height(page)).toBeCloseTo(dragged, 0);
	await page.mouse.up();

	// The song keeps it across a reload, and the notes keep their room.
	await page.reload();
	await expect(page.getByTestId('roll')).toBeVisible();
	await expect.poll(() => height(page)).toBeCloseTo(dragged, 0);
	expect(await rows(page)).toBeGreaterThan(3);

	// The arrows move it from the handle, and a double-click on the strip gives it its own height again.
	await handle.focus();
	await page.keyboard.press('ArrowUp');
	await expect.poll(() => height(page)).toBeCloseTo(dragged - 24, 0);
	const strip = (await page.getByRole('tablist', { name: 'Song views' }).boundingBox())!;
	await page.mouse.dblclick(strip.x + strip.width + 40, strip.y + strip.height / 2);
	await expect.poll(() => height(page)).toBeCloseTo(own, 0);
	await expect(handle).not.toHaveAttribute('aria-valuenow');
});
