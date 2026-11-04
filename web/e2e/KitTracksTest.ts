import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from './Fixtures.ts';
import { clickStill, rollPoint } from './Pointer.ts';
import { undoButton } from './Chrome.ts';

// Wide enough that the browser sits beside the page and the inspector is open.
test.use({ viewport: { width: 1440, height: 900 } });

const notes = (page: Page) => page.locator('[data-testid^="note-"]');
const kitLine = (page: Page) => page.getByTestId('track-kit');

// Two sounds on two keys the top bar's keys reach without moving: K plays 60 and L plays 62 (KeyboardKeys.ts). 64 has none.
const KIT = [
	{ note: 60, name: 'Kick', slot: 0 },
	{ note: 62, name: 'Snare', slot: 1 }
];

// The standard kit as GeneralMidi.ts's standardKit() makes it from the table the app was built with: a slot for each of the
// set's drums, and each key one plays. Empty while the set has none, which this branch's own tests run with.
function standardKit() {
	const path = resolve(import.meta.dirname, '../../examples/Instruments/GeneralMidi.json');
	const table = JSON.parse(readFileSync(path, 'utf8')) as {
		prefix: string;
		drums: { note: number; name: string; instrument: string | null }[];
	};
	const slots: string[] = [];
	const kit: { note: number; slot: number }[] = [];
	for (const drum of table.drums) {
		if (!drum.instrument) continue;
		const patch = `${table.prefix}${drum.instrument}`;
		let slot = slots.indexOf(patch);
		if (slot < 0) slot = slots.push(patch) - 1;
		kit.push({ note: drum.note, slot });
	}
	return { slots, kit };
}

