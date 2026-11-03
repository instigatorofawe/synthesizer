import { expect, test as base, type Page } from '@playwright/test';
import { redoButton, undoButton } from './Chrome.ts';
import { settled } from './Engine.ts';
import { openView } from './Views.ts';

// A page load waits until the page has hydrated, as AppTest's do.
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

// The browser beside the page, and the inspector open.
test.use({ viewport: { width: 1440, height: 900 } });

// Leaving with unsaved edits asks first, and a test that leaves means to.
test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });
const editCopy = (page: Page) => page.getByRole('button', { name: 'Edit a copy', exact: true });
const patchName = (page: Page) => page.getByLabel('Patch name', { exact: true });
const trail = (page: Page) => page.getByRole('navigation', { name: 'Where this patch is heard' });
const shownPatch = (page: Page) => new URL(page.url()).searchParams.get('patch');
// The patch's scopes go on watching while the Song view is on screen and the Patch view is out of sight.
const patchLoudest = (page: Page) =>
	page
		.getByRole('region', { name: 'Patch editor', includeHidden: true })
		.getByTestId('peak')
		.evaluateAll((list) => list.map((e) => Number(e.getAttribute('data-loudest'))));

// New timeline makes the template: Track 1, playing a built-in piano, with an empty four-bar clip open in the roll.
async function newSong(page: Page, name: string) {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByRole('button', { name: 'New timeline', exact: true }).click(); // Its + opens the field
	await page.getByLabel('New timeline name').fill(name);
	await page.getByLabel('New timeline name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByLabel('Timeline name', { exact: true })).toHaveValue(name);
	await expect(page.getByTestId('roll')).toBeVisible();
}

// A click in the roll adds a note, which puts the track in the song.
async function addNote(page: Page, note: number) {
	const roll = (await page.getByTestId('roll').boundingBox())!;
	const key = (await page.getByTestId(`key-${note}`).boundingBox())!;
	await page.mouse.click(roll.x + 3, key.y + key.height / 2);
	await expect(page.getByTestId('note-0')).toBeVisible();
}

// Each track's slots, as the timeline's JSON has them.
async function slots(page: Page): Promise<Record<number, string[]>> {
	const tabs = page.getByRole('tablist', { name: 'Timeline views' });
	await tabs.getByRole('tab', { name: /^JSON/ }).click();
	const doc = JSON.parse(await page.getByLabel('Timeline JSON').inputValue());
	await tabs.getByRole('tab', { name: /^Notes/ }).click();
	return Object.fromEntries(doc.tracks.map((track: { id: number; slots: string[] }) => [track.id, track.slots]));
}

async function playUntilHeard(page: Page) {
	await settled(page);
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).not.toHaveText('0', { timeout: 10000 });
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect.poll(async () => Math.max(0, ...(await patchLoudest(page))), { timeout: 8000 }).toBeGreaterThan(0.01);
	await page.getByRole('button', { name: 'Stop', exact: true }).click();
}

test("Edit a copy on an example's patch puts the copy on the track that played it, in the example's copy in the library", async ({
	page
}) => {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(e.message));

	// Track 2's patch, from its head
	await page.goto('/?recipe=ReverseSwell');
	await page.getByTestId('track-patch-2').click();
	await expect(page.getByTestId('view-patch')).toHaveAttribute('aria-selected', 'true');
	await expect(patchName(page)).toHaveCount(0);
	await editCopy(page).click();

	// The example is in the library now, with the copy on track 2, chosen, as an unsaved edit, and the copy is open to change
	await page.waitForURL(/timeline=recipe-ReverseSwell/);
	await expect(patchName(page)).toHaveValue('ReverseSwell boom copy');
	const boom = shownPatch(page)!;
	expect(boom).not.toContain('builtin');
	await expect(page.getByTestId('view-patch')).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');
	await expect(page.getByTestId('hearing')).toHaveAttribute('data-kind', 'song');
	await expect(trail(page)).toContainText('Track 2');
	await expect(page.getByTestId('used-by')).toContainText('1 timeline: ReverseSwell');
	await playUntilHeard(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);

	await openView(page, 'song');
	await expect(page.getByTestId('track-2')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('track-patch-2')).toHaveText('ReverseSwell boom copy');
	expect(await slots(page)).toEqual({
		1: ['builtin-ReverseSwell-swell', 'builtin-ReverseSwell-crash'],
		2: [boom]
	});
	// The swap is one step of the timeline's undo
	await undoButton(page).click();
	await expect(page.getByTestId('track-patch-2')).toHaveText('ReverseSwell boom');
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await redoButton(page).click();
	await expect(page.getByTestId('track-patch-2')).toHaveText('ReverseSwell boom copy');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByTestId('unsaved')).toHaveCount(0);

	// Again from the example, which uses the copy already in the library. Track 2 is chosen, and the patch is track 1's second,
	// which plays a recording.
	await page.goto('/?recipe=ReverseSwell');
	await page.getByTestId('track-2').click();
	await openView(page, 'patch');
	await page.getByRole('group', { name: 'Patches in this recipe' }).getByRole('button', { name: 'crash' }).click();
	await expect(editCopy(page)).toHaveAttribute('title', /library's ReverseSwell/);
	await editCopy(page).click();
	await page.waitForURL(/timeline=recipe-ReverseSwell/);
	await expect(patchName(page)).toHaveValue('ReverseSwell crash copy');
	const crash = shownPatch(page)!;
	expect(crash).not.toBe(boom);
	await expect(trail(page)).toContainText('Track 1');
	await playUntilHeard(page);
	await expect(page.getByTestId('compile-error')).toHaveCount(0);

	await openView(page, 'song');
	await expect(page.getByTestId('track-1')).toHaveAttribute('aria-pressed', 'true');
	expect(await slots(page)).toEqual({ 1: ['builtin-ReverseSwell-swell', crash], 2: [boom] });
	const timelines = browser(page).getByRole('list', { name: 'Timelines' });
	await expect(timelines.getByRole('link', { name: /^ReverseSwell/ })).toHaveCount(1); // The one copy, not another
	expect(problems).toEqual([]);
});

