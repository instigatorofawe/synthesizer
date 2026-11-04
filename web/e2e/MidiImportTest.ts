import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fromSongMenu } from './Chrome.ts';
import { loudest, startAudioNewest } from './Engine.ts';
import { expect, test, type Page } from './Fixtures.ts';
import { cc, meter, midiFile, name, off, on, program, tempo, track } from '../src/lib/MidiWriter.ts';

// MIDI import: a file chosen from the Song menu, or dropped on the arrangement, becomes a song in the library, played on the
// standard set, which opens, and the foot of the page says what it holds and what was left out of it.
test.use({ viewport: { width: 1440, height: 900 } });

const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });
const summary = (page: Page) => page.getByTestId('import-summary');

// A band in format 1: a piano's chords, an organ's long notes and a kit's kicks and snares, each on a track of its own, over
// a conductor track with the tempo, at 480 ticks a quarter.
function band(): Buffer {
	const keys = [program(0, 0, 0), cc(0, 0, 7, 110), name(0, 'Keys')];
	const pad = [program(0, 1, 16), name(0, 'Pad')];
	const kit = [name(0, 'Kit')];
	for (let bar = 0; bar < 2; ++bar) {
		const at = bar * 1920;
		for (const key of [60, 64, 67]) keys.push(on(at, 0, key, 100), off(at + 960, 0, key));
		pad.push(on(at, 1, 48, 90), off(at + 1900, 1, 48));
		for (let beat = 0; beat < 4; ++beat) {
			const drum = beat % 2 ? 38 : 36;
			kit.push(on(at + beat * 480, 9, drum, 110), off(at + beat * 480 + 120, 9, drum));
		}
	}
	const conductor = track([name(0, 'Band'), tempo(0, 100), meter(0, 4, 4)]);
	return Buffer.from(midiFile(1, 480, [conductor, track(keys), track(pad), track(kit)]));
}

// The JSON tab's document, which is the song as saved.
async function songJson(page: Page) {
	const tabs = page.getByRole('tablist', { name: 'Song views' });
	await tabs.getByRole('tab', { name: /^JSON/ }).click();
	const doc = JSON.parse(await page.getByLabel('Song JSON').inputValue());
	await tabs.getByRole('tab', { name: /^Notes/ }).click();
	return doc;
}

async function importFromMenu(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
	const chooser = page.waitForEvent('filechooser');
	await fromSongMenu(page, 'Import MIDI file…');
	await (await chooser).setFiles(file);
}

test('a MIDI file from the Song menu becomes a song in the library, with its tracks and notes, and plays', async ({
	page
}) => {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(e.message));
	await page.goto('/?timeline=song');
	await importFromMenu(page, { name: 'Band.mid', mimeType: 'audio/midi', buffer: band() });

	await expect(summary(page)).toContainText('Band.mid: Imported 3 tracks with 16 notes.');
	await expect(page).not.toHaveURL(/timeline=song\b/);
	await expect(page.getByLabel('Song name', { exact: true })).toHaveValue('Band');
	await expect(browser(page).getByRole('list', { name: 'Songs' }).getByRole('link', { name: 'Band' })).toBeVisible();
	await expect(page.getByTestId('unsaved')).toHaveCount(0); // It is in the library as it was imported
	for (const [id, name] of [
		[1, 'Keys'],
		[2, 'Pad'],
		[3, 'Kit']
	] as const)
		await expect(page.getByTestId(`track-${id}`)).toHaveText(name);

	// Each track's notes, in its one clip, which the roll opens.
	await page.getByTestId('track-1').click();
	await expect(page.getByTestId('roll').locator('[data-testid^="note-"]')).toHaveCount(6);
	await expect(page.getByTestId('note-0')).toHaveAttribute('data-dur', '960');
	await page.getByTestId('track-3').click();
	await expect(page.getByTestId('roll').locator('[data-testid^="note-"]')).toHaveCount(8);

	const doc = await songJson(page);
	expect(doc.ppq).toBe(480);
	expect(doc.tempo).toEqual([{ tick: 0, bpm: 100 }]);
	expect(doc.tracks.map((t: { slots: string[] }) => t.slots.every((s) => s.startsWith('builtin-gm-')))).toEqual([
		true,
		true,
		true
	]);
	expect(doc.tracks[0].gain).toBe(0.7502); // Volume 110, by GM's curve
	expect(doc.tracks[2].kit.map((key: { note: number }) => key.note)).toEqual([36, 38]);

	await startAudioNewest(page);
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect(page.getByTestId('voices')).not.toHaveText('0');
	for (const name of ['Keys', 'Pad', 'Kit'])
		await expect.poll(() => loudest(page.getByRole('meter', { name: `Level of ${name}` }))).toBeGreaterThan(0.005);
	expect(problems).toEqual([]);

	// The summary goes once it is shut.
	await summary(page).getByRole('button', { name: 'Dismiss' }).click();
	await expect(summary(page)).toHaveCount(0);
});

