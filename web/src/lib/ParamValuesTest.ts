import { describe, expect, it } from 'vitest';
import { setSongValue, songValue, typedValue, unitOf, valueText, withDefault } from '#lib/ParamValues.ts';
import { graphSchema, timelineSchema } from '#lib/Schema.ts';

// A filter whose cutoff a parameter sets, a resonance another sets, and a level that goes through a multiply, so it has no unit.
const graph = graphSchema.parse({
	params: [
		{ id: 1, name: 'cutoff', min: 80, max: 12000, default: 900 },
		{ id: 2, name: 'q', min: 0.5, max: 10, default: 0.7 },
		{ id: 3, name: 'level', scope: 'global', min: 0, max: 1, default: 1 },
		{ id: 4, name: 'loose', min: 0, max: 1, default: 0 }
	],
	nodes: [
		{ id: 1, type: 'note' },
		{ id: 2, type: 'osc', wave: 'saw' },
		{ id: 3, type: 'biquad' },
		{ id: 4, type: 'param', param: 1 },
		{ id: 5, type: 'param', param: 2 },
		{ id: 6, type: 'param', param: 3 },
		{ id: 7, type: 'mul' },
		{ id: 8, type: 'out' },
		{ id: 9, type: 'ratio' },
		{ id: 10, type: 'param', param: 1 }
	],
	edges: [
		{ from: 2, to: 3, input: 'in' },
		{ from: 4, to: 3, input: 'cutoff' },
		{ from: 10, to: 3, input: 'cutoff' },
		{ from: 5, to: 3, input: 'q' },
		{ from: 3, to: 7, input: 'a' },
		{ from: 6, to: 7, input: 'b' },
		{ from: 7, to: 8, input: 'l' }
	]
});

describe("a parameter's unit", () => {
	it('is the unit of the input its param nodes drive', () => {
		expect(unitOf(graph, 1)).toBe('Hz');
	});

	it('is none for an input with no unit, one reached through a node, or a parameter wired to nothing', () => {
		expect(unitOf(graph, 2)).toBe('');
		expect(unitOf(graph, 3)).toBe('');
		expect(unitOf(graph, 4)).toBe('');
	});

	it('is none when its inputs have different units', () => {
		const mixed = { ...graph, edges: [...graph.edges, { from: 4, to: 9, input: 'in' }] };
		expect(unitOf(mixed, 1)).toBe('');
	});
});

describe('a value in words', () => {
	it('is rounded as the inspector rounds, with its unit', () => {
		expect(valueText(900, 'Hz')).toBe('900 Hz');
		expect(valueText(0.009999999776482582, 's')).toBe('0.01 s');
		expect(valueText(0.7071, '')).toBe('0.7071');
		expect(valueText(2, '×')).toBe('2×');
	});
});

describe('a typed value', () => {
	const range = { min: 80, max: 12000 };

	it('is a number, with or without a unit after it', () => {
		expect(typedValue('900', range)).toBe(900);
		expect(typedValue(' 1250.5 Hz', range)).toBe(1250.5);
		expect(typedValue('+100', range)).toBe(100);
	});

	it('is kept to the range', () => {
		expect(typedValue('20000', range)).toBe(12000);
		expect(typedValue('-3', range)).toBe(80);
	});

	it('is nothing when it is no number', () => {
		for (const text of ['', 'loud', 'Hz', 'NaN']) expect(typedValue(text, range), text).toBeNull();
	});
});

describe('what the song holds', () => {
	const doc = timelineSchema.parse({
		tracks: [
			{ id: 1, slots: ['p'], params: { '1': 2000 } },
			{ id: 2, slots: ['p'] }
		],
		globals: { '3': 0.5 }
	});
	const [cutoff, , level] = graph.params;

	it("is a track's own value, or the song's for a global", () => {
		expect(songValue(doc, 1, cutoff)).toBe(2000);
		expect(songValue(doc, 2, cutoff)).toBeUndefined();
		expect(songValue(doc, 2, level)).toBe(0.5);
		expect(songValue(doc, 9, cutoff)).toBeUndefined();
	});

	it('is set on that track alone, and for a global on the song', () => {
		const set = setSongValue(doc, 2, cutoff, 900);
		expect(set.tracks[1].params).toEqual({ '1': 900 });
		expect(set.tracks[0].params).toEqual({ '1': 2000 });
		expect(setSongValue(doc, 2, level, 0.25).globals).toEqual({ '3': 0.25 });
		expect(setSongValue(doc, 2, level, 0.25).tracks).toBe(doc.tracks);
	});

	it('is written even when it is the default, so the song says what it holds', () => {
		expect(setSongValue(doc, 2, cutoff, cutoff.default).tracks[1].params).toEqual({ '1': 900 });
	});

	it('goes, leaving the default to play, and leaves the song as it was when there was none', () => {
		expect(setSongValue(doc, 1, cutoff, undefined).tracks[0].params).toEqual({});
		expect(setSongValue(doc, 1, level, undefined).globals).toEqual({});
		expect(setSongValue(doc, 2, cutoff, undefined)).toBe(doc);
		expect(setSongValue(timelineSchema.parse({}), 1, level, undefined).globals).toEqual({});
	});
});

describe('Make default', () => {
	it("writes the patch's default, kept to its range, and changes nothing else", () => {
		const made = withDefault(graph, 1, 2400);
		expect(made.params[0]).toEqual({ ...graph.params[0], default: 2400 });
		expect(made.params.slice(1)).toEqual(graph.params.slice(1));
		expect(made.nodes).toBe(graph.nodes);
		expect(withDefault(graph, 1, 99999).params[0].default).toBe(12000);
	});
});
