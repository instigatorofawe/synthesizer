import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GM, type GeneralMidi } from '#lib/GeneralMidi.ts';
import { importMidi, type ImportOptions } from '#lib/MidiImport.ts';
import oracle from '#lib/MidiImportOracle.json';
import {
	bend,
	cc,
	key,
	keyPressure,
	meter,
	midiFile,
	name,
	off,
	on,
	pressure,
	program,
	sysex,
	tempo,
	track,
	type Raw
} from '#lib/MidiWriter.ts';
import { timelineSchema, type Timeline } from '#lib/Schema.ts';

// A set of a few instruments, so the tests say what the import does with a table rather than what the real set holds: pianos
// for GM's first family, organs for its third, a violin, and five drums, two of which share a patch, and nothing for the rest,
// so a program or a key with no sound can be tried. Its names are GM's.
const PATCHES: Record<number, string> = { 40: 'Violin' };
for (let p = 0; p < 8; ++p) PATCHES[p] = 'Piano';
for (let p = 16; p < 24; ++p) PATCHES[p] = 'Organ';
const DRUMS: Record<number, string> = { 35: 'Kick', 36: 'Kick', 38: 'Snare', 42: 'HiHat', 46: 'OpenHat' };
const TABLE: GeneralMidi = {
	prefix: 'builtin-gm-',
	params: { bend: 1, wheel: 2, expression: 3, pressure: 4 },
	programs: GM.programs.map((p) => ({ ...p, instrument: PATCHES[p.program] ?? null })),
	drums: GM.drums.map((d) => ({ ...d, instrument: DRUMS[d.note] ?? null })),
	defaults: { bend: 0, wheel: 0, expression: 1, pressure: 0 },
	chokes: { 'hi-hat': [42, 44, 46] },
	held: [46],
	effects: { reverb: 'Hall', chorus: 'Chorus' }
};

const PIANO = 'builtin-gm-Piano';
const ORGAN = 'builtin-gm-Organ';

const imported = (bytes: Uint8Array, options: ImportOptions = {}) => importMidi(bytes, { gm: TABLE, ...options });
const one = (events: Raw[], options: ImportOptions = {}, division = 480) =>
	imported(midiFile(0, division, [track(events)]), options);

// A track's notes where the song plays them, rather than in its clip's ticks.
function played(doc: Timeline, index = 0) {
	const t = doc.tracks[index];
	const placed = t.placements[0];
	const clip = doc.clips.find((c) => c.id === placed.clip)!;
	return clip.notes.map((n) => ({ ...n, tick: n.tick + placed.tick }));
}
const lengths = (doc: Timeline, index = 0) => played(doc, index).map((n) => [n.tick, n.note, n.dur]);
const clipOf = (doc: Timeline, index = 0) => doc.clips.find((c) => c.id === doc.tracks[index].placements[0].clip)!;
type Point = Timeline['clips'][number]['automation'][number];
const lane = (doc: Timeline, match: (a: Point) => boolean, index = 0) =>
	clipOf(doc, index)
		.automation.filter(match)
		.map((a) => [a.tick, a.value]);
const mixOf = (a: Point) => (a.target && 'mix' in a.target ? a.target.mix : null);