// What the desktop hands a page when a file is dropped on it, made in the page. A system that doesn't know a MIDI file's kind
// gives it none, so the drop goes by its name.
async function fileDropped(page: Page, at: { x: number; y: number }, file: { name: string; bytes: number[] }) {
	const transfer = await page.evaluateHandle(({ name, bytes }) => {
		const files = new DataTransfer();
		files.items.add(new File([new Uint8Array(bytes)], name));
		return files;
	}, file);
	const where = { dataTransfer: transfer, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true };
	await page.getByTestId('arrangement-view').dispatchEvent('dragover', where);
	await page.getByTestId('arrangement-view').dispatchEvent('drop', where);
}

test('a MIDI file dropped on the arrangement is imported as a song of its own, from an example too', async ({
	page
}) => {
	await page.goto('/?recipe=Kick808');
	const row = (await page.getByTestId('row-1').boundingBox())!;
	const score = resolve(import.meta.dirname, '../../examples/Pieces/Scores/FurElise.mid');
	await fileDropped(page, { x: row.x + 40, y: row.y + 20 }, { name: 'FurElise.mid', bytes: [...readFileSync(score)] });

	await expect(summary(page)).toContainText('FurElise.mid: Imported 2 tracks with 905 notes.');
	await expect(page).toHaveURL(/timeline=/);
	await expect(page.getByLabel('Song name', { exact: true })).toHaveValue('FurElise');
	await expect(page.getByTestId('track-1')).toHaveText('up:');
	await expect(page.getByTestId('track-2')).toHaveText('down:');
	const doc = await songJson(page);
	expect(doc.meter).toEqual([{ tick: 0, beats: 3, unit: 8 }]);
	expect(doc.key).toEqual([{ tick: 0, fifths: 0, minor: true }]);
});

test('a MIDI file held over the arrangement says a drop imports it', async ({ page }) => {
	await page.goto('/?timeline=song');
	const row = (await page.getByTestId('row-1').boundingBox())!;
	const transfer = await page.evaluateHandle(() => {
		const files = new DataTransfer();
		files.items.add(new File([new Uint8Array([0x4d, 0x54, 0x68, 0x64])], 'Tune.mid', { type: 'audio/midi' }));
		return files;
	});
	await page.getByTestId('arrangement-view').dispatchEvent('dragover', {
		dataTransfer: transfer,
		clientX: row.x + 40,
		clientY: row.y + 20,
		bubbles: true,
		cancelable: true
	});
	await expect(page.getByTestId('midi-drop')).toHaveText('Import as a new song');
	await expect(page.getByTestId('new-track-row')).toHaveCount(0); // Nothing goes in this song
	await page.getByTestId('arrangement-view').dispatchEvent('drop', { dataTransfer: transfer, bubbles: true });
	await expect(page.getByTestId('midi-drop')).toHaveCount(0);
});

test("a file that isn't MIDI is refused with why, and the song stays open", async ({ page }) => {
	await page.goto('/?timeline=song');
	await importFromMenu(page, { name: 'Notes.mid', mimeType: 'audio/midi', buffer: Buffer.from('Not a tune') });
	await expect(
		page.getByText("Notes.mid can't be imported. It isn't a Standard MIDI File: those start with MThd.")
	).toBeVisible();
	await expect(page).toHaveURL(/timeline=song\b/);
	await expect(summary(page)).toHaveCount(0);
});
