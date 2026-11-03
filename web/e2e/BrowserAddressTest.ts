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

// A 1280 by 800 laptop, the smallest screen the editor is laid out for, where the browser opens over the page from its rail.
test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });
const rail = (page: Page) => page.getByRole('toolbar', { name: 'Library and examples' });
const shows = (page: Page, view: 'song' | 'patch') =>
	expect(page.getByTestId(`view-${view}`)).toHaveAttribute('aria-selected', 'true');
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Song views' });
const songTab = (page: Page, name: RegExp | string) => tabs(page).getByRole('tab', { name });
const chosen = (page: Page, track: number) =>
	expect(page.getByTestId(`track-${track}`)).toHaveAttribute('aria-pressed', 'true');
const params = (page: Page) => new URL(page.url()).searchParams;

// How tall the browser's content is, to the end of its last list, how tall the box it scrolls in, and how much of the content
// isn't the lists' entries, which is what the browser itself takes, however much the library holds.
const measure = (page: Page) =>
	browser(page).evaluate((nav) => {
		const scroll = nav.querySelector<HTMLElement>('.scroll')!;
		const last = scroll.lastElementChild!;
		const content =
			last.getBoundingClientRect().bottom +
			parseFloat(getComputedStyle(last).marginBottom) +
			parseFloat(getComputedStyle(scroll).paddingBottom) -
			scroll.getBoundingClientRect().top +
			scroll.scrollTop;
		const entries = [...scroll.querySelectorAll('li')]
			.filter((li) => li.checkVisibility())
			.reduce((sum, li) => sum + li.getBoundingClientRect().height, 0);
		return {
			content: Math.round(content),
			box: scroll.clientHeight,
			own: Math.round(content - entries),
			width: Math.round(nav.getBoundingClientRect().width)
		};
	});

test('the browser is narrow, and short enough for a laptop with the examples shut', async ({ page }) => {
	await page.goto('/?timeline=song');
	await rail(page).getByRole('button', { name: 'Songs' }).click();
	await expect(browser(page)).toBeVisible();
	// What each list is for is behind its ?, and what makes something behind its +
	await expect(browser(page).getByText("Every example's patches")).toHaveCount(0);
	await expect(browser(page).getByText('Short pieces that ship with the app')).toHaveCount(0);
	await expect(browser(page).getByRole('textbox')).toHaveCount(0);
	const size = await measure(page);
	test.info().annotations.push({ type: 'browser at 1280×800', description: JSON.stringify(size) });
	expect(size.width).toBe(220);
	// Before, the browser took 699 px of its own beside its lists, and 874 px of content in a 725 px box with the demo library.
	expect(size.own).toBeLessThan(480);

	const about = browser(page).getByRole('button', { name: 'About samples' });
	await about.click();
	await expect(about).toHaveAttribute('aria-expanded', 'true');
	await expect(browser(page).getByText('WAV files become one playable instrument')).toBeVisible();
	await about.click();
	await expect(browser(page).getByText('WAV files become one playable instrument')).toHaveCount(0);
	await browser(page).getByRole('button', { name: 'About examples' }).click();
	await expect(browser(page).getByText('Short pieces that ship with the app')).toBeVisible();
});

test('the + in Timelines makes a timeline, and Esc closes its field', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 }); // The browser beside the page
	await page.goto('/?timeline=song');
	const add = browser(page).getByRole('button', { name: 'New song', exact: true });
	const field = browser(page).getByLabel('New song name');
	await expect(field).toHaveCount(0);

	await add.click();
	await expect(add).toHaveAttribute('aria-expanded', 'true');
	await expect(field).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(field).toHaveCount(0);
	await expect(add).toBeFocused();
	await add.click();
	await expect(field).toBeFocused();
	await add.click(); // Again, it closes
	await expect(field).toHaveCount(0);

	await add.click();
	await field.fill('Made by the plus');
	await field.press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== 'song');
	await expect(page.getByLabel('Song name', { exact: true })).toHaveValue('Made by the plus');
	await expect(browser(page).getByRole('link', { name: 'Made by the plus' })).toHaveAttribute('aria-current', 'page');
	await expect(field).toHaveCount(0);
	await expect(add).toHaveAttribute('aria-expanded', 'false');
});

