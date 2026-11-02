import { describe, expect, it } from 'vitest';
import type { ProgramReport } from '#lib/Request.ts';
import { EMPTY_GRAPH, timelineSchema, type Graph } from '#lib/Schema.ts';
import {
	actionOn,
	draftKey,
	edited,
	graphError,
	hearing,
	parseGraph,
	withDrafts,
	withParams,
	type Draft
} from '#lib/Workspace.ts';

const voice: Graph = EMPTY_GRAPH;
const insert: Graph = {
	params: [],
	nodes: [
		{ id: 1, type: 'in' },
		{ id: 2, type: 'out' }
	],
	edges: [{ from: 1, port: 'l', to: 2, input: 'l' }]
};

const doc = timelineSchema.parse({
	clips: [{ id: 'c', length: 480, notes: [{ tick: 0, note: 60, dur: 100 }] }],
	tracks: [
		{ id: 1, name: 'Bass', slots: ['a'], placements: [{ clip: 'c', tick: 0 }], inserts: [{ id: 1, patch: 'fx' }] },
		{ id: 2, name: 'Keys', slots: ['b', 'a'], placements: [{ clip: 'c', tick: 0 }] },
		{ id: 3, name: 'Empty', slots: ['c'] }
	]
});

// Tracks 1 and 2 are in the image, at places that differ from their ids. Track 3 has no notes, so it isn't.
const program = {
	tracks: [
		{ id: 2, index: 0 },
		{ id: 1, index: 1 }
	]
} as unknown as ProgramReport;

describe('drafts', () => {
	it('reads a graph from its text, or says why it is not one', () => {
		expect(parseGraph('{"nodes": []}')).toEqual({ nodes: [], params: [], edges: [] });
		expect(parseGraph('{"nodes": 3}')).toBeNull();
		expect(parseGraph('{ not json')).toBeNull();
		expect(graphError('{"nodes": []}')).toBe('');
		expect(graphError('[]')).toBe('a graph needs a list of nodes');
		expect(graphError('{ not json')).not.toBe('');
	});

	it('shows the library with unsaved names and graphs, and the saved graph where the text never parsed', () => {
		const library = [
			{ id: 'a', name: 'A', graph: voice },
			{ id: 'b', name: 'B', graph: voice }
		];
		const drafts: Record<string, Draft> = {
			[draftKey('patch', 'a')]: { kind: 'patch', id: 'a', revision: 0, name: 'A2', text: '{', graph: insert },
			[draftKey('patch', 'b')]: { kind: 'patch', id: 'b', revision: 0, name: 'B2', text: '{' }
		};
		const shown = withDrafts(library, drafts);
		expect(shown.map((p) => p.name)).toEqual(['A2', 'B2']);
		expect(shown[0].graph).toBe(insert);
		expect(shown[1].graph).toBe(voice);
		expect(withDrafts(library, {})[0]).toBe(library[0]);
	});

	it('drops a draft that is back to what was saved, and keeps the revision it started from', () => {
		const saved = { kind: 'timeline' as const, id: 't', revision: 4, name: 'Song', text: '{}' };
		const first = edited(saved, undefined, { name: 'Song 2' });
		expect(first).toEqual({ ...saved, name: 'Song 2' });
		const second = edited(saved, { ...first!, revision: 5 }, { text: '{ }' });
		expect(second).toEqual({ ...saved, revision: 5, name: 'Song 2', text: '{ }' });
		expect(edited(saved, second!, { name: 'Song', text: '{}' })).toBeNull();
	});
});

describe('where keys are heard', () => {
	const patch = (id: string, graph = voice) => ({ id, name: id.toUpperCase(), graph });

	it('is the track that plays the patch, by its place in the image, and the chosen one first', () => {
		expect(hearing(doc, program, patch('a'), null, true)).toEqual({
			kind: 'song',
			track: 1,
			slot: 0,
			id: 1,
			name: 'Bass'
		});
		expect(hearing(doc, program, patch('a'), 2, true)).toEqual({
			kind: 'song',
			track: 0,
			slot: 1,
			id: 2,
			name: 'Keys'
		});
	});

	it('is the patch on its own when no track in the image plays it', () => {
		expect(hearing(doc, program, patch('c'), 3, true)).toEqual({ kind: 'alone' });
		expect(hearing(doc, program, patch('z'), null, true)).toEqual({ kind: 'alone' });
		expect(hearing(null, null, patch('a'), null, true)).toEqual({ kind: 'alone' });
		expect(hearing(doc, null, patch('a'), null, true)).toEqual({ kind: 'alone' }); // Nothing has compiled yet
	});

	it('is nowhere for an insert, or for what can only be heard in a song that leaves it out', () => {
		expect(hearing(doc, program, patch('fx', insert), null, true)).toEqual({
			kind: 'none',
			why: 'An insert has no keys. It is heard on Bass when that plays.'
		});
		expect(hearing(doc, program, patch('other', insert), null, true).kind).toBe('none');
		expect(hearing(doc, program, patch('c'), null, false)).toEqual({
			kind: 'none',
			why: 'Its track has no notes yet, so the image leaves it out.'
		});
		expect(hearing(doc, program, null, null, true).kind).toBe('none');
	});
});

describe('addresses', () => {
	it('changes some parameters and keeps the rest', () => {
		expect(withParams('?timeline=a&patch=b', { patch: 'c' })).toBe('?timeline=a&patch=c');
		expect(withParams('?timeline=a&patch=b', { patch: null, recipe: 'R' })).toBe('?timeline=a&recipe=R');
		expect(withParams('?patch=b', { patch: null })).toBe('?');
	});

	it('sends an action from where the page is, so the page stays there', () => {
		expect(actionOn('?timeline=a&patch=b', 'save')).toBe('?timeline=a&patch=b&/save');
		expect(actionOn('', 'save')).toBe('?/save');
		expect(actionOn('?timeline=a&/old', 'save')).toBe('?timeline=a&/save');
	});
});
