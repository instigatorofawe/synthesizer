import { expect, test, type Page } from './Fixtures.ts';
import { clickStill, rollPoint } from './Pointer.ts';
import { oneBarClip } from './NewSong.ts';
import { loudest, newestPlays } from './Engine.ts';
import { openView } from './Views.ts';

// Wide enough that the browser, where a new timeline is made, sits beside the page.
test.use({ viewport: { width: 1440, height: 900 } });

const BAR = 1920; // Ticks in a bar at a new timeline's 480 ppq
// The piano keys by where they are, as KeyboardKeys.ts has them, from the lowest C shown, which is C3.
const C = 48;
const notes = (page: Page) => page.locator('[data-testid^="note-"]');
const cursor = (page: Page) => page.getByTestId('step-cursor');
const toggle = (page: Page) => page.getByRole('button', { name: 'Step', exact: true });

// What the clip holds, as tick, pitch, length and velocity, in tick and then pitch order.
async function written(page: Page) {
	const all = await notes(page).evaluateAll((found) =>
		found.map((note) => ['tick', 'note', 'dur', 'vel'].map((name) => Number(note.getAttribute(`data-${name}`))))
	);
	return all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// A new timeline with a track and a one-bar clip on it, open in the roll. The track is the last, whatever the new timeline
// starts with.
async function stepClip(page: Page, name: string) {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByRole('button', { name: 'New song', exact: true }).click(); // Its + opens the field
	await page.getByLabel('New song name').fill(name);
	await page.getByLabel('New song name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByLabel('Song name', { exact: true })).toHaveValue(name);
	await page.getByRole('button', { name: 'Add track' }).click(); // It asks which patch the track plays
	await page.getByRole('listbox', { name: 'Patches' }).locator('[data-patch="lead"]').click();
	const row = page.locator('[data-testid^="row-"]').last();
	const track = (await row.getAttribute('data-testid'))!.slice('row-'.length);
	await oneBarClip(page, Number(track));
	await expect(page.getByTestId(`placement-${track}-0`)).toBeVisible();
	await expect(page.getByTestId('roll')).toBeVisible();
	return track;
}

test('R and the Step toggle turn step entry on and off, and a field or the Patch view keeps its R', async ({
	page
}) => {
	await stepClip(page, 'Toggled');
	await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
	await expect(toggle(page)).toHaveAttribute('title', /\(R\)/);
	await expect(cursor(page)).toHaveCount(0);

	// R works wherever focus is: here it is on the clip just made, in the arrangement.
	await page.keyboard.press('r');
	await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
	await expect(cursor(page)).toHaveAttribute('data-tick', '0');
	await expect(page.getByTestId('step-at')).toHaveText('Step at 1.1.000');
	await expect(page.getByRole('group', { name: 'Keys' })).toHaveAttribute('title', /^Step entry: keys write notes/);
	await page.keyboard.press('r');
	await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
	await expect(cursor(page)).toHaveCount(0);

	await toggle(page).click();
	await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
	await toggle(page).click();
	await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');

	await page.getByLabel('Velocity of the keys').focus();
	await page.keyboard.press('r');
	await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');

	// The Patch view's R and keys are its own: they don't turn step entry on, or write.
	await openView(page, 'patch');
	await page.keyboard.press('r');
	await openView(page, 'song');
	await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
	await toggle(page).click();
	await openView(page, 'patch');
	await page.keyboard.press('a');
	await openView(page, 'song');
	await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
	await expect(notes(page)).toHaveCount(0);
	await expect(cursor(page)).toHaveAttribute('data-tick', '0');
});

test('keys held together write a chord at the cursor, as long as Draw, and it is written as one step once they are let go', async ({
	page
}) => {
	await stepClip(page, 'Chord');
	await page.getByLabel('Draw length').selectOption({ label: '1/8' });
	await page.keyboard.press('r');
	await page.keyboard.down('a'); // C3
	await page.keyboard.down('d'); // E3
	await page.keyboard.down('g'); // G3
	await expect(page.getByTestId('step-note')).toHaveCount(3);
	await expect(notes(page)).toHaveCount(0);
	await page.keyboard.up('a');
	await page.keyboard.up('d');
	await expect(cursor(page)).toHaveAttribute('data-tick', '0');
	await page.keyboard.up('g');
	await expect(notes(page)).toHaveCount(3);
	await expect(cursor(page)).toHaveAttribute('data-tick', '240');
	expect(await written(page)).toEqual([
		[0, C, 240, 100],
		[0, C + 4, 240, 100],
		[0, C + 7, 240, 100]
	]);

	// The next key goes after it, and each step undoes in one go.
	await page.keyboard.press('s'); // D3
	await expect(notes(page)).toHaveCount(4);
	await expect(cursor(page)).toHaveAttribute('data-tick', '480');
	await page.keyboard.press('ControlOrMeta+z');
	await expect(notes(page)).toHaveCount(3);
	await page.keyboard.press('ControlOrMeta+z');
	await expect(notes(page)).toHaveCount(0);
});

test('→ while keys are held makes the held notes a Snap step longer, and the cursor follows them', async ({ page }) => {
	await stepClip(page, 'Lengthened');
	await page.getByLabel('Draw length').selectOption({ label: '1/8' });
	await page.getByLabel('Snap', { exact: true }).selectOption({ label: '1/16' });
	await page.keyboard.press('r');
	await page.keyboard.down('a');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('step-note')).toHaveCount(1);
	await page.keyboard.up('a');
	expect(await written(page)).toEqual([[0, C, 480, 100]]);
	await expect(cursor(page)).toHaveAttribute('data-tick', '480');

	// Only the notes whose keys are still down grow.
	await page.keyboard.down('s'); // D3
	await page.keyboard.down('f'); // F3
	await page.keyboard.up('f');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.up('s');
	await expect(notes(page)).toHaveCount(3);
	expect(await written(page)).toEqual([
		[0, C, 480, 100],
		[480, C + 2, 360, 100],
		[480, C + 5, 240, 100]
	]);
	await expect(cursor(page)).toHaveAttribute('data-tick', '840');
});

test('→ alone rests, Backspace steps back, a click moves the cursor, and neither key moves or deletes anything else', async ({
	page
}) => {
	const track = await stepClip(page, 'Rests');
	await page.keyboard.press('r'); // The Draw length is a 1/4
	await page.keyboard.press('ArrowRight');
	await expect(cursor(page)).toHaveAttribute('data-tick', '480');
	await page.keyboard.press('a');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('d');
	expect(await written(page)).toEqual([
		[480, C, 480, 100],
		[1440, C + 4, 480, 100]
	]);
	await expect(cursor(page)).toHaveAttribute('data-tick', String(BAR));

	// Each Backspace takes back a step: a note, then a rest, then a note.
	await page.keyboard.press('Backspace');
	await expect(cursor(page)).toHaveAttribute('data-tick', '1440');
	expect(await written(page)).toEqual([[480, C, 480, 100]]);
	await page.keyboard.press('Backspace');
	await expect(cursor(page)).toHaveAttribute('data-tick', '960');
	await expect(notes(page)).toHaveCount(1);
	await page.keyboard.press('Backspace');
	await expect(cursor(page)).toHaveAttribute('data-tick', '480');
	await expect(notes(page)).toHaveCount(0);
	await expect(page.getByTestId(`placement-${track}-0`)).toBeVisible(); // Backspace in step entry is about notes

	// A click puts the cursor on the nearest line, and writes nothing. With no step behind it, Backspace moves it back by the
	// Draw length and deletes nothing.
	await page.keyboard.press('a');
	const at = await rollPoint(page, 1440, 60);
	await clickStill(page, at);
	await expect(cursor(page)).toHaveAttribute('data-tick', '1440');
	await expect(notes(page)).toHaveCount(1);
	await page.keyboard.press('Backspace');
	await expect(cursor(page)).toHaveAttribute('data-tick', '960');
	await expect(notes(page)).toHaveCount(1);

	// A note chosen in the roll, with the roll focused, stays where it is: → is step entry's.
	const note = (await page.getByTestId('note-0').locator('.body').boundingBox())!;
	await page.mouse.click(note.x + note.width / 2, note.y + note.height / 2);
	await page.keyboard.press('ArrowRight');
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-tick', '480');
	await expect(cursor(page)).toHaveAttribute('data-tick', '1440');
});

test('a step past the end grows the clip as a clicked note does, or offers to lengthen it, and Backspace takes it back', async ({
	page
}) => {
	const track = await stepClip(page, 'Grown');
	await page.getByLabel('Draw length').selectOption({ label: '1/2' });
	await page.keyboard.press('r');
	await page.keyboard.press('a');
	await page.keyboard.press('s');
	await expect(cursor(page)).toHaveAttribute('data-tick', String(BAR));
	await expect(page.getByLabel('Clip length')).toHaveValue('1 bar');
	await page.keyboard.press('d');
	await expect(page.getByTestId('clip-grown')).toContainText('Clip is now 2 bars');
	await expect(page.getByLabel('Clip length')).toHaveValue('2 bars');
	expect((await written(page)).at(-1)).toEqual([BAR, C + 4, 960, 100]);

	await page.keyboard.press('Backspace');
	await expect(page.getByLabel('Clip length')).toHaveValue('1 bar');
	await expect(notes(page)).toHaveCount(2);
	await expect(cursor(page)).toHaveAttribute('data-tick', String(BAR));

	// With the clip placed again right after it, growing it would run into that placement.
	await page.getByTestId(`placement-${track}-0`).locator('rect').first().click({ button: 'right' });
	await page
		.getByRole('menu', { name: /^Clip / })
		.getByRole('menuitem', { name: 'Duplicate after' })
		.click();
	await expect(page.getByTestId(`placement-${track}-1`)).toHaveAttribute('data-tick', String(BAR));
	await page.keyboard.press('d');
	const offer = page.getByTestId('lengthen-offer');
	await expect(offer).toContainText('would run it into the next clip');
	await expect(notes(page)).toHaveCount(2);
	await expect(page.getByLabel('Clip length')).toHaveValue('1 bar');
	await expect(cursor(page)).toHaveAttribute('data-tick', String(BAR));

	await offer.getByRole('button', { name: 'Lengthen to 2 bars' }).click();
	await expect(notes(page)).toHaveCount(3);
	await expect(page.getByLabel('Clip length')).toHaveValue('2 bars');
	await expect(cursor(page)).toHaveAttribute('data-tick', String(BAR + 960));
});

test('C and V set the velocity of new notes, stepped or clicked, and Mod with them is not theirs', async ({ page }) => {
	await stepClip(page, 'Velocity');
	const velocity = page.getByLabel('Velocity of the keys');
	await expect(velocity).toHaveValue('100');
	await page.keyboard.press('v');
	await expect(velocity).toHaveValue('110');
	await page.keyboard.press('c');
	await page.keyboard.press('c');
	await page.keyboard.press('c');
	await expect(velocity).toHaveValue('80');
	await page.keyboard.press('ControlOrMeta+c');
	await page.keyboard.press('ControlOrMeta+v');
	await expect(velocity).toHaveValue('80');

	await page.keyboard.press('r');
	await page.keyboard.press('a');
	expect(await written(page)).toEqual([[0, C, 480, 80]]);

	await page.keyboard.press('r');
	const at = await rollPoint(page, 960, 60);
	await clickStill(page, at);
	expect((await written(page)).at(-1)).toEqual([960, 60, 480, 80]);

	// Typed, it stays from 1 to 127, and a field keeps its C and V.
	await velocity.fill('300');
	await velocity.press('Enter');
	await expect(velocity).toHaveValue('127');
	await velocity.press('c');
	await expect(velocity).toHaveValue('127');
});

test('Esc closes a menu first, then an offer, then leaves step entry, and then lets go of the chosen notes', async ({
	page
}) => {
	const track = await stepClip(page, 'Escaped');
	await page.keyboard.press('r');
	await page.keyboard.press('a');
	const note = (await page.getByTestId('note-0').locator('.body').boundingBox())!;
	await page.mouse.click(note.x + note.width / 2, note.y + note.height / 2); // Chosen first, as the menu needs
	await page.mouse.click(note.x + note.width / 2, note.y + note.height / 2, { button: 'right' });
	const menu = page.getByRole('menu', { name: 'Note' });
	await expect(menu).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
	await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');

	// An offer, then step entry.
	await page.getByTestId(`placement-${track}-0`).locator('rect').first().click({ button: 'right' });
	await page
		.getByRole('menu', { name: /^Clip / })
		.getByRole('menuitem', { name: 'Duplicate after' })
		.click();
	for (let rest = 0; rest < 3; rest++) await page.keyboard.press('ArrowRight');
	await expect(cursor(page)).toHaveAttribute('data-tick', String(BAR));
	await page.keyboard.press('a');
	await expect(page.getByTestId('lengthen-offer')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('lengthen-offer')).toHaveCount(0);
	await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Escape');
	await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
	await expect(cursor(page)).toHaveCount(0);

	// Out of step entry, the keys only play, and Esc lets go of the chosen note.
	const chosen = (await page.getByTestId('note-0').locator('.body').boundingBox())!;
	await page.mouse.click(chosen.x + chosen.width / 2, chosen.y + chosen.height / 2);
	await expect(page.getByTestId('note-0')).toHaveClass(/chosen/);
	await page.keyboard.press('a');
	await expect(notes(page)).toHaveCount(1);
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('note-0')).not.toHaveClass(/chosen/);
});

test('the keys still sound on the chosen track while they write', async ({ page }) => {
	await page.goto('/?timeline=song');
	await page.getByTestId('placement-2-0').locator('rect').first().click();
	await expect(page.getByRole('group', { name: 'Keys' })).toHaveAttribute('title', /Keys play Pluck\./);
	await expect(notes(page)).toHaveCount(4);
	await page.keyboard.press('r');
	await expect(cursor(page)).toHaveAttribute('data-tick', '0');
	await page.keyboard.down('d'); // E3, which the clip hasn't at its start. It starts audio, as a click on a key does.
	await newestPlays(page);
	// A pluck dies away while its key is held, and the meter holds the loudest since the image began.
	await expect
		.poll(() => loudest(page.getByRole('meter', { name: 'Level of Pluck' })), { timeout: 8000 })
		.toBeGreaterThan(0.01);
	await page.keyboard.up('d');
	await expect(notes(page)).toHaveCount(5);
	await expect(cursor(page)).toHaveAttribute('data-tick', '480');
});