describe('a MIDI file as a song: its time', () => {
	it("keeps the file's ticks, and takes its tempo map, time signatures and key signatures", () => {
		const { doc } = imported(
			midiFile(1, 96, [
				track([
					tempo(0, 100),
					meter(0, 3, 4),
					key(0, 2),
					tempo(384, 100), // Says what the one before said
					meter(288, 6, 8),
					key(288, -3, true),
					tempo(576, 75)
				]),
				track([on(0, 0, 60), off(96, 0, 60)])
			])
		);
		expect(doc.ppq).toBe(96);
		expect(doc.tempo).toEqual([
			{ tick: 0, bpm: 100 },
			{ tick: 576, bpm: 75 }
		]);
		expect(doc.meter).toEqual([
			{ tick: 0, beats: 3, unit: 4 },
			{ tick: 288, beats: 6, unit: 8 }
		]);
		expect(doc.key).toEqual([
			{ tick: 0, fifths: 2 },
			{ tick: 288, fifths: -3, minor: true }
		]);
		expect(doc.pickup).toBeUndefined();
	});

	it("plays at MIDI's 120 until the file says otherwise, and says nothing of 4/4 in C major", () => {
		const { doc } = one([on(0, 0, 60), tempo(480, 90), meter(0, 4, 4), key(0, 0), off(960, 0, 60)]);
		expect(doc.tempo).toEqual([
			{ tick: 0, bpm: 120 },
			{ tick: 480, bpm: 90 }
		]);
		expect(doc.meter).toBeUndefined();
		expect(doc.key).toBeUndefined();
	});

	it("splits the file's ticks when a time signature's beat isn't a whole number of them", () => {
		const { doc } = one([meter(0, 7, 32), on(6, 0, 60), off(12, 0, 60)], {}, 6);
		expect(doc.ppq).toBe(24); // A 32nd note is an eighth of a quarter: 0.75 of a tick of 6 to a quarter, and 3 of 24
		expect(doc.meter).toEqual([{ tick: 0, beats: 7, unit: 32 }]);
		expect(lengths(doc)).toEqual([[24, 60, 24]]);
	});

	it("leaves out a time signature the song can't draw, and says so", () => {
		const { doc, summary } = one([meter(0, 3, 64), on(0, 0, 60), off(480, 0, 60)]);
		expect(doc.meter).toBeUndefined();
		expect(summary.text).toMatch(/a time signature the song can't hold \(3\/64\)/);
	});

	it('plays SMPTE time code at a tempo that makes a tick the time the file says', () => {
		const smpte = ((256 - 25) << 8) | 40; // 25 frames a second of 40 ticks each: a millisecond a tick
		const { doc, summary } = imported(midiFile(0, smpte, [track([tempo(0, 60), on(1000, 0, 60), off(1500, 0, 60)])]));
		// 500 ticks a quarter at 120 is 1000 a second.
		expect(doc.ppq).toBe(500);
		expect(doc.tempo).toEqual([{ tick: 0, bpm: 120 }]);
		expect(lengths(doc)).toEqual([[1000, 60, 500]]);
		expect(summary.text).toMatch(/SMPTE time code at 25 frames a second/);
		const drop = ((256 - 29) << 8) | 3; // 29.97 frames of 3 ticks: 90 nominal ticks a second, and 30 a second is odd
		expect(imported(midiFile(0, drop, [track([on(0, 0, 60), off(9, 0, 60)])])).doc).toMatchObject({
			ppq: 45,
			tempo: [{ tick: 0, bpm: 119.88 }]
		});
	});
});

describe('a MIDI file as a song: its tracks', () => {
	it('makes a track of each channel a format 0 file plays, named after its program', () => {
		const { doc } = one([
			name(0, 'The song'),
			program(0, 0, 0),
			program(0, 1, 16),
			on(0, 0, 60),
			on(0, 1, 48),
			cc(0, 2, 7, 90), // A channel with no notes has no track
			off(480, 0, 60),
			off(480, 1, 48)
		]);
		expect(doc.tracks.map((t) => [t.id, t.name, t.slots])).toEqual([
			[1, 'Acoustic Grand Piano', [PIANO]],
			[2, 'Drawbar Organ', [ORGAN]]
		]);
	});

	it("in format 1, makes a track of each file track's channel, named after the file's track", () => {
		const { doc } = imported(
			midiFile(1, 480, [
				track([name(0, 'Conductor'), tempo(0, 120)]),
				track([name(0, 'Right hand'), on(0, 0, 72), off(480, 0, 72)]),
				track([name(0, 'Both'), program(0, 1, 16), on(0, 1, 48), on(0, 2, 36), off(480, 1, 48), off(480, 2, 36)]),
				track([on(0, 0, 60), off(480, 0, 60)]) // Another track on the first's channel
			])
		);
		expect(doc.tracks.map((t) => t.name)).toEqual([
			'Right hand',
			'Both (Drawbar Organ)',
			'Both (Acoustic Grand Piano)',
			'Acoustic Grand Piano'
		]);
		expect(doc.tracks.map((t) => played(doc, doc.tracks.indexOf(t)).map((n) => n.note))).toEqual([
			[72],
			[48],
			[36],
			[60]
		]);
	});

	it("keeps a channel's program, controllers and pedal the channel's, whichever track sent them", () => {
		const { doc } = imported(
			midiFile(1, 480, [
				track([program(0, 0, 16), cc(0, 0, 7, 127), cc(0, 0, 64, 127), cc(960, 0, 64, 0)]),
				track([on(0, 0, 60), off(480, 0, 60)])
			])
		);
		expect(doc.tracks[0].slots).toEqual([ORGAN]);
		expect(doc.tracks[0].gain).toBe(1);
		expect(lengths(doc)).toEqual([[0, 60, 960]]);
	});
});

describe('a MIDI file as a song: programs', () => {
	it('gives a track a slot for each instrument its programs reach, and each note the program in force as it starts', () => {
		const { doc } = one([
			on(0, 0, 60),
			program(240, 0, 16), // While the first note sounds, which keeps the piano
			off(480, 0, 60),
			on(480, 0, 62),
			off(960, 0, 62),
			program(960, 0, 1), // Another piano program, which is the same instrument
			on(960, 0, 64),
			off(1440, 0, 64),
			program(1440, 0, 20),
			on(1440, 0, 65),
			off(1920, 0, 65)
		]);
		expect(doc.tracks[0].slots).toEqual([PIANO, ORGAN]);
		expect(played(doc).map((n) => [n.note, n.slot])).toEqual([
			[60, 0],
			[62, 1],
			[64, 0],
			[65, 1]
		]);
	});

	it('writes no slot on the notes of a track with one', () => {
		const { doc } = one([on(0, 0, 60), off(480, 0, 60)]);
		expect(played(doc)[0].slot).toBeUndefined();
	});

	it('leaves out the notes of a program the set has no instrument for, and says so', () => {
		const { doc, summary } = one([
			program(0, 0, 104),
			on(0, 0, 60),
			off(480, 0, 60),
			on(480, 0, 62),
			off(960, 0, 62),
			program(960, 0, 0),
			on(960, 0, 64),
			off(1440, 0, 64),
			program(0, 1, 105),
			on(0, 1, 50),
			off(480, 1, 50)
		]);
		expect(doc.tracks).toHaveLength(1); // The banjo's track has nothing left to play
		expect(played(doc).map((n) => n.note)).toEqual([64]);
		expect(doc.tracks[0].slots).toEqual([PIANO]);
		expect(summary.left).toEqual(
			expect.arrayContaining([
				'2 notes for Sitar, which the set has no instrument for',
				'1 note for Banjo, which the set has no instrument for'
			])
		);
	});
});

describe('a MIDI file as a song: drums', () => {
	it("makes channel 10 a kit of the sounds it plays, each note's slot from its key", () => {
		const { doc, summary } = one([
			on(0, 9, 36),
			off(10, 9, 36),
			on(480, 9, 38),
			off(490, 9, 38),
			on(960, 9, 35),
			off(970, 9, 35),
			on(960, 9, 56), // A cowbell, which the kit has no sound for
			off(970, 9, 56)
		]);
		const drums = doc.tracks[0];
		expect(drums.name).toBe('Drums');
		expect(drums.slots).toEqual(['builtin-gm-Kick', 'builtin-gm-Snare']);
		expect(drums.kit).toEqual([
			{ note: 35, name: 'Acoustic Bass Drum', slot: 0 },
			{ note: 36, name: 'Bass Drum 1', slot: 0 },
			{ note: 38, name: 'Acoustic Snare', slot: 1 }
		]);
		expect(played(doc).map((n) => [n.tick, n.note, n.slot])).toEqual([
			[0, 36, 0],
			[480, 38, 1],
			[960, 35, 0]
		]);
		expect(summary.left).toContain('1 drum note on Cowbell, which the kit has no sound for');
	});

	it('ends a note in a choke group when another of its group starts, and ignores program changes and the pedal', () => {
		const { doc } = one([
			program(0, 9, 25),
			cc(0, 9, 64, 127),
			on(0, 9, 46), // An open hi-hat, which the closed one stops
			on(240, 9, 42),
			off(300, 9, 42),
			off(480, 9, 46), // Its note-off, after the closed hat stopped it, which ends nothing more
			on(480, 9, 38),
			off(960, 9, 38)
		]);
		expect(lengths(doc)).toEqual([
			[0, 46, 240],
			[240, 42, 60],
			[480, 38, 480]
		]);
		expect(doc.tracks[0].slots).toEqual(['builtin-gm-Snare', 'builtin-gm-HiHat', 'builtin-gm-OpenHat']);
	});
});

describe('a MIDI file as a song: the long sounds of choke groups', () => {
	it('rings an open hi-hat on to the next note of its group, however short its own note', () => {
		const { doc } = one([
			on(0, 9, 46),
			off(10, 9, 46),
			on(480, 9, 38),
			off(490, 9, 38),
			on(960, 9, 42),
			off(970, 9, 42)
		]);
		expect(lengths(doc)).toEqual([
			[0, 46, 960],
			[480, 38, 10], // Every other drum keeps the length the file gives it
			[960, 42, 10]
		]);
	});

	it('rings one nothing stops for a second and a half at the tempo there, or for its own note if that is longer', () => {
		const short = one([tempo(0, 120), tempo(960, 60), on(0, 9, 46), off(5, 9, 46)]).doc;
		expect(lengths(short)).toEqual([[0, 46, 1200]]); // A second at 120 is 960 ticks, and half of one at 60 is 240 more
		const long = one([on(0, 9, 46), off(4800, 9, 46)]).doc;
		expect(lengths(long)).toEqual([[0, 46, 4800]]);
	});

	it("takes which keys ring on from the table's held keys", () => {
		const { doc } = one([on(0, 9, 46), off(10, 9, 46), on(960, 9, 42), off(970, 9, 42)], {
			gm: { ...TABLE, held: [] }
		});
		expect(lengths(doc)).toEqual([
			[0, 46, 10],
			[960, 42, 10]
		]);
	});

	it('gives a kit track 32 voices, for the cymbals that ring on whatever their notes', () => {
		const { doc } = one([on(0, 9, 36), off(10, 9, 36)]);
		expect(doc.tracks[0].voices).toBe(32);
		expect(doc.tracks[0].steal).toBe('fade');
	});
});

describe('a MIDI file as a song: notes', () => {
	it('takes a note-on at velocity 0 for a note-off, and keeps each note its velocity', () => {
		const { doc } = one([on(0, 0, 60, 90), on(240, 0, 60, 0), on(240, 0, 62, 40), off(720, 0, 62)]);
		expect(played(doc).map((n) => [n.tick, n.note, n.vel, n.dur])).toEqual([
			[0, 60, 90, 240],
			[240, 62, 40, 480]
		]);
	});

	it('ends a note where its key is struck again, and its note-off then ends nothing more', () => {
		const { doc } = one([on(0, 0, 60), on(240, 0, 60), off(480, 0, 60), off(720, 0, 60)]);
		expect(lengths(doc)).toEqual([
			[0, 60, 240],
			[240, 60, 480]
		]);
	});

	it('takes the second of two notes struck at once on one key for both', () => {
		const { doc } = one([on(0, 0, 60, 50), on(0, 0, 60, 90), off(480, 0, 60), off(480, 0, 60)]);
		expect(played(doc).map((n) => [n.tick, n.vel, n.dur])).toEqual([[0, 90, 480]]);
	});

	it('reads a note-off that comes after the next note-on at the same tick as the end of the note before', () => {
		const { doc } = one([on(0, 0, 60), on(480, 0, 60), off(480, 0, 60), off(960, 0, 60)]);
		expect(lengths(doc)).toEqual([
			[0, 60, 480],
			[480, 60, 480]
		]);
	});

	it('ends a note still sounding at the end of its track there, and gives a note no longer than nothing a tick', () => {
		const { doc } = imported(midiFile(0, 480, [track([on(0, 0, 60), on(100, 0, 64), off(100, 0, 64)], 1920)]));
		expect(lengths(doc)).toEqual([
			[0, 60, 1920],
			[100, 64, 1]
		]);
	});

	it('ends every note at All Notes Off, and forgets the note-offs still to come', () => {
		const { doc } = one([
			on(0, 0, 60),
			on(0, 0, 64),
			on(240, 0, 64), // Struck again: one note-off for 64 is still to come
			cc(480, 0, 123, 0),
			on(960, 0, 64),
			off(1200, 0, 64),
			off(1440, 0, 60)
		]);
		expect(lengths(doc)).toEqual([
			[0, 60, 480],
			[0, 64, 240],
			[240, 64, 240],
			[960, 64, 240]
		]);
	});
});

describe('a MIDI file as a song: the sustain pedal', () => {
	const pedalled = [
		on(0, 0, 60),
		cc(100, 0, 64, 127),
		off(240, 0, 60), // Held by the pedal
		on(240, 0, 64),
		off(480, 0, 64), // Held too, until its key is struck again
		on(600, 0, 64),
		off(700, 0, 64),
		cc(960, 0, 64, 0), // Lifted: what it holds ends
		on(960, 0, 67),
		off(1200, 0, 67)
	];

	it('holds a note let go of while the pedal is down until it lifts, or until its key is struck again', () => {
		const { doc } = one(pedalled);
		expect(lengths(doc)).toEqual([
			[0, 60, 960],
			[240, 64, 360],
			[600, 64, 360],
			[960, 67, 240]
		]);
		expect(doc.tracks[0].voices).toBe(2);
	});

	it('takes a pedal below 64 as up', () => {
		const { doc } = one([cc(0, 0, 64, 63), on(0, 0, 60), off(240, 0, 60)]);
		expect(lengths(doc)).toEqual([[0, 60, 240]]);
	});

	it('leaves the lengths as the file says when asked to', () => {
		const { doc } = one(pedalled, { pedal: false });
		expect(lengths(doc)).toEqual([
			[0, 60, 240],
			[240, 64, 240],
			[600, 64, 100],
			[960, 67, 240]
		]);
		expect(doc.tracks[0].voices).toBe(1);
	});
});

describe('a MIDI file as a song: controllers', () => {
	it("sets the track's fader and pan from volume and pan as it starts, by GM's curve, and makes lanes of what changes", () => {
		const { doc } = one([
			cc(0, 0, 7, 127),
			cc(0, 0, 10, 0),
			on(0, 0, 60),
			cc(480, 0, 7, 64),
			cc(480, 0, 7, 64), // The same again is no change
			cc(960, 0, 10, 127),
			off(1440, 0, 60)
		]);
		const t = doc.tracks[0];
		expect([t.gain, t.pan]).toEqual([1, -1]);
		expect(lane(doc, (a) => mixOf(a) === 'fader')).toEqual([
			[0, 1],
			[480, 0.254]
		]);
		expect(lane(doc, (a) => mixOf(a) === 'pan')).toEqual([
			[0, -1],
			[960, 1]
		]);
		expect(clipOf(doc).automation[0].target).toEqual({ mix: 'fader', track: 1 });
	});

	it("takes GM's volume of 100 for a channel that never says, and makes no lane of a value that never changes", () => {
		const { doc } = one([cc(0, 0, 10, 96), on(0, 0, 60), cc(240, 0, 10, 96), off(480, 0, 60)]);
		expect(doc.tracks[0].gain).toBe(0.62);
		expect(doc.tracks[0].pan).toBe(0.5079);
		expect(clipOf(doc).automation).toEqual([]);
	});

	it("sets the track's parameters from expression, the mod wheel and pressure, and their lanes from what changes", () => {
		const { doc } = one([
			cc(0, 0, 11, 100),
			cc(0, 0, 1, 127),
			on(0, 0, 60),
			pressure(240, 0, 64),
			cc(480, 0, 11, 127),
			off(960, 0, 60)
		]);
		expect(doc.tracks[0].params).toEqual({ '3': 0.7874, '2': 1 });
		expect(lane(doc, (a) => a.param === 3)).toEqual([
			[0, 0.7874],
			[480, 1]
		]);
		expect(lane(doc, (a) => a.param === 4)).toEqual([
			[0, 0],
			[240, 0.5039]
		]);
		expect(lane(doc, (a) => a.param === 2)).toEqual([]);
	});

	it('bends in semitones, two either way unless RPN 0 sets the range', () => {
		const { doc } = one([
			on(0, 0, 60),
			bend(0, 0, 8191),
			bend(240, 0, -4096),
			cc(480, 0, 101, 0),
			cc(480, 0, 100, 0),
			cc(480, 0, 6, 12), // Twelve semitones, which moves the bend already there
			cc(480, 0, 38, 50), // And a half
			cc(480, 0, 101, 127),
			cc(480, 0, 100, 127),
			cc(600, 0, 6, 1), // With no parameter chosen, which changes nothing
			bend(720, 0, 0),
			off(960, 0, 60)
		]);
		expect(doc.tracks[0].params).toEqual({ '1': 2 });
		expect(lane(doc, (a) => a.param === 1)).toEqual([
			[0, 2],
			[240, -1],
			[480, -6.25],
			[720, 0]
		]);
	});

	it('resets expression, the wheel, pressure, the bend and the pedal at Reset All Controllers, and not the volume', () => {
		const { doc } = one([
			cc(0, 0, 7, 127),
			cc(0, 0, 11, 64),
			cc(0, 0, 64, 127),
			on(0, 0, 60),
			off(240, 0, 60),
			cc(480, 0, 121, 0),
			on(960, 0, 62),
			off(1200, 0, 62)
		]);
		expect(lengths(doc)).toEqual([
			[0, 60, 480],
			[960, 62, 240]
		]);
		expect(lane(doc, (a) => a.param === 3)).toEqual([
			[0, 0.5039],
			[480, 1]
		]);
		expect(doc.tracks[0].gain).toBe(1);
	});

	it("takes where the set's parameters start from the table", () => {
		const gm = { ...TABLE, defaults: { bend: 0, wheel: 0.5, expression: 0.8, pressure: 0 } };
		const { doc } = one([cc(0, 0, 1, 64), on(0, 0, 60), cc(480, 0, 121, 0), off(960, 0, 60)], { gm });
		expect(doc.tracks[0].params).toEqual({ '2': 0.5039 }); // Expression starts where the table says, so it isn't written
		expect(lane(doc, (a) => a.param === 2)).toEqual([
			[0, 0.5039],
			[480, 0.5] // Reset All Controllers puts it back where the table says it starts
		]);
		expect(lane(doc, (a) => a.param === 3)).toEqual([]);
	});

	it('takes what is in force where the clip starts as where it starts', () => {
		const { doc } = one([cc(0, 0, 7, 50), cc(960, 0, 7, 127), on(1920, 0, 60), off(2400, 0, 60)]);
		expect(doc.tracks[0].placements[0].tick).toBe(1920);
		expect(doc.tracks[0].gain).toBe(1);
		expect(clipOf(doc).automation).toEqual([]);
	});
});

describe('a MIDI file as a song: sends', () => {
	it("sends to a reverb bus at GM's 40 unless a channel says, and to a chorus bus only when one does", () => {
		const { doc } = one([
			on(0, 0, 60),
			off(480, 0, 60),
			cc(0, 1, 91, 0),
			cc(0, 1, 93, 127),
			on(0, 1, 62),
			cc(240, 1, 93, 64),
			off(480, 1, 62)
		]);
		expect(doc.tracks.map((t) => t.sends)).toEqual([[{ bus: 'reverb', gain: 0.315 }], [{ bus: 'chorus', gain: 1 }]]);
		expect(doc.buses).toEqual([
			{
				id: 'reverb',
				gain: 1,
				pan: 0,
				mute: false,
				output: 'master',
				sends: [],
				inserts: [{ id: 1, patch: 'builtin-gm-Hall' }]
			},
			{
				id: 'chorus',
				gain: 1,
				pan: 0,
				mute: false,
				output: 'master',
				sends: [],
				inserts: [{ id: 2, patch: 'builtin-gm-Chorus' }]
			}
		]);
		expect(lane(doc, (a) => mixOf(a) === 'send', 1)).toEqual([
			[0, 1],
			[240, 0.5039]
		]);
		expect(clipOf(doc, 1).automation[0].target).toEqual({ mix: 'send', track: 2, to: 'chorus' });
	});

	it('leaves out a bus no track sends to', () => {
		const { doc } = one([cc(0, 0, 91, 0), on(0, 0, 60), off(480, 0, 60)]);
		expect(doc.buses).toEqual([]);
		expect(doc.tracks[0].sends).toEqual([]);
	});

	it('sends nowhere when the table has no effect to send to', () => {
		const gm = { ...TABLE, effects: { reverb: null, chorus: null } };
		const { doc, summary } = one([cc(0, 0, 93, 100), on(0, 0, 60), off(480, 0, 60)], { gm });
		expect(doc.buses).toEqual([]);
		expect(doc.tracks[0].sends).toEqual([]);
		expect(summary.left).toEqual([]);
	});
});

describe('a MIDI file as a song: clips and voices', () => {
	it("places a track's one clip at the bar its first note is in, as long as the bars its notes take", () => {
		const { doc } = imported(
			midiFile(1, 480, [
				track([meter(0, 3, 4)]),
				track([on(3000, 0, 60), off(4000, 0, 60)]),
				track([on(0, 1, 60), off(10, 1, 60)])
			])
		);
		// Bars of 3/4 are 1440 ticks: the first note is in the third bar, and the last ends in the third too.
		expect(doc.tracks[0].placements).toEqual([{ clip: 'Acoustic Grand Piano', tick: 2880, repeat: 1 }]);
		expect(clipOf(doc).length).toBe(1440);
		expect(clipOf(doc).notes[0].tick).toBe(120);
		expect(doc.tracks[1].placements[0]).toMatchObject({ clip: 'Acoustic Grand Piano-2', tick: 0 });
		expect(clipOf(doc, 1).length).toBe(1440);
	});

	it('gives a track as many voices as it sounds notes at once, at most 64', () => {
		const chord = [0, 4, 7].flatMap((k) => [on(0, 0, 60 + k), off(480, 0, 60 + k)]);
		expect(one([...chord, on(480, 0, 72), off(960, 0, 72)]).doc.tracks[0].voices).toBe(3);
		const cluster = Array.from({ length: 80 }, (_, k) => on(0, 0, 20 + k));
		expect(one(cluster).doc.tracks[0].voices).toBe(64);
	});
});

describe('a MIDI file as a song: the summary', () => {
	it('says what was imported, and what was left out', () => {
		const { summary } = one([
			sysex(0, [0x7e, 0x7f, 0x09, 0x01, 0xf7]),
			sysex(0, [0x41, 0x10, 0x42, 0x12, 0xf7]),
			cc(0, 0, 0, 1), // Bank select, twice over
			cc(0, 0, 32, 0),
			cc(0, 0, 74, 20),
			cc(10, 0, 74, 30),
			keyPressure(10, 0, 60, 40),
			on(0, 0, 60),
			on(0, 0, 64),
			off(480, 0, 60),
			off(480, 0, 64)
		]);
		expect(summary.tracks).toBe(1);
		expect(summary.notes).toBe(2);
		expect(summary.text).toBe(
			'Imported 1 track with 2 notes. Left out 2 system exclusive messages; 4 changes to controllers 0, 32 and 74, which nothing here answers; 1 polyphonic key pressure message.'
		);
	});

	it('says only what was imported when nothing was left out', () => {
		expect(one([on(0, 0, 60), off(480, 0, 60)]).summary.text).toBe('Imported 1 track with 1 note.');
	});
});

describe('a MIDI file as a song', () => {
	it('comes down at the master as more tracks play at once, from four of them', () => {
		const tracks = (count: number) =>
			one(Array.from({ length: count }, (_, c) => [on(0, c, 36), off(480, c, 36)]).flat()).doc; // A kick on channel 10
		expect([1, 4, 9, 16].map((count) => tracks(count).master.gain)).toEqual([1, 1, 0.6667, 0.5]);
	});

	it('is a timeline the editor opens as it is', () => {
		const { doc } = one([program(0, 0, 16), cc(0, 0, 7, 100), bend(240, 0, 100), on(0, 0, 60), off(480, 0, 60)]);
		expect(timelineSchema.parse(doc)).toEqual(doc);
	});
});

// The Mutopia editions the pieces are read from, against examples/MakePieces.py's read_midi, which is how the pieces have
// them. The fixture is what read_midi makes of each file at the file's own ticks, with each note's velocity, which read_midi
// reads and doesn't keep: a script made it with a copy of read_midi that keeps them, checked against read_midi itself in
// everything else. read_midi folds in no pedal, so the import is asked for none here either. Where the two might differ,
// on a key struck again while it sounds, which read_midi lets ring on beside the new note, none of these files does it.
describe('the Mutopia scores, against MakePieces.py', () => {
	const scores = resolve(import.meta.dirname, '../../../examples/Pieces/Scores');
	const pieces = oracle as Record<string, { division: number; notes: number[][] }>;
	const read = (piece: string, pedal: boolean) =>
		importMidi(new Uint8Array(readFileSync(`${scores}/${piece}.mid`)), { gm: TABLE, pedal }).doc;
	const sorted = (notes: number[][]) =>
		[...notes].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[4] - b[4] || a[3] - b[3] || a[2] - b[2]);

	for (const [piece, expected] of Object.entries(pieces)) {
		it(`reads ${piece}.mid note for note: tick, key, velocity and length`, () => {
			const doc = read(piece, false);
			expect(doc.ppq).toBe(expected.division);
			// Each of its tracks plays one channel, so each is one track here, in the file's order.
			const parts = [...new Set(expected.notes.map((n) => n[4]))].sort((a, b) => a - b);
			expect(doc.tracks).toHaveLength(parts.length);
			const mine = doc.tracks.flatMap((_, index) =>
				played(doc, index).map((n) => [n.tick, n.note, n.vel, n.dur, parts[index]])
			);
			expect(sorted(mine)).toEqual(sorted(expected.notes));
		});
	}

	it('lengthens the notes the pedal holds in In the Hall of the Mountain King, and only those', () => {
		const [loose, held] = [read('MountainKing', false), read('MountainKing', true)];
		expect(played(held, 0)).toEqual(played(loose, 0)); // The right hand has no pedal
		const [before, after] = [played(loose, 1), played(held, 1)];
		expect(after.map((n) => [n.tick, n.note, n.vel])).toEqual(before.map((n) => [n.tick, n.note, n.vel]));
		const longer = after.filter((n, i) => n.dur > before[i].dur).length;
		expect(after.every((n, i) => n.dur >= before[i].dur)).toBe(true);
		expect(longer).toBeGreaterThan(100);
		expect(held.tracks[1].voices).toBeGreaterThan(loose.tracks[1].voices);
	});
});
