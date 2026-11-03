import { expect, test as base, type Page } from '@playwright/test';
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

// A 1280 by 800 laptop, the smallest screen the editor is laid out for.
test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });
const rail = (page: Page) => page.getByRole('toolbar', { name: 'Library and examples' });
const shows = (page: Page, view: 'song' | 'patch') =>
	expect(page.getByTestId(`view-${view}`)).toHaveAttribute('aria-selected', 'true');
const notesTab = (page: Page) =>
	page.getByRole('tablist', { name: 'Timeline views' }).getByRole('tab', { name: /^Notes/ });
// A track's meter is in its head, in the Song view, which is still there while the Patch view is on screen.
const level = (page: Page, track: string) =>
	page
		.getByRole('meter', { name: `Level of ${track}`, includeHidden: true })
		.getAttribute('data-peak')
		.then(Number);

// What scrolls the piano roll, which is how much of it is on screen: its height, and how far down it is scrolled, after
// scrolling it by `by`.
const rollView = (page: Page, by = 0) =>
	page.getByTestId('roll').evaluate((roll, by) => {
		let at = roll.parentElement;
		while (at && !/auto|scroll/.test(getComputedStyle(at).overflowY)) at = at.parentElement;
		at!.scrollTop += by;
		return { height: at!.clientHeight, scroll: at!.scrollTop };
	}, by);

test('the tabs and ` switch views, and a field keeps its `', async ({ page }) => {
	await page.goto('/?timeline=song');
	await shows(page, 'song');
	await expect(page.getByTestId('view-song')).toContainText('Song');
	await expect(page.getByTestId('view-patch')).toContainText('Stereo lead');
	await expect(page.getByTestId('arrangement')).toBeVisible();
	await expect(page.getByTestId('graph')).toBeHidden();

	await page.getByTestId('view-patch').click();
	await expect(page.getByTestId('graph')).toBeVisible();
	await expect(page.getByTestId('arrangement')).toBeHidden();
	await expect(page).toHaveURL(/view=patch/);

	await page.keyboard.press('Backquote');
	await shows(page, 'song');
	await expect(page.getByTestId('arrangement')).toBeVisible();
	await expect(page.getByTestId('graph')).toBeHidden();
	await expect(page).not.toHaveURL(/view=/);

	const name = page.getByLabel('Timeline name', { exact: true });
	await name.press('End');
	await name.press('Backquote');
	await expect(name).toHaveValue('Song`');
	await shows(page, 'song');
});

test('the top bar fits a 1280 px screen, long names and all', async ({ page }) => {
	await page.goto('/?timeline=song');
	await page.getByLabel('Timeline name', { exact: true }).fill('A song with a very long name that goes on and on');
	await openView(page, 'patch');
	await page.getByLabel('Patch name', { exact: true }).fill('A patch with a name just as long as the song has');
	const bar = page.locator('header.topbar');
	const fits = () => bar.evaluate((e) => e.scrollWidth <= e.clientWidth);
	expect(await fits()).toBe(true);
	await expect(page.getByRole('button', { name: 'Start audio' })).toBeInViewport({ ratio: 1 });
	await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport({ ratio: 1 });
	await expect(page.getByRole('button', { name: '72', exact: true })).toBeInViewport({ ratio: 1 });
	await expect(page.getByTestId('view-patch')).toHaveAttribute('title', /A patch with a name just as long/);
});

test('a clip opens its patch, and the song comes back on the same clip, as it was left', async ({ page }) => {
	await page.goto('/?timeline=song');
	await page.getByTestId('placement-2-0').locator('rect').first().click();
	await expect(notesTab(page)).toHaveText('Notes: pluck-a');
	const { scroll } = await rollView(page, 120);
	expect(scroll).toBeGreaterThan(0);

	// By the trail back from the Patch view, from the inspector, which starts folded below 1400 px
	await page.getByRole('button', { name: 'Inspector' }).click();
	await page.getByRole('button', { name: 'Open patch slot 1' }).click();
	await shows(page, 'patch');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Sampled pluck');
	const trail = page.getByRole('navigation', { name: 'Where this patch is heard' });
	await expect(trail).toContainText('Pluck');
	await trail.getByRole('link').click();
	await shows(page, 'song');
	await expect(notesTab(page)).toHaveText('Notes: pluck-a');
	await expect(page.getByTestId('track-2')).toHaveAttribute('aria-pressed', 'true');
	expect((await rollView(page)).scroll).toBe(scroll);

	// By the Song tab, from the patch the track's head names
	await page.getByTestId('track-patch-2').click();
	await shows(page, 'patch');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Sampled pluck');
	await openView(page, 'song');
	await expect(notesTab(page)).toHaveText('Notes: pluck-a');
	expect((await rollView(page)).scroll).toBe(scroll);
});

