import { expect, type Page } from './Fixtures.ts';

// The top bar's controls, which other tests reach for too.

// The one Undo and Redo pair, which acts on the view on screen. The editors have none of their own.
export const undoButton = (page: Page) =>
	page.getByRole('group', { name: 'Undo and redo' }).getByRole('button', { name: 'Undo' });
export const redoButton = (page: Page) =>
	page.getByRole('group', { name: 'Undo and redo' }).getByRole('button', { name: 'Redo' });

// A key of the on-screen piano, which is named by its note: 60 is C4.
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const pianoKey = (page: Page, note: number) =>
	page.getByRole('button', { name: `${NAMES[note % 12]}${Math.floor(note / 12) - 1}`, exact: true });

// The loop's button, beside Play and Stop.
export const loopButton = (page: Page) => page.getByRole('button', { name: 'Loop', exact: true });

// The Song tab's ▾ menu, which holds what is done to the song as a whole, opened and an item chosen from it.
export async function fromSongMenu(page: Page, item: string) {
	await page.getByRole('button', { name: 'Song menu' }).click();
	await page.getByRole('menuitem', { name: item }).click();
}

// The compile light's list of problems, opened.
export async function openLight(page: Page) {
	const light = page.getByTestId('status').getByRole('button', { name: /^Compile status/ });
	if ((await light.getAttribute('aria-expanded')) !== 'true') await light.click();
	const list = page.getByRole('region', { name: 'Compile status' });
	await expect(list).toBeVisible();
	return list;
}

// Audio starts with the page's first click or key, which is when a browser lets it. A test that wants it before it does
// anything else clicks the top bar's edge, where nothing else answers a click.
export async function startAudio(page: Page) {
	await page.locator('header.topbar').click({ position: { x: 2, y: 2 } });
	await expect(page.getByTestId('state')).toBeAttached({ timeout: 10000 });
}
