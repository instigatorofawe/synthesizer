import { expect, test as base, type Page } from '@playwright/test';

// Esc cancels a drag in every editor, as Design §19's gesture table has it: pressed, moved, Esc, moved again and let go, what
// was dragged is where it was, and nothing is kept. A press often leaves focus on the page rather than on what was pressed, so
// Esc mustn't depend on where focus is. The lanes and the graph have tests of their own (SongLanesTest, GraphGesturesTest).

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

test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

// A new song with one note in its clip, saved, so any edit kept shows as unsaved.
async function savedSong(page: Page) {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByRole('button', { name: 'New timeline', exact: true }).click();
	await page.getByLabel('New timeline name').fill('Esc');
	await page.getByLabel('New timeline name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	const roll = page.getByTestId('roll');
	const box = (await roll.boundingBox())!;
	const key = (await page.getByTestId('key-60').boundingBox())!;
	const perTick = Number(await roll.getAttribute('data-per-tick'));
	await page.mouse.click(box.x + 960 * perTick + 3, key.y + key.height / 2);
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-tick', '960');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
}

// Pressed at the middle of `what`, moved halfway by (dx, dy), Esc, moved the rest of the way, and let go. With `unfocused`,
// focus leaves for the page halfway, before Esc.
async function dragWithEscape(
	page: Page,
	what: ReturnType<Page['getByTestId']>,
	dx: number,
	dy: number,
	unfocused = false
) {
	const box = (await what.boundingBox())!;
	const from = { x: box.x + Math.min(box.width / 2, 12), y: box.y + box.height / 2 };
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	for (let i = 1; i <= 6; i++) await page.mouse.move(from.x + (dx * i) / 12, from.y + (dy * i) / 12);
	if (unfocused) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.keyboard.press('Escape');
	for (let i = 7; i <= 12; i++) await page.mouse.move(from.x + (dx * i) / 12, from.y + (dy * i) / 12);
	await page.mouse.up();
}

test('Esc cancels a drag of a note, a clip, a track head’s fader and the Mixer’s fader', async ({ page }) => {
	await savedSong(page);

	// A press on a note can leave focus on the page, as the Engineering review found in a bigger song.
	const note = page.getByTestId('note-0');
	await dragWithEscape(page, note.locator('.body'), 80, -30, true);
	await expect(note).toHaveAttribute('data-tick', '960');
	await expect(note).toHaveAttribute('data-note', '60');
	await expect(page.getByTestId('unsaved')).toHaveCount(0);

	const clip = page.getByTestId('placement-1-0');
	await dragWithEscape(page, clip, 120, 0);
	await expect(clip).toHaveAttribute('data-tick', '0');
	await expect(page.getByTestId('unsaved')).toHaveCount(0);

	const head = page.getByTestId('head-fader-1');
	const level = await head.getAttribute('aria-valuenow');
	await dragWithEscape(page, head, -30, 0);
	await expect(head).toHaveAttribute('aria-valuenow', level!);
	await expect(page.getByTestId('unsaved')).toHaveCount(0);

	await page
		.getByRole('tablist', { name: 'Timeline views' })
		.getByRole('tab', { name: /^Mixer/ })
		.click();
	const fader = page.getByLabel('Fader for Track 1');
	const at = await fader.inputValue();
	await dragWithEscape(page, page.getByLabel('Fader for Track 1'), -40, 0);
	await expect(fader).toHaveValue(at);
	await expect(page.getByTestId('unsaved')).toHaveCount(0);

	// A drag let go without Esc is still kept.
	const box = (await fader.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2, { steps: 4 });
	await page.mouse.up();
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');
});
