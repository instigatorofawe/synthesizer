import { describe, expect, it } from 'vitest';
import { timelineSchema } from '#lib/Schema.ts';
import { gliding, parseBpm, shownTempo, tempoIndexAt, tempoTyped, tempoWords } from '#lib/Tempo.ts';
import { Bars } from '#lib/TimeSignature.ts';

const PPQ = 480;
const BARS = Bars.of(PPQ);

describe('a typed position', () => {
	it('reads as the ghost note does, bars and beats from 1 and the tick from 0', () => {
		expect(BARS.parse('1.1.000')).toBe(0);
		expect(BARS.parse('1.4.000')).toBe(3 * PPQ);
		expect(BARS.parse('3.2.240')).toBe(2 * 4 * PPQ + PPQ + 240);
		for (const tick of [0, 1, 479, 480, 1920, 7777]) expect(BARS.parse(BARS.position(tick))).toBe(tick);
	});

	it('takes a bar alone, or a bar and a beat, and other marks between them', () => {
		expect(BARS.parse('9')).toBe(8 * 4 * PPQ);
		expect(BARS.parse(' 2.3 ')).toBe(4 * PPQ + 2 * PPQ);
		expect(BARS.parse('2 3 10')).toBe(4 * PPQ + 2 * PPQ + 10);
		expect(BARS.parse('2:3')).toBe(4 * PPQ + 2 * PPQ);
	});

	it('is nothing when it names no place', () => {
		for (const text of ['', '0', '1.0', '1.5', '1.1.480', '-1', 'two', '1.1.1.1', '1..2', '1.2x']) {
			expect(BARS.parse(text), text).toBeNull();
		}
	});
});

describe('a typed tempo', () => {
	it('is a number the schema allows', () => {
		expect(parseBpm('120')).toBe(120);
		expect(parseBpm(' 92.5 ')).toBe(92.5);
		for (const text of ['', '0', '1001', 'fast', 'NaN']) expect(parseBpm(text), text).toBeNull();
	});
});

describe('the tempo at the playhead', () => {
	// 100 for two bars, then a glide from 120 at bar 3 to 160 at bar 5, which holds, in the order a document may hold them.
	const doc = timelineSchema.parse({
		tempo: [
			{ tick: 7680, bpm: 160 },
			{ tick: 0, bpm: 100 },
			{ tick: 3840, bpm: 120, ramp: true }
		]
	});

	it('is the latest change at or before it, or the first before every change', () => {
		expect(tempoIndexAt(doc.tempo, 0)).toBe(1);
		expect(tempoIndexAt(doc.tempo, 3839)).toBe(1);
		expect(tempoIndexAt(doc.tempo, 3840)).toBe(2);
		expect(tempoIndexAt(doc.tempo, 99999)).toBe(0);
		expect(tempoIndexAt([{ tick: 960, bpm: 90 }], 0)).toBe(0);
	});

	it('shows how far a glide has got, and while typed into, where the glide starts', () => {
		expect(shownTempo(doc.tempo, 0, false)).toBe(100);
		expect(shownTempo(doc.tempo, 5760, false)).toBe(140);
		expect(shownTempo(doc.tempo, 5760, true)).toBe(120);
		expect(shownTempo(doc.tempo, 3840 + 1, false)).toBe(120);
		expect(gliding(doc.tempo, 5760)).toBe('up');
		expect(gliding(doc.tempo, 0)).toBeNull();
		expect(gliding(doc.tempo, 9000)).toBeNull();
	});

	it('changes only the change in effect when one is typed', () => {
		const typed = tempoTyped(doc, 1920, 90);
		expect(typed.tempo).toEqual([
			{ tick: 0, bpm: 90 },
			{ tick: 3840, bpm: 120, ramp: true },
			{ tick: 7680, bpm: 160 }
		]);
		expect(tempoTyped(doc, 5760, 130).tempo.find((t) => t.tick === 3840)).toEqual({ tick: 3840, bpm: 130, ramp: true });
		expect(tempoTyped(doc, 1920, 100)).toBe(doc);
	});

	it('says what typing changes', () => {
		expect(tempoWords([{ tick: 0, bpm: 120 }], 0, BARS)).toMatch(/song's tempo/);
		expect(tempoWords(doc.tempo, 0, BARS)).toMatch(/from bar 1, one of the song's 3 tempos/);
		expect(tempoWords(doc.tempo, 5760, BARS)).toMatch(/Gliding from 120 BPM at bar 3 to 160 at bar 5/);
	});
});