// A new song whose track is a kit track, made by editing its JSON, as nothing else in the app makes one while the set is
// empty, and changed further by `more` if it is given. Its four-bar clip is open in the roll.
async function kitSong(
	page: Page,
	name: string,
	more: (doc: { tracks: Record<string, unknown>[] }) => void = () => {}
) {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByRole('button', { name: 'New song', exact: true }).click(); // Its + opens the field
	await page.getByLabel('New song name').fill(name);
	await page.getByLabel('New song name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByLabel('Song name', { exact: true })).toHaveValue(name);
	const tabs = page.getByRole('tablist', { name: 'Song views' });
	await tabs.getByRole('tab', { name: /^JSON/ }).click();
	const json = page.getByLabel('Song JSON');
	const doc = JSON.parse(await json.inputValue());
	doc.tracks[0] = { ...doc.tracks[0], name: 'Drums', slots: ['builtin-FurElise-piano', 'lead'], kit: KIT };
	more(doc);
	await json.fill(JSON.stringify(doc, null, 1));
	await tabs.getByRole('tab', { name: /^Notes/ }).click();
	await expect(page.getByTestId('roll')).toBeVisible();
	await expect(kitLine(page).getByTestId('kit-sounds')).toHaveText('Kit: 2 sounds');
}

test('the roll names a kit track’s keys, dims those with no sound, and each note drawn or moved plays its key’s slot', async ({
	page
}) => {
	await kitSong(page, 'Kit roll');
	await expect(page.getByTestId('key-name-60')).toHaveText('60 Kick');
	await expect(page.getByTestId('key-name-62')).toHaveText('62 Snare');
	await expect(page.getByTestId('key-62')).toHaveAttribute('data-sound', 'Snare');
	await expect(page.getByTestId('key-64')).toHaveAttribute('data-sound', '');
	await expect(page.getByTestId('key-64')).toHaveClass(/nosound/);
	await expect(page.getByTestId('key-name-64')).toHaveCount(0);

	// The ghost names the sound a click would add, and the note plays its key's slot.
	const snare = await rollPoint(page, 0, 62);
	await page.mouse.move(snare.x, snare.y);
	await expect(page.getByTestId('ghost')).toHaveText('62 Snare · 1/4 · 1.1.000');
	await clickStill(page, snare);
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-slot', '1');
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-sound', 'Snare');
	await expect(page.getByTestId('note-sound')).toHaveText('Snare');
	await expect(page.getByLabel('Note slot')).toBeDisabled(); // The kit chooses it
	await clickStill(page, await rollPoint(page, 480, 60));
	await expect(page.getByTestId('note-1')).toHaveAttribute('data-slot', '0');

	// Moved onto the snare, the kick plays the snare's slot.
	await page.keyboard.press('ArrowUp');
	await page.keyboard.press('ArrowUp');
	await expect(page.getByTestId('note-1')).toHaveAttribute('data-note', '62');
	await expect(page.getByTestId('note-1')).toHaveAttribute('data-slot', '1');

	// Moved to a key with no sound, it is greyed and keeps the slot it had, which can then be chosen.
	await page.keyboard.press('ArrowUp');
	await page.keyboard.press('ArrowUp');
	await expect(page.getByTestId('note-1')).toHaveAttribute('data-note', '64');
	await expect(page.getByTestId('note-1')).toHaveClass(/nosound/);
	await expect(page.getByTestId('note-1')).toHaveAttribute('data-slot', '1');
	await expect(page.getByTestId('note-sound')).toHaveText('no sound');
	await expect(page.getByLabel('Note slot')).toBeEnabled();

	// The key column's menu chooses every note of a sound, by its name.
	await page.getByTestId('key-62').click({ button: 'right' });
	await expect(page.getByRole('menuitem', { name: 'Choose every Snare' })).toBeEnabled();
	await page.keyboard.press('Escape');
});

test('step entry on a kit track writes each key’s slot, and the keys say what each plays', async ({ page }) => {
	await kitSong(page, 'Kit steps');
	await expect(page.getByRole('button', { name: 'D4', exact: true })).toHaveAttribute('title', 'D4, Snare (L)');
	await expect(page.getByRole('button', { name: 'E4', exact: true })).toHaveAttribute('title', 'E4, no sound (;)');
	await page.keyboard.press('r');
	await expect(page.getByTestId('step-cursor')).toHaveAttribute('data-tick', '0');
	await page.keyboard.press('l');
	await expect(notes(page)).toHaveCount(1);
	await page.keyboard.press('k');
	await expect(notes(page)).toHaveCount(2);
	await expect(page.locator('[data-testid^="note-"][data-note="62"]')).toHaveAttribute('data-slot', '1');
	await expect(page.locator('[data-testid^="note-"][data-note="60"]')).toHaveAttribute('data-slot', '0');
	// ↑ fixes the last step's key, and its sound with it.
	await page.keyboard.press('ArrowUp');
	await page.keyboard.press('ArrowUp');
	await expect(page.locator('[data-testid^="note-"][data-note="62"]')).toHaveCount(2);
	await expect(page.locator('[data-testid^="note-"][data-slot="1"]')).toHaveCount(2);
});

test('Not a kit keeps the slots and notes, and undoes as one step', async ({ page }) => {
	await kitSong(page, 'Not a kit');
	await clickStill(page, await rollPoint(page, 0, 62));
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-slot', '1');

	await kitLine(page).getByRole('button', { name: 'Not a kit' }).click();
	await expect(kitLine(page).getByTestId('kit-sounds')).toHaveCount(0);
	await expect(page.getByTestId('key-name-62')).toHaveCount(0);
	await expect(page.getByTestId('key-62')).not.toHaveAttribute('data-sound');
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-slot', '1');
	await expect(page.getByLabel('Patch slot 2', { exact: true })).toBeVisible();

	await undoButton(page).click();
	await expect(kitLine(page).getByTestId('kit-sounds')).toHaveText('Kit: 2 sounds');
	await expect(page.getByTestId('key-name-62')).toHaveText('62 Snare');

	// The track's menu has it too, while the track is a kit.
	await page.getByTestId('track-1').click({ button: 'right' });
	await page.getByRole('menu', { name: 'Track Drums' }).getByRole('menuitem', { name: 'Not a kit' }).click();
	await expect(kitLine(page).getByTestId('kit-sounds')).toHaveCount(0);
});

test('Use the standard kit sets the track’s slots and kit and reslots its notes, as one undo step', async ({
	page
}) => {
	const standard = standardKit();
	await kitSong(page, 'Standard kit');
	await page.getByTestId('track-1').click({ button: 'right' });
	const menu = page.getByRole('menu', { name: 'Track Drums' });
	const use = menu.getByRole('menuitem', { name: 'Use the standard kit' });
	if (!standard.slots.length) {
		// The set has no drums yet: the item is greyed, and the menu says why, as does the inspector's button.
		await expect(use).toBeDisabled();
		await expect(menu).toContainText('The standard set has no drums yet');
		await page.keyboard.press('Escape');
		await expect(kitLine(page).getByRole('button', { name: 'Use the standard kit' })).toBeDisabled();
		return;
	}
	await page.keyboard.press('Escape');

	// A note on a key the standard kit has a sound for, and one on a key it hasn't: the second keeps its slot.
	const key = standard.kit.find((k) => k.slot > 0) ?? standard.kit[0];
	const sounds = new Set(standard.kit.map((k) => k.slot)).size;
	await clickStill(page, await rollPoint(page, 0, 62));
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-slot', '1');
	await clickStill(page, await rollPoint(page, 480, key.note));
	await expect(page.getByTestId('note-1')).toHaveAttribute('data-sound', '');

	await page.getByTestId('track-1').click({ button: 'right' });
	await page.getByRole('menu', { name: 'Track Drums' }).getByRole('menuitem', { name: 'Use the standard kit' }).click();
	await expect(kitLine(page).getByTestId('kit-sounds')).toHaveText(`Kit: ${sounds} sound${sounds === 1 ? '' : 's'}`);
	await expect(page.getByLabel('Patch slot 1', { exact: true })).toHaveAttribute('data-patch', standard.slots[0]);
	await expect(page.getByLabel(`Patch slot ${standard.slots.length}`, { exact: true })).toHaveAttribute(
		'data-patch',
		standard.slots.at(-1)!
	);
	await expect(page.getByTestId('note-1')).toHaveAttribute('data-slot', String(key.slot));
	await expect(page.getByTestId('note-1')).not.toHaveAttribute('data-sound', '');
	await expect(page.getByLabel('Voices', { exact: true })).toHaveValue('32'); // Room for the cymbals' tails
	await expect(page.getByLabel('Stolen voices', { exact: true })).toHaveValue('fade');
	const kept = standard.kit.some((k) => k.note === 62) ? null : '1';
	if (kept) await expect(page.getByTestId('note-0')).toHaveAttribute('data-slot', kept);
	// It plays the standard kit already, so there is nothing more for it to do.
	await expect(kitLine(page).getByRole('button', { name: 'Use the standard kit' })).toBeDisabled();

	// One undo takes it all back.
	await undoButton(page).click();
	await expect(kitLine(page).getByTestId('kit-sounds')).toHaveText('Kit: 2 sounds');
	await expect(page.getByTestId('note-1')).toHaveAttribute('data-sound', '');
	await expect(page.getByLabel('Patch slot 1', { exact: true })).toHaveAttribute(
		'data-patch',
		'builtin-FurElise-piano'
	);
	await expect(page.getByLabel('Patch slot 3', { exact: true })).toHaveCount(0);
	await expect(page.getByLabel('Voices', { exact: true })).toHaveValue('8');

	// The inspector's button does the same.
	await kitLine(page).getByRole('button', { name: 'Use the standard kit' }).click();
	await expect(kitLine(page).getByTestId('kit-sounds')).toHaveText(`Kit: ${sounds} sound${sounds === 1 ? '' : 's'}`);
	await expect(page.getByTestId('note-1')).toHaveAttribute('data-slot', String(key.slot));
});

test('the Score view on a kit track says the roll is where drums are written, and names each note’s sound', async ({
	page
}) => {
	await kitSong(page, 'Kit score');
	await clickStill(page, await rollPoint(page, 0, 62));
	await page.getByRole('group', { name: 'Show the notes as' }).getByRole('button', { name: 'Score' }).click();
	await expect(page.getByTestId('score-kit')).toContainText('The roll names each key');
	const written = page.getByTestId('score-page').locator('[data-notes="0"]');
	await written.click();
	await expect(page.getByTestId('score-told')).toHaveText(/^D4 · Snare · /);
	// ↑ in the score moves it onto a key with no sound, and it keeps its slot.
	await page.keyboard.press('ArrowUp');
	await expect(page.getByTestId('score-told')).toHaveText(/ · no sound · /);
	await page.getByRole('group', { name: 'Show the notes as' }).getByRole('button', { name: 'Roll' }).click();
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-note', '63');
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-slot', '1');
});

test('a clip on a kit track and an ordinary one plays the kit’s slots on both, and the inspector says so', async ({
	page
}) => {
	await kitSong(page, 'Kit shared', (doc) => {
		doc.tracks.push({ ...doc.tracks[0], id: 2, name: 'Keys', slots: ['lead', 'builtin-FurElise-piano'] });
		delete doc.tracks[1].kit;
	});
	await expect(page.getByTestId('clip-kit-shared')).toHaveText(
		"Its notes play the slots Drums's kit gives their keys, on Keys too."
	);
	// Opened from the ordinary track, the roll still names the keys by the kit its notes play.
	await page.getByTestId('placement-2-0').locator('rect').first().click();
	await expect(page.getByTestId('key-name-62')).toHaveText('62 Snare');
	await clickStill(page, await rollPoint(page, 0, 62));
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-slot', '1');
});
