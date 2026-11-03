import { describe, expect, it } from 'vitest';
import { GROUPS, NODE_HELP, rangeText, searchNodes, shown } from '#lib/NodeHelp.ts';
import { nodeCatalog } from '#lib/server/Compile.ts';

// The editor's words for each node have to keep up with the compiler's table, as CatalogTest holds the schema to it. A node or
// an input this table lacks would be drawn with no name, unit or range, and one only it has is left over from something gone.
describe('what the editor says about each node', () => {
	it('covers every node type the compiler offers, and no others', async () => {
		const types = (await nodeCatalog()).map((entry) => entry.type);
		expect(Object.keys(NODE_HELP).sort()).toEqual([...types].sort());
	});

	it('covers every input of every node, and no others', async () => {
		for (const entry of await nodeCatalog()) {
			expect(Object.keys(NODE_HELP[entry.type].inputs).sort(), entry.type).toEqual(
				entry.inputs.map((input) => input.name).sort()
			);
		}
	});

	it('gives each node a name of its own, a group and a line on what it does', () => {
		const names = Object.values(NODE_HELP).map((help) => help.name);
		expect(new Set(names).size).toBe(names.length);
		for (const [type, help] of Object.entries(NODE_HELP)) {
			expect(GROUPS, type).toContain(help.group);
			expect(help.description, type).toMatch(/^\S.*\.$/);
			expect(help.description.length, type).toBeLessThan(100);
		}
	});

	it('gives each range its low end first', () => {
		for (const help of Object.values(NODE_HELP))
			for (const input of Object.values(help.inputs))
				if (typeof input.min === 'number' && typeof input.max === 'number') expect(input.min).toBeLessThan(input.max);
	});
});

describe('how numbers and ranges read', () => {
	it('rounds what a single-precision default prints as', () => {
		expect(shown(0.009999999776482582)).toBe('0.01');
		expect(shown(0.7070000171661377)).toBe('0.707');
		expect(shown(440)).toBe('440');
		expect(shown(-0.995)).toBe('-0.995');
	});

	it('says a range in words, however much of it is known', () => {
		expect(rangeText(NODE_HELP.env.inputs.attack)).toBe('0.0001 to 60');
		expect(rangeText(NODE_HELP.biquad.inputs.cutoff)).toBe('10 to 0.45 × sample rate');
		expect(rangeText(NODE_HELP.delay.inputs.time)).toBe('up to its max');
		expect(rangeText({ min: 0 })).toBe('from 0');
		expect(rangeText(NODE_HELP.mul.inputs.a)).toBe('');
		expect(rangeText(undefined)).toBe('');
	});
});

describe('searching for a node', () => {
	const types = Object.keys(NODE_HELP);
	const found = (query: string) => searchNodes(query, types).flatMap((group) => group.matches.map((m) => m.type));

	it('finds a node by what it does as well as what the compiler calls it', () => {
		expect(found('filter')[0]).toBe('biquad');
		expect(found('filter')).toEqual(expect.arrayContaining(['comb', 'allpass']));
		expect(found('biquad')[0]).toBe('biquad');
		expect(found('envelope')[0]).toBe('env');
		expect(found('adsr')[0]).toBe('env');
		expect(found('low-pass')[0]).toBe('biquad');
		expect(found('vca')[0]).toBe('mul');
	});

	it('finds the oscillator a patch uses as an LFO, after the LFO itself', () => {
		expect(found('lfo')[0]).toBe('lfo');
		expect(found('lfo')).toContain('osc');
	});

	it('wants every word of a query', () => {
		expect(found('comb filter')).toEqual(['comb']);
		expect(found('zzz')).toEqual([]);
	});

	it('lists everything under its group, in the groups’ order, when nothing is typed', () => {
		const groups = searchNodes('', types);
		expect(groups.map((group) => group.group)).toEqual([...GROUPS]);
		expect(groups.flatMap((group) => group.matches)).toHaveLength(types.length);
	});

	it('offers only the types it is given', () => {
		expect(found('').length).toBe(types.length);
		expect(searchNodes('filter', ['comb', 'osc']).flatMap((group) => group.matches.map((m) => m.type))).toEqual([
			'comb'
		]);
	});
});
