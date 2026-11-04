import { expect, type Page } from './Fixtures.ts';

// A new timeline as it was before there was a template, with every default written out, as a saved one has them.
const EMPTY = {
	ppq: 480,
	tempo: [{ tick: 0, bpm: 120 }],
	clips: [],
	tracks: [],
	buses: [],
	master: { gain: 1, inserts: [] },
	globals: {}
};

// New timeline makes the template, a track with a built-in patch and an empty four-bar clip (Template.ts). A test that builds
// its song from nothing empties it first, through its JSON, and saves it and loads the page again, which leaves it as a new
// timeline was before there was a template: saved, with no undo behind it, and no clip seen yet whose view a new one of the
// same name would come back to.
export async function emptyNewSong(page: Page) {
	const tabs = page.getByRole('tablist', { name: 'Song views' });
	await tabs.getByRole('tab', { name: /^JSON/ }).click();
	await page.getByLabel('Song JSON').fill(JSON.stringify(EMPTY, null, 1));
	await expect(page.getByTestId('unsaved')).toBeVisible();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await page.reload();
	await page.locator('body[data-hydrated]').waitFor({ state: 'attached' });
	await expect(page.getByTestId('arrangement')).toBeVisible();
	await expect(page.getByTestId('track-1')).toHaveCount(0);
}

// + Track comes with a four-bar clip, open in the roll. A test that counts from a one-bar clip at the roll's first zoom, as a
// double-click on an empty row makes, deletes that clip and makes this one.
export async function oneBarClip(page: Page, track = 1) {
	await page.getByTestId(`placement-${track}-0`).locator('rect').first().click({ button: 'right' });
	await page
		.getByRole('menu', { name: /^Clip / })
		.getByRole('menuitem', { name: 'Delete clip' })
		.click();
	await expect(page.getByTestId(`placement-${track}-0`)).toHaveCount(0);
	const row = (await page.getByTestId(`row-${track}`).boundingBox())!;
	await page.mouse.dblclick(row.x + 10, row.y + 20);
	await expect(page.getByTestId(`placement-${track}-0`)).toBeVisible();
	await expect(page.getByTestId('roll')).toBeVisible();
}
