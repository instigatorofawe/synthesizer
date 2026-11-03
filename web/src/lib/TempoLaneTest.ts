import { describe, expect, it } from 'vitest';
import { timelineSchema, type Timeline } from '#lib/Schema.ts';
import {
	addTempoAt,
	bpmText,
	bpmToY,
	canGlide,
	isFirstTempo,
	labelsShown,
	moveTempo,
	nudgeTempo,
	roundBpm,
	tempoRange,
	tempoSegments,
	tempoSummary,
	tempoThere,
	tempoTick,
	toggleGlide,
	yToBpm
} from '#lib/TempoLane.ts';
import type { Tempo } from '#lib/TimelineEdit.ts';

const BAR = 1920; // At 480 ticks a beat
const song = (tempo: Tempo[]): Timeline => timelineSchema.parse({ tempo });

describe('the lane’s range', () => {
	it('fits the song’s tempos, with room above and below, in tens', () => {
		expect(tempoRange([{ tick: 0, bpm: 120 }])).toEqual({ low: 110, high: 130 });
		expect(tempoRange([{ tick: 0, bpm: 140 }])).toEqual({ low: 130, high: 150 });
		expect(tempoRange([{ tick: 0, bpm: 117.5 }])).toEqual({ low: 100, high: 130 });
		// A sixth of the spread, once that is more than 10
		expect(
			tempoRange([
				{ tick: 0, bpm: 60 },
				{ tick: BAR, bpm: 180 }
			])
		).toEqual({ low: 40, high: 200 });
	});

	it('stays within what the schema allows, and is never empty', () => {
		expect(tempoRange([{ tick: 0, bpm: 1 }])).toEqual({ low: 0, high: 20 });
		expect(tempoRange([{ tick: 0, bpm: 1000 }])).toEqual({ low: 990, high: 1000 });
		expect(tempoRange([])).toEqual({ low: 110, high: 130 });
	});
});

describe('BPM and y', () => {
	const range = { low: 100, high: 140 };

	it('puts the top of the range at the top, less the pad, and the foot at the foot', () => {
		expect(bpmToY(140, range, 72, 9)).toBe(9);
		expect(bpmToY(100, range, 72, 9)).toBe(63);
		expect(bpmToY(120, range, 72, 9)).toBe(36);
	});

	it('goes both ways, and on past the lane’s edges', () => {
		for (const bpm of [80, 100, 117.5, 140, 200])
			expect(yToBpm(bpmToY(bpm, range, 72, 9), range, 72, 9)).toBeCloseTo(bpm, 9);
		expect(yToBpm(-45, range, 72, 9)).toBeCloseTo(180, 9);
	});

	it('rounds a drag to a whole BPM, or a tenth, within 1 to 1000', () => {
		expect(roundBpm(117.46)).toBe(117);
		expect(roundBpm(117.46, true)).toBe(117.5);
		expect(roundBpm(-20)).toBe(1);
		expect(roundBpm(0.4, true)).toBe(1);
		expect(roundBpm(1400)).toBe(1000);
	});
});

describe('moving a change', () => {
	const tempo: Tempo[] = [
		{ tick: 0, bpm: 120 },
		{ tick: 2 * BAR, bpm: 90, ramp: true },
		{ tick: 4 * BAR, bpm: 140 }
	];

	it('snaps it to the grid', () => {
		expect(tempoTick(tempo, 1, 2 * BAR + 300, 480)).toBe(2 * BAR + 480);
		expect(tempoTick(tempo, 1, BAR + 100, BAR)).toBe(BAR);
	});

	it('keeps it between its neighbours, on the nearest line of the grid still between them', () => {
		expect(tempoTick(tempo, 1, 9 * BAR, BAR)).toBe(3 * BAR);
		expect(tempoTick(tempo, 1, 0, BAR)).toBe(BAR);
		expect(tempoTick(tempo, 1, 0, 1)).toBe(1);
		expect(tempoTick(tempo, 2, 2 * BAR, BAR)).toBe(3 * BAR);
		expect(tempoTick(tempo, 2, 99 * BAR, BAR)).toBe(99 * BAR); // The last can go on past the song
	});

	it('leaves it where it is when no line of the grid is left between them', () => {
		const close: Tempo[] = [
			{ tick: 0, bpm: 120 },
			{ tick: 100, bpm: 100 },
			{ tick: 200, bpm: 80 }
		];
		expect(tempoTick(close, 1, 900, BAR)).toBe(100);
	});

	it('never moves the first change sideways', () => {
		expect(tempoTick(tempo, 0, 3 * BAR, BAR)).toBe(0);
		const doc = moveTempo(song(tempo), 0, 3 * BAR, 100, BAR);
		expect(doc.tempo[0]).toEqual({ tick: 0, bpm: 100 });
	});

	it('moves its tempo and tick, keeping its glide, and is the same song if neither moved', () => {
		const doc = song(tempo);
		expect(moveTempo(doc, 1, 3 * BAR, 96, BAR).tempo).toEqual([
			{ tick: 0, bpm: 120 },
			{ tick: 3 * BAR, bpm: 96, ramp: true },
			{ tick: 4 * BAR, bpm: 140 }
		]);
		expect(moveTempo(doc, 1, 2 * BAR, 90, BAR)).toBe(doc);
		expect(moveTempo(doc, 7, 2 * BAR, 90, BAR)).toBe(doc);
	});

	it('works on a list that is out of order, by tick', () => {
		const muddled: Tempo[] = [
			{ tick: 4 * BAR, bpm: 140 },
			{ tick: 0, bpm: 120 },
			{ tick: 2 * BAR, bpm: 90 }
		];
		expect(tempoTick(muddled, 2, 9 * BAR, BAR)).toBe(3 * BAR);
		expect(isFirstTempo(muddled, 1)).toBe(true);
		expect(isFirstTempo(muddled, 0)).toBe(false);
		expect(moveTempo(song(muddled), 2, 3 * BAR, 90, BAR).tempo.map((t) => t.tick)).toEqual([0, 3 * BAR, 4 * BAR]);
	});
});

