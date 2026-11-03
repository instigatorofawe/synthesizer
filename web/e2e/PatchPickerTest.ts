import { expect, test as base, type Page } from '@playwright/test';
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

// Leaving with unsaved edits asks first, and a test that leaves means to.
test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });
const options = (page: Page) => page.getByRole('listbox', { name: 'Patches' }).getByRole('option');
const option = (page: Page, name: string) =>
	page.getByRole('listbox', { name: 'Patches' }).getByRole('option', { name, exact: true });
const addTrack = (page: Page) => page.getByRole('button', { name: 'Add track' }).click();
const headPatch = (page: Page, track: number) => page.getByTestId(`track-patch-${track}`);

async function newTimeline(page: Page, name: string) {
	await page.setViewportSize({ width: 1440, height: 1500 });
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByLabel('New timeline name').fill(name);
	await page.getByLabel('New timeline name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByLabel('Timeline name', { exact: true })).toHaveValue(name);
	await expect(page.getByTestId('arrangement')).toBeVisible();
}

async function slots(page: Page) {
	const tabs = page.getByRole('tablist', { name: 'Timeline views' });
	await tabs.getByRole('tab', { name: /^JSON/ }).click();
	const doc = JSON.parse(await page.getByLabel('Timeline JSON').inputValue());
	await tabs.getByRole('tab', { name: /^Notes/ }).click();
	return doc.tracks.map((track: { slots: string[] }) => track.slots);
}

test('+ Track asks which patch the track plays, and Esc makes no track', async ({ page }) => {
	await newTimeline(page, 'Asked');
	await addTrack(page);
	const picker = page.getByRole('combobox', { name: 'Patch for the new track' });
	await expect(picker).toBeFocused();
	await expect(picker).toHaveAttribute('aria-expanded', 'true');
	const list = page.getByRole('listbox', { name: 'Patches' });
	await expect(list.getByRole('group', { name: 'My patches' }).getByRole('option').first()).toBeVisible();
	// Built-in patches are grouped as the browser groups the examples.
	await expect(list.getByRole('group', { name: 'Built in drums' })).toContainText('Kick808');
	await expect(list.getByRole('option').last()).toHaveText('+New patch for this track');

	await page.keyboard.press('Escape');
	await expect(picker).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Add track' })).toBeFocused();
	await expect(page.getByTestId('track-1')).toHaveCount(0);

	// A second click on + Track closes it too.
	await addTrack(page);
	await expect(picker).toBeVisible();
	await addTrack(page);
	await expect(picker).toHaveCount(0);
	expect(await slots(page)).toEqual([]);
});

test('typing filters a patch picker, the arrows move through it, and Enter chooses', async ({ page }) => {
	await newTimeline(page, 'Filtered');
	await addTrack(page);
	await page.keyboard.type('pluck');
	await expect(options(page).first()).toHaveText('Sampled pluck');
	await expect(options(page).first()).toHaveAttribute('aria-selected', 'true');
	await expect(options(page).last()).toHaveText('+New patch for this track, named “pluck”');
	await page.keyboard.press('ArrowDown');
	await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
	await expect(options(page).first()).toHaveAttribute('aria-selected', 'false');
	const second = (await options(page).nth(1).textContent())!.trim();
	expect(second.toLowerCase()).toContain('pluck');
	await page.keyboard.press('Enter');
	await expect(headPatch(page, 1)).toHaveText(second);
	await expect(page.getByTestId('track-1')).toHaveAttribute('aria-pressed', 'true');

	// The inspector's slot is the same picker. Esc there puts back the patch it showed.
	const slot = page.getByRole('combobox', { name: 'Patch slot 1' });
	await expect(slot).toHaveValue(second);
	await slot.click();
	await page.keyboard.type('nothing is called this');
	await expect(page.getByText('No patch matches.')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(slot).toHaveValue(second);
	await slot.click();
	await page.keyboard.type('stereo LEAD');
	await expect(options(page)).toHaveText(['Stereo lead', '+New patch for this track, named “stereo LEAD”']);
	await page.keyboard.press('Enter');
	await expect(slot).toHaveValue('Stereo lead');
	await expect(headPatch(page, 1)).toHaveText('Stereo lead');
	expect(await slots(page)).toEqual([['lead']]);
});

test('a track head names its patch, not its id, and the name opens that patch', async ({ page }) => {
	await newTimeline(page, 'Named heads');
	const long = 'A patch whose name is far too long for a track head';
	await page.getByLabel('New patch name').fill(long);
	await page.getByLabel('New patch name').press('Enter');
	await page.waitForURL(/patch=/);
	const id = new URL(page.url()).searchParams.get('patch')!;
	await expect(page.getByLabel('Timeline name', { exact: true })).toHaveValue('Named heads');

	await openView(page, 'song'); // A patch made in the browser opens in the Patch view
	await addTrack(page);
	await page.keyboard.type('far too long');
	await page.keyboard.press('Enter');
	await expect(headPatch(page, 1)).toHaveText(long);
	await expect(headPatch(page, 1)).toHaveAttribute('title', long);
	await expect(page.getByTestId('arrangement-view')).not.toContainText(id);
	// It's cut short to fit, and the tooltip has the whole of it.
	expect(await headPatch(page, 1).evaluate((name) => name.scrollWidth > name.clientWidth)).toBe(true);

	await addTrack(page);
	await option(page, 'Stereo lead').click();
	await expect(headPatch(page, 2)).toHaveText('Stereo lead');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Stereo lead');

	await headPatch(page, 1).click();
	await expect(page).toHaveURL(new RegExp(`patch=${id}`));
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue(long);
	await expect(page.getByTestId('track-1')).toHaveAttribute('aria-pressed', 'true');
});

test("a track head's ▾ chooses another patch for its track", async ({ page }) => {
	await newTimeline(page, 'Changed');
	await addTrack(page);
	await option(page, 'Stereo lead').click();
	const change = page.getByRole('button', { name: 'Change the patch of Track 1' });
	await change.click();
	const picker = page.getByRole('combobox', { name: 'Patch for Track 1' });
	await expect(picker).toBeFocused();
	await expect(change).toHaveAttribute('aria-expanded', 'true');
	// It starts on the patch the track plays, which is first, on this song.
	const song = page.getByRole('listbox', { name: 'Patches' }).getByRole('group', { name: 'On this song' });
	await expect(song.getByRole('option')).toHaveText(['Stereo lead']);
	await expect(option(page, 'Stereo lead')).toHaveAttribute('aria-selected', 'true');
	await option(page, 'Sampled pluck').click();
	await expect(picker).toHaveCount(0);
	await expect(headPatch(page, 1)).toHaveText('Sampled pluck');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Sampled pluck');
	expect(await slots(page)).toEqual([['pluck']]);

	await change.click();
	await expect(picker).toBeVisible();
	await change.click();
	await expect(picker).toHaveCount(0);
});

test('New patch for this track makes a patch that sounds, puts it on the track and opens it', async ({ page }) => {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(e.message));
	await newTimeline(page, 'Made here');
	await addTrack(page);
	await option(page, 'New patch for this track').click();
	await expect(headPatch(page, 1)).toHaveText('Track 1 patch');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Track 1 patch');
	await expect(page).toHaveURL(/patch=/);
	const id = new URL(page.url()).searchParams.get('patch')!;
	await openView(page, 'song');
	expect(await slots(page)).toEqual([[id]]);
	await expect(
		browser(page).getByRole('list', { name: 'Patches', exact: true }).getByRole('link', { name: 'Track 1 patch' })
	).toBeVisible();
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved'); // The timeline. The patch is saved as it's made.

	// A clip with a note, and the new patch plays it.
	const row = (await page.getByTestId('row-1').boundingBox())!;
	await page.mouse.dblclick(row.x + 10, row.y + 20);
	await expect(page.getByTestId('roll')).toBeVisible();
	const roll = page.getByTestId('roll');
	const box = (await roll.boundingBox())!;
	const key = (await page.getByTestId('key-60').boundingBox())!;
	// A note the whole bar long, so it still sounds when the meter is first read, which on a slow machine comes late.
	await page.getByLabel('Draw length').selectOption({ label: '1 bar' });
	await page.mouse.dblclick(box.x + 2, key.y + key.height / 2);
	await expect(page.getByTestId('note-0')).toBeAttached();
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-dur', '1920');
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).not.toHaveText('0', { timeout: 10000 });
	await expect(page.getByTestId('compile-error')).toHaveCount(0);
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	const level = page.getByRole('meter', { name: 'Level of Track 1' });
	await expect.poll(async () => Number(await level.getAttribute('data-peak')), { timeout: 8000 }).toBeGreaterThan(0.01);

	// Its edits wait with the timeline's, and Save writes both.
	await openView(page, 'patch');
	await page.getByLabel('Patch name', { exact: true }).fill('Made for the track');
	await expect(page.getByTestId('unsaved')).toHaveText('2 unsaved');
	await expect(headPatch(page, 1)).toHaveText('Made for the track');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await page.reload();
	await expect(headPatch(page, 1)).toHaveText('Made for the track');

	// From a slot, a new patch is named after what was typed.
	await openView(page, 'song');
	const slot = page.getByRole('combobox', { name: 'Patch slot 1' });
	await slot.click();
	await page.keyboard.type('Bass made here');
	await expect(options(page)).toHaveText(['+New patch for this track, named “Bass made here”']);
	await page.keyboard.press('Enter');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Bass made here'); // Open in the Patch view
	await openView(page, 'song');
	await expect(slot).toHaveValue('Bass made here');
	await expect(headPatch(page, 1)).toHaveText('Bass made here');
	expect(problems).toEqual([]);
});
