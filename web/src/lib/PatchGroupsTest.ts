import { describe, expect, it } from 'vitest';
import { exampleOf, filterGroups, patchGroups, type ExampleGroup } from '#lib/PatchGroups.ts';
import { EMPTY_GRAPH } from '#lib/Schema.ts';

const patch = (id: string, name: string, builtin = false) => ({ id, name, graph: EMPTY_GRAPH, builtin });

const examples: ExampleGroup[] = [
	{ name: 'pieces', recipes: [{ name: 'PassionChorale' }] },
	{ name: 'drums', recipes: [{ name: 'Kick808' }, { name: 'DrumLoop' }, { name: 'Snare' }] },
	{ name: 'effects', recipes: [{ name: 'Chorus' }] }
];

const library = [
	patch('b-uuid', 'bright saw'),
	patch('lead', 'Stereo lead'),
	patch('a-uuid', 'Air pad'),
	patch('builtin-Snare', 'Snare', true),
	patch('builtin-Kick808', 'Kick808', true),
	patch('builtin-PassionChorale-horn', 'PassionChorale Horn', true),
	patch('builtin-PassionChorale-bass', 'PassionChorale Bass', true),
	patch('builtin-Retired', 'Retired', true)
];

const shape = (groups: ReturnType<typeof patchGroups>) =>
	groups.map((group) => [group.label, group.builtin, group.patches.map((p) => p.id)]);

describe('the groups a patch picker shows', () => {
	it("names a built-in's example, the longest name that fits", () => {
		const names = ['Kick808', 'Kick', 'PassionChorale'];
		expect(exampleOf('builtin-Kick808', names)).toBe('Kick808');
		expect(exampleOf('builtin-Kick', names)).toBe('Kick');
		expect(exampleOf('builtin-PassionChorale-horn', names)).toBe('PassionChorale');
		expect(exampleOf('builtin-Kick808x', names)).toBeNull();
		expect(exampleOf('lead', names)).toBeNull();
	});

	it("puts the song's patches first, in the order it plays them, then the library's by name, then the built-ins", () => {
		const groups = patchGroups(library, ['builtin-Kick808', 'lead', 'lead', 'missing'], examples);
		expect(shape(groups)).toEqual([
			['On this song', false, ['builtin-Kick808', 'lead']],
			['My patches', false, ['a-uuid', 'b-uuid']],
			['pieces', true, ['builtin-PassionChorale-bass', 'builtin-PassionChorale-horn']],
			['drums', true, ['builtin-Snare']],
			['other', true, ['builtin-Retired']]
		]);
	});

	it('orders built-ins as the browser orders their examples, and leaves out empty groups', () => {
		const groups = patchGroups(library, [], examples);
		expect(groups.map((group) => group.label)).toEqual(['My patches', 'pieces', 'drums', 'other']);
		expect(groups[2].patches.map((p) => p.id)).toEqual(['builtin-Kick808', 'builtin-Snare']);
	});

	it('puts every built-in in one group with no heading of its own when there are no examples', () => {
		expect(shape(patchGroups(library.slice(3, 5), [], []))).toEqual([['', true, ['builtin-Kick808', 'builtin-Snare']]]);
	});

	it('filters by every word typed, in any case, and a built-in by its group too', () => {
		const groups = patchGroups(library, ['lead'], examples);
		expect(shape(filterGroups(groups, 'LEAD'))).toEqual([['On this song', false, ['lead']]]);
		expect(shape(filterGroups(groups, 'drums'))).toEqual([['drums', true, ['builtin-Kick808', 'builtin-Snare']]]);
		expect(shape(filterGroups(groups, ' snare  drums '))).toEqual([['drums', true, ['builtin-Snare']]]);
		expect(shape(filterGroups(groups, 'chorale horn'))).toEqual([['pieces', true, ['builtin-PassionChorale-horn']]]);
		expect(filterGroups(groups, 'song')).toEqual([]); // A heading of the library's own is not a name
		expect(filterGroups(groups, 'nothing like it')).toEqual([]);
		expect(filterGroups(groups, '  ')).toBe(groups);
	});
});
