import { expect, type Page } from '@playwright/test';

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
// its song from nothing empties it first, through its JSON, which leaves it as a new timeline was before there was a template.
export async function emptyNewSong(page: Page) {
	const tabs = page.getByRole('tablist', { name: 'Timeline views' });
	await tabs.getByRole('tab', { name: /^JSON/ }).click();
	await page.getByLabel('Timeline JSON').fill(JSON.stringify(EMPTY, null, 1));
	await tabs.getByRole('tab', { name: /^Notes/ }).click();
	await expect(page.getByTestId('track-1')).toHaveCount(0);
}
