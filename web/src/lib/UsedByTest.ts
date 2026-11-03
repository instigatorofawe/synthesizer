import { describe, expect, it } from 'vitest';
import { timelineSchema, type Graph } from '#lib/Schema.ts';
import { playedBy, playedOn, usedBy } from '#lib/UsedBy.ts';

const graph = (...subpatches: string[]): Graph => ({
	params: [],
	nodes: subpatches.map((patch, index) => ({ id: index + 1, type: 'subpatch', patch })),
	edges: []
});

const patches = [
	{ id: 'lead', name: 'Lead', graph: graph() },
	{ id: 'pair', name: 'Pair', graph: graph() },
	{ id: 'voice', name: 'Voice', graph: graph('pair') },
	{ id: 'stack', name: 'Stack', graph: graph('voice') }
];

const timelines = [
	{ id: 'song', name: 'Song', patches: ['lead'] },
	{ id: 'ballad', name: 'Ballad', patches: ['stack'] },
	{ id: 'empty', name: 'Empty', patches: [] }
];

const none = new Map<string, { name: string; patches: string[] }>();

describe('used by', () => {
	it('is every timeline that plays the patch, or a patch that expands it however deep, by name', () => {
		expect(usedBy('lead', patches, timelines, none)).toEqual([{ id: 'song', name: 'Song' }]);
		expect(usedBy('pair', patches, timelines, none)).toEqual([{ id: 'ballad', name: 'Ballad' }]);
		expect(usedBy('nothing', patches, timelines, none)).toEqual([]);
	});

	it('counts an unsaved edit as it is now, under its unsaved name', () => {
		const now = new Map([
			['empty', { name: 'Mine', patches: ['lead'] }],
			['song', { name: 'Song', patches: [] }]
		]);
		expect(usedBy('lead', patches, timelines, now)).toEqual([{ id: 'empty', name: 'Mine' }]);
	});

	it('follows the graphs as they are now', () => {
		const edited = patches.map((patch) => (patch.id === 'voice' ? { ...patch, graph: graph() } : patch));
		expect(usedBy('pair', edited, timelines, none)).toEqual([]);
		expect(usedBy('voice', edited, timelines, none)).toEqual([{ id: 'ballad', name: 'Ballad' }]);
	});

	it('ends for a patch that expands itself', () => {
		const looped = [...patches, { id: 'loop', name: 'Loop', graph: graph('loop') }];
		const playing = [{ id: 'x', name: 'X', patches: ['loop'] }];
		expect(usedBy('loop', looped, playing, none)).toEqual([{ id: 'x', name: 'X' }]);
	});
});

describe('what a timeline plays', () => {
	it('comes from its text, or is null for text that is not a timeline', () => {
		const doc = { tracks: [{ id: 1, slots: ['b', 'a'], inserts: [{ patch: 'fx' }] }], master: { inserts: [] } };
		expect(playedBy(JSON.stringify(doc))).toEqual(['a', 'b', 'fx']);
		expect(playedBy('{"tracks": [')).toBeNull();
		expect(playedBy('{"tracks": 3}')).toBeNull();
	});
});

describe('the track a copy is chosen on', () => {
	const doc = timelineSchema.parse({
		tracks: [
			{ id: 1, slots: ['pad'], inserts: [{ patch: 'duck' }] },
			{ id: 2, slots: ['kick'] },
			{ id: 3, slots: ['other', 'kick'] }
		],
		buses: [{ id: 'room', inserts: [{ patch: 'reverb' }] }]
	});

	it('is the one the keys played it on, if it plays it', () => {
		expect(playedOn(doc, 'kick', 3)).toBe(3);
		expect(playedOn(doc, 'duck', 1)).toBe(1);
	});

	it('is otherwise the first that plays it as a voice, then the first with it as an insert', () => {
		expect(playedOn(doc, 'kick', 1)).toBe(2);
		expect(playedOn(doc, 'kick', null)).toBe(2);
		expect(playedOn(doc, 'duck', 2)).toBe(1);
	});

	it('is none for a patch no track plays', () => {
		expect(playedOn(doc, 'reverb', 1)).toBeNull();
		expect(playedOn(doc, 'nothing', null)).toBeNull();
	});
});
