import { describe, expect, it } from 'vitest';
import { timelineSchema } from '#lib/Schema.ts';
import { position } from '#lib/TimelineEdit.ts';
import { gliding, parseBpm, parsePosition, shownTempo, tempoIndexAt, tempoTyped, tempoWords } from '#lib/Transport.ts';

const PPQ = 480;

describe('a typed position', () => {
	it('reads as the ghost note does, bars and beats from 1 and the tick from 0', () => {
		expect(parsePosition('1.1.000', PPQ)).toBe(0);
		expect(parsePosition('1.4.000', PPQ)).toBe(3 * PPQ);
		expect(parsePosition('3.2.240', PPQ)).toBe(2 * 4 * PPQ + PPQ + 240);
		for (const tick of [0, 1, 479, 480, 1920, 7777]) expect(parsePosition(position(tick, PPQ), PPQ)).toBe(tick);
	});

	it('takes a bar alone, or a bar and a beat, and other marks between them', () => {
		expect(parsePosition('9', PPQ)).toBe(8 * 4 * PPQ);
		expect(parsePosition(' 2.3 ', PPQ)).toBe(4 * PPQ + 2 * PPQ);
		expect(parsePosition('2 3 10', PPQ)).toBe(4 * PPQ + 2 * PPQ + 10);
		expect(parsePosition('2:3', PPQ)).toBe(4 * PPQ + 2 * PPQ);
	});

	it('is nothing when it names no place', () => {
		for (const text of ['', '0', '1.0', '1.5', '1.1.480', '-1', 'two', '1.1.1.1', '1..2', '1.2x']) {
			expect(parsePosition(text, PPQ), text).toBeNull();
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
		expect(tempoWords([{ tick: 0, bpm: 120 }], 0, PPQ)).toMatch(/song's tempo/);
		expect(tempoWords(doc.tempo, 0, PPQ)).toMatch(/from bar 1, one of the song's 3 tempos/);
		expect(tempoWords(doc.tempo, 5760, PPQ)).toMatch(/Gliding from 120 BPM at bar 3 to 160 at bar 5/);
	});
});
