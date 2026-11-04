import { expect, test, type Page } from './Fixtures.ts';

// A new track comes with a clip for its notes, and clips snap to bars while notes follow Snap, as in Live and Logic.

test.use({ viewport: { width: 1440, height: 900 } });

const BAR = 1920; // Ticks in a bar at a new song's 480 ppq

async function newSong(page: Page, name: string) {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByRole('button', { name: 'New song', exact: true }).click();
	await page.getByLabel('New song name').fill(name);
	await page.getByLabel('New song name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByLabel('Song name', { exact: true })).toHaveValue(name);
}

async function songJson(page: Page) {
	const tabs = page.getByRole('tablist', { name: 'Song views' });
	await tabs.getByRole('tab', { name: /^JSON/ }).click();
	const doc = JSON.parse(await page.getByLabel('Song JSON').inputValue());
	await tabs.getByRole('tab', { name: /^Notes/ }).click();
	return doc as {
		tracks: { id: number; placements: { clip: string; tick: number }[] }[];
		clips: { id: string; length: number; notes: { note: number }[] }[];
	};
}

// The middle of a clip in the arrangement, on screen.
async function centre(page: Page, id: string) {
	const box = (await page.getByTestId(id).boundingBox())!;
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page: Page, from: { x: number; y: number }, by: number) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + by / 2, from.y, { steps: 3 });
	await page.mouse.move(from.x + by, from.y, { steps: 3 });
	await page.mouse.up();
}

test('+ Track makes a four-bar clip at the playhead, the roll opens on it, and the keys write into it', async ({
	page
}) => {
	await newSong(page, 'Two tracks');
	await page.getByRole('button', { name: 'Add track' }).click();
	await page.getByRole('listbox', { name: 'Patches' }).locator('[data-patch="lead"]').click();
	await expect(page.getByTestId('placement-2-0')).toHaveAttribute('data-tick', '0');
	await expect(page.getByTestId('placement-2-0')).toHaveClass(/chosen/);
	await expect(page.getByRole('tab', { name: 'Notes: clip-2' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('no-clip')).toHaveCount(0);

	// Step entry writes into the new track's clip, not the first track's.
	await page.getByTestId('roll').focus();
	await page.keyboard.press('r');
	await page.keyboard.press('a');
	await expect(page.getByTestId('note-0')).toBeVisible();
	const doc = await songJson(page);
	expect(doc.tracks[1].placements).toEqual([{ clip: 'clip-2', tick: 0, repeat: 1 }]);
	expect(doc.clips.find((clip) => clip.id === 'clip-2')).toMatchObject({ length: 4 * BAR });
	expect(doc.clips.find((clip) => clip.id === 'clip-2')!.notes).toHaveLength(1);
	expect(doc.clips.find((clip) => clip.id === 'clip')!.notes).toHaveLength(0);
});

test('clips snap to bars, apart from the Snap notes take, and a finer clip snap moves them by less', async ({
	page
}) => {
	await newSong(page, 'Snapped clips');
	await expect(page.getByLabel('Clip snap')).toHaveValue(String(BAR));
	await page.getByLabel('Snap', { exact: true }).selectOption({ label: '1/16' });

	// A drag of most of a bar lands on the next bar, where notes' 1/16 would have put it part way.
	await drag(page, await centre(page, 'placement-1-0'), 96 * 0.7);
	await expect(page.getByTestId('placement-1-0')).toHaveAttribute('data-tick', String(BAR));
	await drag(page, await centre(page, 'placement-1-0'), 96 * 0.3);
	await expect(page.getByTestId('placement-1-0')).toHaveAttribute('data-tick', String(BAR));

	await page.getByLabel('Clip snap').selectOption({ label: '1/4' });
	await drag(page, await centre(page, 'placement-1-0'), 96 * 0.3);
	await expect(page.getByTestId('placement-1-0')).toHaveAttribute('data-tick', String(BAR + 480));
	await expect(page.getByLabel('Snap', { exact: true })).toHaveValue('120'); // Notes keep theirs
});
