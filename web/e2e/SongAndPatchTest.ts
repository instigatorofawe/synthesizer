import { expect, test as base, type Page } from '@playwright/test';
import { openView } from './Views.ts';

// What the views gained that needed no decision: the ruler and song lanes stay in sight, the roll has a ruler and triplets,
// the strip and lanes fold, lanes show where a click adds, a patch goes on the chosen track, values show on nodes and drag,
// the keys can go full width, and the address keeps Expand, the chosen node and the JSON tab. At 1280 by 800.

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

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });
const sideTab = (page: Page, name: 'Node' | 'Patch' | 'JSON') =>
	page.getByRole('tablist', { name: 'Side column' }).getByRole('tab', { name, exact: true });

// A patch made from the browser, which opens over the page at this width: B gives its filter focus.
async function newPatch(page: Page, name: string) {
	await page.keyboard.press('b');
	await browser(page).getByRole('button', { name: 'New patch', exact: true }).click();
	await page.getByLabel('New patch name').fill(name);
	await page.getByLabel('New patch name').press('Enter');
	await expect(page.getByTestId('graph')).toBeFocused(); // What was made takes focus where it opens
}

test('the ruler, the loop strip and the song lanes stay in sight as the tracks scroll', async ({ page }) => {
	await page.goto('/?timeline=song');
	for (let added = 0; added < 4; ++added) {
		await page.getByRole('button', { name: 'Add track' }).click();
		await page.getByRole('listbox', { name: 'Patches' }).locator('[data-patch="lead"]').click();
	}
	const view = page.getByTestId('arrangement-view');
	await view.evaluate((element) => (element.scrollTop = 120));
	await expect.poll(() => view.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
	const band = (await page.getByTestId('arrangement-band').boundingBox())!;
	const box = (await view.boundingBox())!;
	expect(Math.abs(band.y - box.y)).toBeLessThan(3);
	await expect(page.getByTestId('tempo-lane')).toBeInViewport();
});

test('the roll counts its bars, Snap and Draw offer triplets, and a 1/8T note is a third of a beat', async ({
	page
}) => {
	await page.goto('/?timeline=song');
	await expect(page.getByTestId('roll-ruler')).toContainText('2');
	const snap = page.getByLabel('Snap', { exact: true }); // Not the Snap nodes in the Patch view, which is hidden
	await expect(snap.locator('option')).toContainText(['1/4T', '1/8T', '1/16T']);
	const beat = Number(
		await snap
			.locator('option')
			.filter({ hasText: /^1\/4$/ })
			.getAttribute('value')
	);
	await snap.selectOption({ label: '1/8T' });
	await page.getByLabel('Draw length').selectOption({ label: '1/8T' });

	const roll = page.getByTestId('roll');
	const box = (await roll.boundingBox())!;
	const key = (await page.getByTestId('key-74').boundingBox())!;
	const perTick = Number(await roll.getAttribute('data-per-tick'));
	const notes = await page.locator('[data-testid^="note-"]').count();
	await page.mouse.click(box.x + 2 * beat * perTick + 3, key.y + key.height / 2);
	const added = page.getByTestId(`note-${notes}`);
	await expect(added).toHaveAttribute('data-dur', String(beat / 3));
	await expect(added).toHaveAttribute('data-tick', String(2 * beat));
});

test('the velocity strip and the lanes fold, a lane shows where a click adds, and the strip says what a drag sets', async ({
	page
}) => {
	await page.goto('/?timeline=song');
	await expect(page.getByLabel('Add a lane').locator('optgroup[label="Mix"]')).toHaveCount(1);

	const lane = page.getByTestId('lane-0');
	const at = (await lane.boundingBox())!;
	await page.mouse.move(at.x + 50, at.y + at.height / 2); // Inside the clip, between its points
	await expect(page.getByTestId('lane-0-ghost')).toBeVisible();

	const strip = (await page.getByTestId('velocity').boundingBox())!;
	await page.mouse.move(strip.x + 10, strip.y + strip.height / 2);
	await page.mouse.down();
	await page.mouse.move(strip.x + 40, strip.y + strip.height / 3, { steps: 3 });
	await expect(page.getByTestId('velocity-readout')).toHaveText(/^\d+$/);
	await page.mouse.up();
	await expect(page.getByTestId('velocity-readout')).toHaveCount(0);

	await page.getByRole('button', { name: 'Velocity', exact: true }).click();
	await expect(page.getByTestId('velocity')).toHaveCount(0);
	await page.getByRole('button', { name: /^.?\s*Lanes/ }).click();
	await expect(lane).toHaveCount(0);
	await page.reload(); // Folded, as they were left
	await expect(page.getByTestId('roll')).toBeVisible();
	await expect(page.getByTestId('velocity')).toHaveCount(0);
	await page.getByRole('button', { name: 'Velocity', exact: true }).click();
	await page.getByRole('button', { name: /^.?\s*Lanes/ }).click();
	await expect(page.getByTestId('velocity')).toBeVisible();
	await expect(lane).toBeVisible();
});

test('↑ in step entry moves the notes of the step just written, as a fix to a wrong key', async ({ page }) => {
	await page.goto('/?timeline=song');
	await expect(page.getByRole('button', { name: 'C3', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Step', exact: true }).click();
	const at = (pitch: number) => page.locator(`[data-testid^="note-"][data-note="${pitch}"]`);
	const before = await at(49).count();
	await page.keyboard.press('a'); // C3, written at the cursor
	await expect(at(48)).not.toHaveCount(0);
	await page.keyboard.press('ArrowUp');
	await expect(at(49)).toHaveCount(before + 1);
});

test('Use on a track puts the patch shown on the track the Song view chose, as one edit', async ({ page }) => {
	await page.goto('/?timeline=song');
	await expect(page.getByTestId('track-patch-1')).toHaveText('Stereo lead');
	await page.keyboard.press('b');
	await browser(page).getByRole('link', { name: 'Sampled pluck' }).click();
	await page.getByRole('button', { name: 'Use on Lead' }).click();
	await expect(page.getByRole('button', { name: 'Use on Lead' })).toHaveCount(0);
	await openView(page, 'song');
	await expect(page.getByTestId('track-patch-1')).toHaveText('Sampled pluck');
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');
});

test('a new patch with a name that is taken is numbered, and the built-in patches are grouped', async ({ page }) => {
	await page.goto('/?timeline=song');
	await newPatch(page, 'Bass');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Bass');
	await newPatch(page, 'Bass');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Bass 2');

	await page.keyboard.press('b');
	const builtins = browser(page).getByTestId('builtins');
	await builtins.locator('summary').click();
	await expect(builtins.locator('li.family').first()).toBeVisible();
	await expect(builtins.locator('li.family', { hasText: /^drums$/ })).toHaveCount(1);
});

test('a value on a node drags across to change it, and the keys can go full width in the Patch view', async ({
	page
}) => {
	await page.goto('/?timeline=song');
	await newPatch(page, 'Values');
	const attack = page.getByTestId('value-4-attack'); // The envelope's
	await expect(attack).toBeVisible();
	const from = Number(await attack.getAttribute('aria-valuenow'));
	const box = (await attack.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
	await page.mouse.up();
	await expect.poll(async () => Number(await attack.getAttribute('aria-valuenow'))).toBeGreaterThan(from);
	await expect(attack).toHaveClass(/own/);

	const keys = page.getByRole('group', { name: 'Keys' });
	await page.getByRole('button', { name: 'Keys', exact: true }).click();
	await expect(page.getByTestId('key-strip').getByRole('group', { name: 'Keys' })).toBeVisible();
	await expect.poll(() => keys.locator('button').count()).toBeGreaterThan(25); // More octaves than the top bar's two
	await page.getByRole('button', { name: 'Keys', exact: true }).click();
	await expect(page.getByTestId('key-strip')).toHaveCount(0);
	await expect(keys.locator('button')).toHaveCount(25);
});

test('the address keeps Expand, the chosen node and the JSON tab, so a reload comes back to them', async ({ page }) => {
	await page.goto('/?timeline=song');
	await page.getByRole('button', { name: 'Expand' }).click();
	await expect(page).toHaveURL(/expand=1/);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Expand' })).toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('button', { name: 'Expand' }).click();
	await expect(page).not.toHaveURL(/expand=1/);

	await newPatch(page, 'Kept');
	await page.getByTestId('node-4').locator('rect.title').click();
	await expect(page).toHaveURL(/node=4/);
	await page.reload();
	await expect(page.getByTestId('node-4')).toHaveClass(/chosen/);
	await sideTab(page, 'JSON').click();
	await expect(page).toHaveURL(/side=json/);
	await page.reload();
	await expect(page.getByLabel('Graph JSON')).toBeVisible();
});
