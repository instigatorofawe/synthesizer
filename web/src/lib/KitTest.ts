import { describe, expect, it } from 'vitest';
import {
	clipKit,
	dropKit,
	keyText,
	kitKeys,
	playsKit,
	standardKitWhy,
	kitSounds,
	kitStrangers,
	noteText,
	slotNotes,
	soundsText,
	useKit,
	withKitSlots,
	type Kit
} from '#lib/Kit.ts';
import { EMPTY_TIMELINE, type Timeline } from '#lib/Schema.ts';
import {
	addClip,
	addTrack,
	moveNotes,
	movePlacement,
	place,
	setClip,
	setTrack,
	type Clip,
	type Note
} from '#lib/TimelineEdit.ts';

// Two sounds on four keys, as a small kit has them: two kicks on slot 0 and two snares on slot 1.
const KIT: Kit = [
	{ note: 35, name: 'Acoustic Bass Drum', slot: 0 },
	{ note: 36, name: 'Bass Drum 1', slot: 0 },
	{ note: 38, name: 'Acoustic Snare', slot: 1 },
	{ note: 40, name: 'Electric Snare', slot: 1 }
];

const note = (tick: number, pitch: number, slot?: number): Note => ({
	tick,
	note: pitch,
	vel: 100,
	dur: 120,
	...(slot === undefined ? {} : { slot })
});

// A song with a kit track and an ordinary one, and a clip on the kit track holding `notes`.
function song(notes: Note[] = []): Timeline {
	const drums = addTrack(EMPTY_TIMELINE, 'kick');
	let doc = setTrack(drums.doc, drums.id, { slots: ['kick', 'snare'], kit: KIT, name: 'Drums' });
	doc = addTrack(doc, 'lead').doc;
	const clip = addClip(doc, 1920);
	doc = place(clip.doc, drums.id, clip.id, 0);
	return setClip(doc, clip.id, { ...doc.clips[0], notes });
}

const clipOf = (doc: Timeline, id = 'clip'): Clip => doc.clips.find((c) => c.id === id)!;

describe('every note on a kit track plays its key’s slot', () => {
	it('gives each note its key’s slot, and leaves one with no sound on its key as it was', () => {
		const doc = withKitSlots(song([note(0, 38), note(120, 36, 1), note(240, 50, 1), note(360, 40, 1)]));
		expect(clipOf(doc).notes.map((n) => n.slot)).toEqual([1, 0, 1, 1]);
	});

	it('comes back as it was when nothing changes, so an edit that changed nothing still changes nothing', () => {
		const right = song([note(0, 38, 1), note(120, 36), note(240, 50, 3)]);
		expect(withKitSlots(right)).toBe(right);
		const plain = addTrack(EMPTY_TIMELINE, 'lead').doc;
		expect(withKitSlots(plain)).toBe(plain);
	});

	it('keeps every note it doesn’t change, and every clip off kit tracks', () => {
		const doc = song([note(0, 38), note(120, 36)]);
		const off = addClip(doc, 960);
		const withOff = setClip(off.doc, off.id, { ...clipOf(off.doc, off.id), notes: [note(0, 38)] });
		const next = withKitSlots(withOff);
		expect(clipOf(next).notes[1]).toBe(clipOf(withOff).notes[1]);
		expect(clipOf(next, off.id)).toBe(clipOf(withOff, off.id));
	});

	it('writes a note’s slot once the note moves onto another sound, or onto a key with none', () => {
		const doc = withKitSlots(song([note(0, 38), note(120, 40)]));
		const moved = withKitSlots(setClip(doc, 'clip', moveNotes(clipOf(doc), new Set([0, 1]), 0, -2)));
		expect(clipOf(moved).notes.map((n) => [n.note, n.slot ?? 0])).toEqual([
			[36, 0],
			[38, 1]
		]);
		const off = withKitSlots(setClip(moved, 'clip', moveNotes(clipOf(moved), new Set([1]), 0, 3))); // 41: no sound
		expect(clipOf(off).notes[1]).toMatchObject({ note: 41, slot: 1 });
	});

	it('reslots a clip moved onto a kit track, and leaves one moved off it as it was', () => {
		const doc = song([note(0, 38)]);
		const off = movePlacement(doc, 1, 0, 2, 0);
		expect(withKitSlots(off)).toBe(off);
		const back = withKitSlots(movePlacement(off, 2, 0, 1, 0));
		expect(clipOf(back).notes[0].slot).toBe(1);
	});

	it('takes a clip on two kit tracks from the first in the song’s order, and one on an ordinary track too from the kit', () => {
		const other: Kit = [{ note: 38, name: 'Clap', slot: 2 }];
		let doc = song([note(0, 38)]);
		const second = addTrack(doc, 'clap');
		doc = setTrack(second.doc, second.id, { slots: ['kick', 'snare', 'clap'], kit: other });
		doc = place(doc, second.id, 'clip', 0);
		doc = place(doc, 2, 'clip', 0); // The ordinary track
		expect(clipOf(withKitSlots(doc)).notes[0].slot).toBe(1);
		expect(clipKit(doc, 'clip')?.track.name).toBe('Drums');
		expect(kitStrangers(doc, 'clip').map((t) => t.id)).toEqual([2, second.id]);

		// With the kit tracks the other way round, the other kit decides.
		const swapped = { ...doc, tracks: [...doc.tracks].reverse() };
		expect(clipOf(withKitSlots(swapped)).notes[0].slot).toBe(2);
	});

	it('says no track is a stranger when every track placing the clip has the same kit', () => {
		let doc = song([note(0, 38)]);
		const twin = addTrack(doc, 'kick');
		doc = setTrack(twin.doc, twin.id, { slots: ['kick', 'snare'], kit: KIT });
		doc = place(doc, twin.id, 'clip', 0);
		expect(kitStrangers(doc, 'clip')).toEqual([]);
		expect(clipKit(addClip(doc, 480).doc, 'clip-2')).toBeNull();
	});

	it('slots a clip by a key-to-slot map, as a clip on its own', () => {
		const clip = clipOf(song([note(0, 36, 4), note(0, 70, 4)]));
		expect(slotNotes(clip, new Map([[36, 2]])).notes.map((n) => n.slot)).toEqual([2, 4]);
		expect(slotNotes(clip, new Map([[36, 4]]))).toBe(clip);
	});
});