test('a track, a clip and the Mixer tab chosen are in the address, and a reload or a link lands there', async ({
	page,
	context
}) => {
	await page.goto('/?timeline=song');
	// None of it is anything the server loads, so choosing costs no round trip
	const loads: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('__data.json')) loads.push(request.url());
	});

	await page.getByTestId('placement-2-0').locator('rect').first().click();
	await expect(songTab(page, /^Notes/)).toHaveText('Notes: pluck-a');
	await expect(page).toHaveURL(/track=2/);
	expect(params(page).get('clip')).toBe('pluck-a');
	await songTab(page, 'Mixer').click();
	await expect(page).toHaveURL(/pane=mixer/);
	expect(loads).toEqual([]);

	await page.reload();
	await expect(songTab(page, 'Mixer')).toHaveAttribute('aria-selected', 'true');
	await chosen(page, 2);
	await songTab(page, /^Notes/).click();
	await expect(songTab(page, /^Notes/)).toHaveText('Notes: pluck-a');
	await expect(page.getByTestId('roll')).toBeVisible();
	await expect(page).not.toHaveURL(/pane=/); // The notes are where a song opens

	// The same address in a new tab
	await songTab(page, 'Mixer').click();
	await expect(page).toHaveURL(/pane=mixer/);
	const other = await context.newPage();
	await other.goto(page.url());
	await other.locator('body[data-hydrated]').waitFor({ state: 'attached' });
	await expect(songTab(other, 'Mixer')).toHaveAttribute('aria-selected', 'true');
	await chosen(other, 2);
	await other.close();

	// The Patch view shows the chosen track's patch, which the address's track says, so a reload keeps it
	await openView(page, 'patch');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Sampled pluck');
	await page.reload();
	await shows(page, 'patch');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Sampled pluck');
});

test('Back goes to the view before, not through every track and tab chosen since', async ({ page }) => {
	await page.goto('/?timeline=song');
	await chosen(page, 1);
	// Nothing here, Back and Forward included, is anything the server loads
	const loads: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('__data.json')) loads.push(request.url());
	});
	await openView(page, 'patch');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Stereo lead');
	await openView(page, 'song');

	await page.getByTestId('placement-2-0').locator('rect').first().click();
	await expect(page).toHaveURL(/track=2/);
	await page.getByTestId('placement-1-0').locator('rect').first().click();
	await expect(page).toHaveURL(/track=1/);
	await page.getByTestId('placement-2-0').locator('rect').first().click();
	await expect(page).toHaveURL(/track=2/);
	await songTab(page, 'Mixer').click();
	await expect(page).toHaveURL(/pane=mixer/);

	// Back to the Patch view as it was, on the patch of the track chosen then
	await page.goBack();
	await shows(page, 'patch');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Stereo lead');
	// Forward to the song as it was left
	await page.goForward();
	await shows(page, 'song');
	await expect(songTab(page, 'Mixer')).toHaveAttribute('aria-selected', 'true');
	await chosen(page, 2);
	// And Back twice to where it started, before anything was chosen
	await page.goBack();
	await shows(page, 'patch');
	await page.goBack();
	await shows(page, 'song');
	await expect(songTab(page, /^Notes/)).toHaveAttribute('aria-selected', 'true');
	await expect(songTab(page, /^Notes/)).toHaveText('Notes: lead-a');
	await chosen(page, 1);
	expect(loads).toEqual([]);
});

test('an old link still opens, and what an address names that the song has not got is passed over', async ({
	page
}) => {
	// A patch alone opens it in the Patch view, as links did before there were views
	await page.goto('/?patch=lead');
	await shows(page, 'patch');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Stereo lead');
	await page.goto('/?timeline=song&patch=pluck');
	await shows(page, 'patch');
	await expect(page.getByLabel('Patch name', { exact: true })).toHaveValue('Sampled pluck');

	// A track, a clip and a tab the song hasn't got leave the song as it opens anyway
	await page.goto('/?timeline=song&track=9&clip=nowhere&pane=bogus');
	await shows(page, 'song');
	await expect(songTab(page, /^Notes/)).toHaveAttribute('aria-selected', 'true');
	await expect(songTab(page, /^Notes/)).toHaveText('Notes: lead-a');
	await chosen(page, 1);

	// A clip on its own is shown, chosen where it is placed, and a clip placed nowhere is shown all the same
	await page.goto('/?timeline=song&clip=pluck-a');
	await expect(songTab(page, /^Notes/)).toHaveText('Notes: pluck-a');
	await chosen(page, 2);
	await page.goto('/?timeline=song&clip=never-placed&pane=json');
	await expect(songTab(page, 'JSON')).toHaveAttribute('aria-selected', 'true');
	await expect(songTab(page, /^Notes/)).toHaveText('Notes: never-placed');
});

test("a patch's tooltip in the browser counts the song's unsaved edits", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 }); // The browser beside the page
	await page.goto('/?timeline=song');
	const square = browser(page).getByRole('link', { name: /^Square/ });
	await expect(square).toHaveAttribute('title', 'Not used by a song');

	// Lead plays it instead, unsaved
	await songTab(page, 'JSON').click();
	const json = page.getByLabel('Song JSON');
	const doc = JSON.parse(await json.inputValue());
	doc.tracks[0].slots = ['unused'];
	await json.fill(JSON.stringify(doc, null, 1));
	await expect(page.getByTestId('unsaved')).toBeVisible();
	await square.hover();
	await expect(square).toHaveAttribute('title', 'Used by Song');
});