describe('adding a change', () => {
	it('adds it at the tick, and says where it is in the list', () => {
		const added = addTempoAt(song([{ tick: 0, bpm: 120 }]), 2 * BAR, 120);
		expect(added.doc.tempo).toEqual([
			{ tick: 0, bpm: 120 },
			{ tick: 2 * BAR, bpm: 120 }
		]);
		expect(added.index).toBe(1);
	});

	it('gives the change already at that tick instead', () => {
		const doc = song([
			{ tick: 0, bpm: 120 },
			{ tick: BAR, bpm: 100 }
		]);
		expect(addTempoAt(doc, BAR, 80)).toEqual({ doc, index: 1 });
	});

	it('adds at the tempo playing there, which inside a glide leaves the curve as it was', () => {
		const tempo: Tempo[] = [
			{ tick: 0, bpm: 120, ramp: true },
			{ tick: 3 * BAR, bpm: 100 }
		];
		expect(tempoThere(tempo, BAR)).toBe(113.33);
		const added = addTempoAt(song(tempo), BAR, tempoThere(tempo, BAR));
		expect(added.doc.tempo[1]).toEqual({ tick: BAR, bpm: 113.33, ramp: true });
	});
});

describe('holding and gliding', () => {
	const doc = song([
		{ tick: 0, bpm: 120 },
		{ tick: 2 * BAR, bpm: 90 }
	]);

	it('switches a change between them', () => {
		const gliding = toggleGlide(doc, 0);
		expect(gliding.tempo[0]).toEqual({ tick: 0, bpm: 120, ramp: true });
		expect(toggleGlide(gliding, 0).tempo[0]).toEqual({ tick: 0, bpm: 120 });
	});

	it('leaves the last alone, which has nowhere to glide to', () => {
		expect(canGlide(doc.tempo, 1)).toBe(false);
		expect(canGlide(doc.tempo, 0)).toBe(true);
		expect(toggleGlide(doc, 1)).toBe(doc);
		expect(toggleGlide(doc, 5)).toBe(doc);
	});
});

describe('nudging a change', () => {
	const doc = song([{ tick: 0, bpm: 117.33 }]);

	it('goes by the BPM asked for, clear of float noise', () => {
		expect(nudgeTempo(doc, 0, 1).tempo[0].bpm).toBe(118.33);
		expect(nudgeTempo(doc, 0, -10).tempo[0].bpm).toBe(107.33);
	});

	it('stops at what the schema allows', () => {
		expect(nudgeTempo(song([{ tick: 0, bpm: 995 }]), 0, 10).tempo[0].bpm).toBe(1000);
		const slowest = song([{ tick: 0, bpm: 1 }]);
		expect(nudgeTempo(slowest, 0, -1)).toBe(slowest);
	});
});

describe('what the lane draws', () => {
	it('holds a change until the next, and glides where it ramps, out to the end', () => {
		const segments = tempoSegments(
			[
				{ tick: 0, bpm: 120 },
				{ tick: 2 * BAR, bpm: 90, ramp: true },
				{ tick: 4 * BAR, bpm: 140 }
			],
			8 * BAR
		);
		expect(segments).toEqual([
			{ index: 0, next: 1, from: { tick: 0, bpm: 120 }, to: { tick: 2 * BAR, bpm: 120 }, glide: null },
			{ index: 1, next: 2, from: { tick: 2 * BAR, bpm: 90 }, to: { tick: 4 * BAR, bpm: 140 }, glide: 'up' },
			{ index: 2, next: null, from: { tick: 4 * BAR, bpm: 140 }, to: { tick: 8 * BAR, bpm: 140 }, glide: null }
		]);
	});

	it('draws the engine’s 120 before a first change past the start, and in tick order', () => {
		const segments = tempoSegments(
			[
				{ tick: 3 * BAR, bpm: 80 },
				{ tick: BAR, bpm: 100, ramp: true }
			],
			2 * BAR
		);
		expect(segments.map((s) => [s.index, s.from.tick, s.to.tick, s.to.bpm, s.glide])).toEqual([
			[null, 0, BAR, 120, null],
			[1, BAR, 3 * BAR, 80, 'down'],
			[0, 3 * BAR, 3 * BAR, 80, null]
		]);
	});

	it('shows the labels that fit, left to right', () => {
		expect(labelsShown([0, 10, 30, 31, 80], [20, 20, 20, 20, 20])).toEqual([true, false, true, false, true]);
		expect(labelsShown([], [])).toEqual([]);
	});
});

describe('the tempo in words', () => {
	it('reads the song’s changes, and how each one is reached', () => {
		expect(tempoSummary([{ tick: 0, bpm: 140 }], 480)).toBe('140 BPM');
		expect(
			tempoSummary(
				[
					{ tick: 0, bpm: 140, ramp: true },
					{ tick: 2 * BAR, bpm: 100 },
					{ tick: 4 * BAR, bpm: 120 }
				],
				480
			)
		).toBe('140 BPM, gliding to 100 by bar 3, 120 from bar 5');
		expect(tempoSummary([{ tick: BAR, bpm: 96.5 }], 480)).toBe('96.5 BPM from bar 2');
	});

	it('writes a tempo as it is, to a hundredth', () => {
		expect(bpmText(120)).toBe('120');
		expect(bpmText(113.333333)).toBe('113.33');
	});
});
