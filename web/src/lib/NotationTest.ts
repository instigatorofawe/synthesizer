import { describe, expect, it } from 'vitest';
import type { Key } from '#lib/KeySignature.ts';
import { spell, spellingText, transcribe, type Event, type Score } from '#lib/Notation.ts';
import { Bars } from '#lib/TimeSignature.ts';

const PPQ = 480;
const C: Key = { fifths: 0 };
const named = (note: number, key: Key) => spellingText(spell(note, key));
const note = (tick: number, pitch: number, dur: number) => ({ tick, note: pitch, dur });

// What a voice writes, as a score reads it: each value with its dots, T for a triplet, r for a rest, and ~ where it is tied on.
const written = (events: Event[]) =>
	events
		.filter((e) => !e.hidden)
		.map(
			(e) =>
				`${e.whole ? 'W' : e.value.base}${'.'.repeat(e.value.dots)}${e.value.triplet ? 'T' : ''}${e.pitches.length ? '' : 'r'}${e.tieOut ? '~' : ''}`
		)
		.join(' ');
const voice = (score: Score, measure: number, staff = 0, line = 0) =>
	written(score.measures[measure].voices[staff][line]);
const score = (notes: { tick: number; note: number; dur: number }[], length: number, bars = Bars.of(PPQ), key = C) =>
	transcribe({ length, notes }, bars, { keyAt: () => key });

describe('spelling a note in a key', () => {
	it('writes the key’s own notes with its letters', () => {
		expect(named(66, { fifths: 1 })).toBe('F♯4');
		expect(named(70, { fifths: -1 })).toBe('B♭4');
		expect(named(63, { fifths: -3 })).toBe('E♭4');
		expect(named(71, { fifths: -7 })).toBe('C♭5');
		expect(named(60, { fifths: 7 })).toBe('B♯3');
	});

	it('writes what isn’t in the key with the fewest marks, and a natural where the key would sharpen or flatten it', () => {
		expect(named(67, { fifths: 4 })).toBe('G4'); // E major: a natural, not F double sharp
		expect(named(71, { fifths: -1 })).toBe('B4'); // F major: B natural
		expect(named(61, C)).toBe('C♯4');
		expect(named(63, C)).toBe('E♭4');
		expect(named(66, C)).toBe('F♯4');
		expect(named(68, C)).toBe('G♯4');
		expect(named(70, C)).toBe('B♭4');
		expect(named(63, { fifths: 2 })).toBe('D♯4'); // D major raises
		expect(named(68, { fifths: -2 })).toBe('A♭4'); // B♭ major lowers
	});

	it('raises a minor key’s sixth and seventh', () => {
		expect(named(68, { fifths: 0, minor: true })).toBe('G♯4'); // A minor's leading note
		expect(named(66, { fifths: 0, minor: true })).toBe('F♯4');
		expect(named(61, { fifths: -1, minor: true })).toBe('C♯4'); // D minor's
		expect(named(70, { fifths: 2, minor: true })).toBe('A♯4'); // B minor's
	});
});

describe('notes as written values', () => {
	it('writes a bar of 4/4 as quarters, and fills what is left with rests', () => {
		const s = score([note(0, 60, 480), note(480, 62, 480), note(960, 64, 960)], 1920);
		expect(voice(s, 0)).toBe('4 4 2');
		expect(voice(score([note(0, 60, 480)], 1920), 0)).toBe('4 4r 2r');
		expect(voice(score([], 1920), 0)).toBe('Wr');
	});

	it('writes what was played to the nearest sixteenth, so a played rhythm reads', () => {
		// A quarter played a little short and late, and an eighth played long.
		const s = score([note(10, 60, 450), note(495, 62, 250), note(720, 64, 240)], 1920);
		expect(voice(s, 0)).toBe('4 8 8 2r');
	});

	it('dots what a dot can write, and ties what crosses the bar or the middle of a beat', () => {
		expect(voice(score([note(0, 60, 720), note(720, 62, 240)], 1920), 0)).toBe('4. 8 2r');
		const across = score([note(1440, 60, 960)], 3840);
		expect(voice(across, 0)).toBe('2r 4r 4~');
		expect(voice(across, 1)).toBe('4 4r 2r');
		expect(across.measures[1].voices[0][0][0].tieIn).toBe(true);
	});

	it('writes eighth-note triplets where the notes sit on them, in a tuplet the beat holds', () => {
		const s = score([note(0, 60, 160), note(160, 62, 160), note(320, 64, 160), note(480, 65, 480)], 1920);
		expect(voice(s, 0)).toBe('8T 8T 8T 4 2r');
		expect(s.measures[0].triplets).toEqual([0]);
	});

	it('writes 6/8 in dotted quarters, and 3/8 after a pickup from its own bar lines', () => {
		const six = Bars.of(PPQ, [{ tick: 0, beats: 6, unit: 8 }]);
		expect(voice(score([note(0, 60, 720), note(720, 62, 240), note(960, 64, 480)], 1440, six), 0)).toBe('4. 8 4');
		const elise = Bars.of(PPQ, [{ tick: 0, beats: 3, unit: 8 }], 240);
		const opening = score([note(0, 76, 120), note(120, 75, 120), note(240, 76, 120)], 960, elise, {
			fifths: 0,
			minor: true
		});
		expect(opening.measures.map((m) => [m.number, m.start, m.end, m.partial])).toEqual([
			[0, 0, 240, true],
			[1, 240, 960, false]
		]);
		expect(voice(opening, 0)).toBe('16 16');
		expect(voice(opening, 1)).toBe('16 16r 8r 8r');
		expect(opening.measures[0].voices[0][0][1].pitches[0].spelling).toEqual({ letter: 'D', alter: 1, octave: 5 });
	});
});

describe('staves and voices', () => {
	it('puts notes on the staff their middle sits on, and a piano’s reach on two, split at middle C', () => {
		expect(score([note(0, 72, 480)], 1920).clefs).toEqual(['treble']);
		expect(score([note(0, 43, 480)], 1920).clefs).toEqual(['bass']);
		const both = score([note(0, 72, 1920), note(0, 48, 1920)], 1920);
		expect(both.clefs).toEqual(['treble', 'bass']);
		expect(voice(both, 0, 0)).toBe('1');
		expect(voice(both, 0, 1)).toBe('1');
	});

	it('writes notes that start and end together as a chord, and an overlapping line in a voice of its own', () => {
		const s = score([note(0, 64, 1920), note(0, 67, 1920), note(0, 72, 480), note(480, 74, 480)], 1920);
		expect(s.measures[0].voices[0]).toHaveLength(2);
		expect(voice(s, 0, 0, 0)).toBe('4 4 2r');
		expect(voice(s, 0, 0, 1)).toBe('1');
		expect(s.measures[0].voices[0][1][0].pitches.map((p) => p.note)).toEqual([64, 67]);
	});

	it('shows the meter and the key where they start and where they change', () => {
		const bars = Bars.of(PPQ, [
			{ tick: 0, beats: 4, unit: 4 },
			{ tick: 1920, beats: 3, unit: 4 }
		]);
		const s = transcribe({ length: 1920 + 2 * 1440, notes: [] }, bars, {
			keyAt: (tick) => (tick >= 3360 ? { fifths: -2 } : C)
		});
		expect(s.measures.map((m) => [m.meterShown, m.keyShown])).toEqual([
			[true, true],
			[true, false],
			[false, true]
		]);
	});
});