test('Edit a copy on a patch an example plays only inside another says that the copy is on no track', async ({
	page
}) => {
	await page.goto('/?recipe=Subpatches');
	await openView(page, 'patch');
	await page.getByRole('group', { name: 'Patches in this recipe' }).getByRole('button', { name: 'pair' }).click();
	await editCopy(page).click();
	await page.waitForURL(/timeline=recipe-Subpatches/);
	await expect(patchName(page)).toHaveValue('Subpatches pair copy');
	await expect(page.getByText('The copy is on no track: Subpatches plays Subpatches pair only inside')).toBeVisible();
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await expect(page.getByTestId('used-by')).toHaveCount(0); // A save of the copy changes no timeline
});

test('Edit a copy on a built-in that a library timeline plays swaps the copy in as an unsaved edit, which Undo takes back', async ({
	page
}) => {
	await newSong(page, 'Swapped');
	await addNote(page, 60); // An edit not yet saved
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');
	await page.getByTestId('track-patch-1').click();
	await expect(page.getByTestId('view-patch')).toHaveAttribute('aria-selected', 'true');
	await editCopy(page).click();

	await expect(patchName(page)).toHaveValue(/^FurElise Electric piano copy/);
	const copy = shownPatch(page)!;
	const name = await patchName(page).inputValue();
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved'); // The copy is saved, and the swap is the timeline's edit
	await openView(page, 'song');
	await expect(page.getByTestId('track-patch-1')).toHaveText(name);
	expect((await slots(page))[1]).toEqual([copy]);

	// One step of the timeline's undo, which leaves the note
	await undoButton(page).click();
	await expect(page.getByTestId('track-patch-1')).toHaveText('FurElise Electric piano');
	await expect(page.getByTestId('note-0')).toBeVisible();
	expect((await slots(page))[1]).toEqual(['builtin-FurElise-piano']);
	await redoButton(page).click();
	await expect(page.getByTestId('track-patch-1')).toHaveText(name);
});

test('the header counts an unsaved use of a built-in, and agrees with where the keys play it', async ({ page }) => {
	await newSong(page, 'Heard on it');
	const id = new URL(page.url()).searchParams.get('timeline');
	await page.goto(`/?timeline=${id}&patch=builtin-DrawbarOrgan`);
	await expect(page.getByTestId('used-by')).toHaveText('Not used by a timeline');
	await expect(page.getByTestId('hearing')).toHaveAttribute('data-kind', 'alone');

	// Track 1 plays it, which isn't saved yet
	await openView(page, 'song');
	await addNote(page, 60);
	await page.getByRole('button', { name: 'Change the patch of Track 1' }).click();
	await page.getByRole('listbox', { name: 'Patches' }).locator('[data-patch="builtin-DrawbarOrgan"]').click();
	await expect(page.getByTestId('track-patch-1')).toHaveText('DrawbarOrgan');
	await openView(page, 'patch');
	await expect(page.getByTestId('hearing')).toHaveAttribute('data-kind', 'song');
	await expect(page.getByTestId('hearing')).toHaveText('Keys play it on Track 1, in the song.');
	await expect(page.getByTestId('used-by')).toHaveText('Used by 1 timeline: Heard on it');
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');

	// Saved, it says the same
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await expect(page.getByTestId('used-by')).toHaveText('Used by 1 timeline: Heard on it');

	// And a use taken away, unsaved, is counted no more
	await openView(page, 'song');
	await undoButton(page).click();
	await expect(page.getByTestId('track-patch-1')).toHaveText('FurElise Electric piano');
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');
	await browser(page).getByLabel('Filter the browser').fill('DrawbarOrgan');
	await browser(page).getByTestId('builtins').getByRole('link', { name: 'DrawbarOrgan' }).click();
	await expect(patchName(page)).toHaveCount(0);
	await expect(page.getByTestId('used-by')).toHaveText('Not used by a timeline');
	await expect(page.getByTestId('hearing')).toHaveAttribute('data-kind', 'alone');
});
