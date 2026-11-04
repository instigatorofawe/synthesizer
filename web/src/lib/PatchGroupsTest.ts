import { describe, expect, it } from 'vitest';
import { exampleOf, filterGroups, patchGroups, TECHNIQUES, type ExampleGroup } from '#lib/PatchGroups.ts';
import { EMPTY_GRAPH } from '#lib/Schema.ts';

const patch = (id: string, name: string, builtin = false) => ({ id, name, graph: EMPTY_GRAPH, builtin });

const examples: ExampleGroup[] = [
	{ name: 'pieces', recipes: [{ name: 'PassionChorale' }] },
	{ name: 'drums', recipes: [{ name: 'Kick808' }, { name: 'DrumLoop' }, { name: 'Snare' }] },
	{ name: 'effects', recipes: [{ name: 'Chorus' }] }
];

// The standard set's examples, as the browser lists them after the pieces. The effects' example plays the grand piano too.
const set: ExampleGroup = {
	name: 'instruments',
	recipes: [
		{ name: 'Piano', family: 'Piano', patches: ['builtin-gm-GrandPiano', 'builtin-gm-Harpsichord'] },
		{ name: 'Organ', family: 'Organ', patches: ['builtin-gm-DrawbarOrgan'] },
		{ name: 'DrumKit', family: 'Drum kit', patches: ['builtin-gm-Kick', 'builtin-gm-Snare'] },
		{ name: 'Effects', family: 'Effects', patches: ['builtin-gm-GrandPiano', 'builtin-gm-LargeHall'] }
	]
};
const withSet = [examples[0], set, ...examples.slice(1)];

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
			[TECHNIQUES, true, ['builtin-PassionChorale-bass', 'builtin-PassionChorale-horn', 'builtin-Snare']],
			['other', true, ['builtin-Retired']]
		]);
	});

	it('orders the techniques as the browser orders their examples, and leaves out empty groups', () => {
		const groups = patchGroups(library, [], examples);
		expect(groups.map((group) => group.label)).toEqual(['My patches', TECHNIQUES, 'other']);
		expect(groups[1].patches.map((p) => p.id)).toEqual([
			'builtin-PassionChorale-bass',
			'builtin-PassionChorale-horn',
			'builtin-Kick808',
			'builtin-Snare'
		]);
	});

	it("puts the set's patches first, under their families, each in the order its example plays them", () => {
		const groups = patchGroups(
			[
				...library,
				patch('builtin-gm-LargeHall', 'Large hall', true),
				patch('builtin-gm-Snare', 'Snare', true),
				patch('builtin-gm-Kick', 'Kick', true),
				patch('builtin-gm-Harpsichord', 'Harpsichord', true),
				patch('builtin-gm-GrandPiano', 'Grand piano', true),
				patch('builtin-gm-Retired', 'Retired instrument', true)
			],
			['builtin-gm-Harpsichord'],
			withSet
		);
		expect(shape(groups)).toEqual([
			['On this song', false, ['builtin-gm-Harpsichord']],
			['My patches', false, ['a-uuid', 'b-uuid', 'lead']],
			['Piano', true, ['builtin-gm-GrandPiano']],
			['Drum kit', true, ['builtin-gm-Kick', 'builtin-gm-Snare']],
			['Effects', true, ['builtin-gm-LargeHall']],
			[
				TECHNIQUES,
				true,
				['builtin-PassionChorale-bass', 'builtin-PassionChorale-horn', 'builtin-Kick808', 'builtin-Snare']
			],
			['other', true, ['builtin-Retired', 'builtin-gm-Retired']]
		]);
	});

	it('puts every built-in in one group with no heading of its own when there are no examples', () => {
		expect(shape(patchGroups(library.slice(3, 5), [], []))).toEqual([['', true, ['builtin-Kick808', 'builtin-Snare']]]);
	});

	it("filters by every word typed, in any case, and a built-in by its family's or its example group's name too", () => {
		const groups = patchGroups(
			[...library, patch('builtin-gm-Kick', 'Kick', true), patch('builtin-gm-GrandPiano', 'Grand piano', true)],
			['lead'],
			withSet
		);
		expect(shape(filterGroups(groups, 'LEAD'))).toEqual([['On this song', false, ['lead']]]);
		expect(shape(filterGroups(groups, 'drum'))).toEqual([
			['Drum kit', true, ['builtin-gm-Kick']],
			[TECHNIQUES, true, ['builtin-Kick808', 'builtin-Snare']]
		]);
		expect(shape(filterGroups(groups, 'piano'))).toEqual([['Piano', true, ['builtin-gm-GrandPiano']]]);
		expect(shape(filterGroups(groups, ' snare  drums '))).toEqual([[TECHNIQUES, true, ['builtin-Snare']]]);
		expect(shape(filterGroups(groups, 'chorale horn'))).toEqual([[TECHNIQUES, true, ['builtin-PassionChorale-horn']]]);
		expect(shape(filterGroups(groups, 'techniques kick'))).toEqual([[TECHNIQUES, true, ['builtin-Kick808']]]);
		expect(filterGroups(groups, 'song')).toEqual([]); // A heading of the library's own is not a name
		expect(filterGroups(groups, 'nothing like it')).toEqual([]);
		expect(filterGroups(groups, '  ')).toBe(groups);
	});
});