describe('using a kit, and dropping one', () => {
	const standard = {
		slots: ['gm-kick', 'gm-snare', 'gm-hat'],
		kit: [...KIT, { note: 42, name: 'Closed Hi-Hat', slot: 2 }]
	};

	it('sets the track’s slots and kit, and puts its notes on the kit’s sounds, in one edit', () => {
		const doc = dropKit(song([note(0, 42), note(120, 38), note(240, 70, 1)]), 1);
		const used = useKit(doc, 1, standard);
		expect(used.tracks[0].slots).toEqual(standard.slots);
		expect(used.tracks[0].kit).toEqual(standard.kit);
		expect(clipOf(used).notes.map((n) => n.slot)).toEqual([2, 1, 1]); // 70 has no sound, and keeps its slot
		expect(used.tracks[1]).toBe(doc.tracks[1]);
		// The standard kit isn't shared with the document, so an edit to one can't reach the other.
		expect(used.tracks[0].kit).not.toBe(standard.kit);
	});

	it('says when there is nothing to use: no drums in the set, or the kit is there already', () => {
		const doc = dropKit(song([note(0, 38)]), 1);
		expect(standardKitWhy(doc.tracks[0], standard)).toBe('');
		const used = useKit(doc, 1, standard);
		expect(playsKit(used.tracks[0], standard)).toBe(true);
		expect(standardKitWhy(used.tracks[0], standard)).toBe('It plays the standard kit already.');
		expect(standardKitWhy(doc.tracks[0], { slots: [], kit: [] })).toMatch(/no drums/);
	});

	it('drops a kit and keeps the slots and notes as they are', () => {
		const doc = withKitSlots(song([note(0, 38)]));
		const dropped = dropKit(doc, 1);
		expect('kit' in dropped.tracks[0]).toBe(false);
		expect(dropped.tracks[0].slots).toEqual(['kick', 'snare']);
		expect(dropped.clips).toBe(doc.clips);
		expect(withKitSlots(dropped)).toBe(dropped);
		expect(dropKit(dropped, 1).tracks[0]).toBe(dropped.tracks[0]);
	});

	it('counts and names a kit’s sounds and keys', () => {
		expect(kitSounds(KIT)).toBe(2);
		expect(soundsText(KIT)).toBe('2 sounds');
		expect(soundsText([KIT[0]])).toBe('1 sound');
		const keys = kitKeys(KIT);
		expect(keyText(keys, 36)).toBe('36 Bass Drum 1');
		expect(keyText(keys, 50)).toBe('50, no sound');
		expect(noteText(keys, 38)).toBe('38 Acoustic Snare');
		expect(noteText(null, 60)).toBe('C4');
	});
});