test('Back goes to the view before, on the tab it was left on', async ({ page }) => {
	await page.goto('/?timeline=song');
	await page.getByRole('tablist', { name: 'Timeline views' }).getByRole('tab', { name: 'Mixer' }).click();
	await page.getByRole('button', { name: 'Edit insert 1 on room' }).click();
	await shows(page, 'patch');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Room');

	await page.goBack();
	await shows(page, 'song');
	await expect(
		page.getByRole('tablist', { name: 'Timeline views' }).getByRole('tab', { name: 'Mixer' })
	).toHaveAttribute('aria-selected', 'true');
	await page.goForward();
	await shows(page, 'patch');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Room');

	await page.getByTestId('view-song').click();
	await shows(page, 'song');
	await page.goBack();
	await shows(page, 'patch');
});

test('the address says which view, and a reload keeps it', async ({ page }) => {
	await page.goto('/?timeline=song&view=patch');
	await shows(page, 'patch');
	await expect(page.getByTestId('graph')).toBeVisible();
	await page.reload();
	await shows(page, 'patch');
	await expect(page.getByTestId('graph')).toBeVisible();

	await page.keyboard.press('Backquote');
	await shows(page, 'song');
	await page.reload();
	await shows(page, 'song');
	await expect(page.getByTestId('arrangement')).toBeVisible();

	// An address from before there were views, naming a patch, opens it
	await page.goto('/?timeline=song&patch=pluck');
	await shows(page, 'patch');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Sampled pluck');
});

test('keys play the chosen track in the Song view, and the patch where it is heard in the Patch view', async ({
	page
}) => {
	await page.goto('/?timeline=song');
	await page.getByTestId('placement-2-0').locator('rect').first().click();
	await expect(page.getByRole('group', { name: 'Keys' })).toHaveAttribute('title', /^Keys play Pluck\./);
	// With the roll focused, as when notes are being written, the keys still play the clip's track
	await page.getByTestId('roll').focus();
	await page.keyboard.down('a'); // Starts audio, as a click on a key does
	await expect(page.getByTestId('generation')).toHaveText('1', { timeout: 10000 });
	await expect.poll(() => level(page, 'Pluck'), { timeout: 8000 }).toBeGreaterThan(0.01);
	expect(await level(page, 'Lead')).toBe(0);
	await page.keyboard.up('a');

	// A patch opened from the browser is heard where a track plays it
	await page.keyboard.press('b');
	await browser(page).getByRole('link', { name: 'Stereo lead' }).click();
	await shows(page, 'patch');
	await expect(page.getByTestId('hearing')).toContainText('Keys play it on Lead');
	await page.keyboard.down('a');
	await expect.poll(() => level(page, 'Lead'), { timeout: 8000 }).toBeGreaterThan(0.01);
	await page.keyboard.up('a');
});

test('B folds the browser to its rail, and a field keeps its B', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/?timeline=song');
	await expect(browser(page)).toBeVisible();
	await expect(rail(page)).toBeHidden();
	const beside = (await page.getByTestId('arrangement').boundingBox())!.x;
	await page.keyboard.press('b');
	await expect(browser(page)).toHaveCount(0);
	await expect(rail(page)).toBeVisible();
	expect((await page.getByTestId('arrangement').boundingBox())!.x).toBeLessThan(beside);
	await page.reload();
	await expect(rail(page)).toBeVisible();
	await page.keyboard.press('b');
	await expect(browser(page)).toBeVisible();

	await browser(page).getByLabel('Filter the browser').press('b');
	await expect(browser(page).getByLabel('Filter the browser')).toHaveValue('b');
	await expect(browser(page)).toBeVisible();
});

test('below 1400 px the browser is a rail, and opens over the page until it is used', async ({ page }) => {
	await page.goto('/?timeline=song');
	await expect(browser(page)).toHaveCount(0);
	await expect(rail(page)).toBeVisible();
	const left = (await page.getByTestId('arrangement').boundingBox())!.x;

	await rail(page).getByRole('button', { name: 'Timelines' }).click();
	await expect(browser(page)).toBeVisible();
	expect((await page.getByTestId('arrangement').boundingBox())!.x).toBe(left); // Over the page, not beside it
	await page.keyboard.press('Escape');
	await expect(browser(page)).toHaveCount(0);

	await page.getByRole('button', { name: 'Browser' }).click();
	await expect(browser(page)).toBeVisible();
	await page.getByTestId('status').click();
	await expect(browser(page)).toHaveCount(0);

	await page.keyboard.press('b');
	await browser(page).getByRole('link', { name: 'Ballad' }).click();
	await expect(page).toHaveURL(/timeline=ballad/);
	await expect(browser(page)).toHaveCount(0);
	await expect(rail(page)).toBeVisible();
});

test('the piano roll has room in the Song view', async ({ page }) => {
	// The roll was 100 px or so when the patch editor shared the page.
	await page.goto('/?timeline=ballad');
	await expect.poll(async () => (await rollView(page)).height).toBeGreaterThan(300);
	// Two tracks, and a lane under the notes
	await page.goto('/?timeline=song');
	await expect.poll(async () => (await rollView(page)).height).toBeGreaterThan(250);
});
