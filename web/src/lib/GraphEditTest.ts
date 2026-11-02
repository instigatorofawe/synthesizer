import { describe, expect, it } from 'vitest';
import {
	addNode,
	connect,
	detailOf,
	disconnect,
	edgeInto,
	inputsOf,
	layout,
	moveNode,
	nodeOfError,
	outputsOf,
	parseCurve,
	placed,
	removeNode,
	setLiteral,
	setOption,
	type CatalogEntry,
	type LibraryPatch
} from '#lib/GraphEdit.ts';
import { probeTargets } from '#lib/AudioEngine.ts';
import { reachable, type AssetEntry } from '#lib/Request.ts';
import { referencedSubpatches, type Graph } from '#lib/Schema.ts';

const catalog: CatalogEntry[] = [
	{ type: 'note', inputs: [], outputs: ['pitch', 'velocity', 'gate'], options: [] },
	{
		type: 'osc',
		inputs: ['freq', 'width', 'phase', 'sync', 'feedback'].map((name) => ({ name, default: 0 })),
		outputs: ['out'],
		options: []
	},
	{
		type: 'math',
		inputs: ['a', 'b', 'c'].map((name) => ({ name, default: 0 })),
		outputs: ['out'],
		options: []
	},
	{ type: 'out', inputs: ['l', 'r'].map((name) => ({ name, default: 0 })), outputs: [], options: [] },
	{
		type: 'sample',
		inputs: ['ratio', 'note', 'start'].map((name) => ({ name, default: 0 })),
		outputs: ['l', 'r'],
		options: []
	}
];

const graph = (nodes: Graph['nodes'], edges: Graph['edges'] = []): Graph => ({ params: [], nodes, edges });

const names = (node: Graph['nodes'][number], library: LibraryPatch[] = []) =>
	inputsOf(node, catalog, library).map((input) => input.name);

describe('which ports a node shows', () => {
	it('offers only what an oscillator reads in its mode', () => {
		expect(names({ id: 1, type: 'osc' })).toEqual(['freq']);
		expect(names({ id: 1, type: 'osc', wave: 'square' })).toEqual(['freq', 'width']);
		expect(names({ id: 1, type: 'osc', mode: 'mod' })).toEqual(['freq', 'phase', 'sync', 'feedback']);
		expect(names({ id: 1, type: 'osc', wave: 'saw', mode: 'mod' })).toEqual(['freq', 'phase', 'sync']);
		expect(names({ id: 1, type: 'osc', wave: 'square', mode: 'mod-naive' })).toEqual([
			'freq',
			'width',
			'phase',
			'sync'
		]);
	});

	it('offers only what a math mode reads, with the defaults the compiler uses', () => {
		expect(names({ id: 1, type: 'math', mode: 'abs' })).toEqual(['a']);
		expect(names({ id: 1, type: 'math' })).toEqual(['a', 'b']);
		const clip = inputsOf({ id: 1, type: 'math', mode: 'clip' }, catalog, []);
		expect(clip.map((input) => input.default)).toEqual([0, -1, 1]);
	});

	it('follows a sample between its two modes', () => {
		expect(names({ id: 1, type: 'sample' })).toEqual(['ratio']);
		expect(names({ id: 1, type: 'sample', mode: 'zones' })).toEqual(['note', 'start']);
	});

	it('takes a subpatch from the graph it names', () => {
		const library: LibraryPatch[] = [
			{
				id: 'inner',
				name: 'Inner',
				graph: graph([
					{ id: 1, type: 'inlet', name: 'cutoff', default: 800 },
					{ id: 2, type: 'in' },
					{ id: 3, type: 'outlet', name: 'raw' },
					{ id: 4, type: 'out' }
				])
			}
		];
		const node = { id: 9, type: 'subpatch' as const, patch: 'inner' };
		expect(inputsOf(node, catalog, library)).toEqual([
			{ name: 'cutoff', default: 800 },
			{ name: 'l', default: 0 },
			{ name: 'r', default: 0 }
		]);
		expect(outputsOf(node, catalog, library)).toEqual(['raw', 'l', 'r']);
		expect(outputsOf({ id: 9, type: 'subpatch', patch: 'gone' }, catalog, library)).toEqual([]);
	});
});

describe('editing a graph', () => {
	const start = graph(
		[
			{ id: 1, type: 'note' },
			{ id: 2, type: 'osc' },
			{ id: 3, type: 'out' }
		],
		[
			{ from: 1, port: 'pitch', to: 2, input: 'freq' },
			{ from: 2, to: 3, input: 'l' }
		]
	);

	it('gives a new node an unused id', () => {
		const { graph: next, id } = addNode(start, 'math', 10, 20);
		expect(id).toBe(4);
		expect(next.nodes.at(-1)).toEqual({ id: 4, type: 'math', x: 10, y: 20 });
	});

	it('takes a node and its wires away together', () => {
		const next = removeNode(start, 2);
		expect(next.nodes.map((node) => node.id)).toEqual([1, 3]);
		expect(next.edges).toEqual([]);
	});

	it('replaces what drove an input, because an input takes one wire', () => {
		const next = connect(start, 1, 'velocity', 2, 'freq');
		expect(next.edges.filter((edge) => edge.to === 2)).toEqual([{ from: 1, port: 'velocity', to: 2, input: 'freq' }]);
		expect(next.edges).toHaveLength(2);
	});

	it('finds and removes a wire written without its input name', () => {
		const shorthand = graph(
			[
				{ id: 1, type: 'osc' },
				{ id: 2, type: 'snap' }
			],
			[{ from: 1, to: 2 }]
		);
		expect(edgeInto(shorthand, 2, 'in')).toBeDefined();
		expect(disconnect(shorthand, 2, 'in').edges).toEqual([]);
	});

	it('sets and clears a typed-in value, and leaves no empty inputs behind', () => {
		const set = setLiteral(start, 2, 'freq', 220);
		expect(set.nodes[1].inputs).toEqual({ freq: 220 });
		expect('inputs' in setLiteral(set, 2, 'freq', undefined).nodes[1]).toBe(false);
	});

	it('drops a wire on an input a mode took away', () => {
		const wired = connect(setOption(start, 2, 'mode', 'mod', catalog, []), 1, 'gate', 2, 'sync');
		expect(edgeInto(wired, 2, 'sync')).toBeDefined();
		const back = setOption(wired, 2, 'mode', undefined, catalog, []);
		expect(edgeInto(back, 2, 'sync')).toBeUndefined();
		expect(edgeInto(back, 2, 'freq')).toBeDefined();
		expect('mode' in back.nodes[1]).toBe(false);
	});

	it('keeps every other node where it was when one moves', () => {
		const laid = placed(start);
		const moved = moveNode(laid, 2, 500, 500);
		expect(moved.nodes[1]).toMatchObject({ x: 500, y: 500 });
		expect(moved.nodes[0]).toEqual(laid.nodes[0]);
		expect(placed(moved)).toBe(moved);
	});

	it('does not change a graph it can only read', () => {
		const frozen = structuredClone(start);
		connect(start, 1, 'gate', 3, 'r');
		removeNode(start, 1);
		setLiteral(start, 1, 'x', 1);
		expect(start).toEqual(frozen);
	});
});

describe('laying a graph out', () => {
	it('puts a node to the right of what feeds it', () => {
		const places = layout(
			graph(
				[
					{ id: 3, type: 'out' },
					{ id: 1, type: 'note' },
					{ id: 2, type: 'osc' }
				],
				[
					{ from: 1, to: 2 },
					{ from: 2, to: 3 }
				]
			)
		);
		expect(places.get(1)!.x).toBeLessThan(places.get(2)!.x);
		expect(places.get(2)!.x).toBeLessThan(places.get(3)!.x);
	});

	it('finishes on a loop', () => {
		const places = layout(
			graph(
				[
					{ id: 1, type: 'delay' },
					{ id: 2, type: 'add' }
				],
				[
					{ from: 1, to: 2 },
					{ from: 2, to: 1 }
				]
			)
		);
		expect(places.size).toBe(2);
	});

	it('gives two nodes in a column different rows', () => {
		const places = layout(
			graph([
				{ id: 1, type: 'noise' },
				{ id: 2, type: 'noise' }
			])
		);
		expect(places.get(1)!.y).not.toBe(places.get(2)!.y);
	});
});

describe('errors and details', () => {
	it('puts an error on the node it names', () => {
		expect(nodeOfError('patch:lead/node:12', 'lead')).toBe(12);
		expect(nodeOfError('patch:lead/node:4/node:9', 'lead')).toBe(4);
	});

	it('leaves an error with no node here at the top of the page', () => {
		expect(nodeOfError('patch:lead', 'lead')).toBeNull();
		expect(nodeOfError('patch:other/node:4', 'lead')).toBeNull();
		expect(nodeOfError('patch:leader/node:4', 'lead')).toBeNull();
		expect(nodeOfError('request', 'lead')).toBeNull();
	});

	it('names what a node is set to', () => {
		const empty = graph([]);
		expect(detailOf({ id: 1, type: 'osc' }, empty, [])).toBe('sine');
		expect(detailOf({ id: 1, type: 'osc', wave: 'saw', mode: 'mod' }, empty, [])).toBe('saw mod');
		expect(detailOf({ id: 1, type: 'math' }, empty, [])).toBe('min');
		const library = [{ id: 'x', name: 'Filter', graph: empty }];
		expect(detailOf({ id: 1, type: 'subpatch', patch: 'x' }, empty, library)).toBe('Filter');
	});

	it('reads a curve however it was typed', () => {
		expect(parseCurve('-1, 0 1\n')).toEqual([-1, 0, 1]);
		expect(parseCurve('')).toEqual([]);
	});

	it("lists a graph's subpatches once each", () => {
		const used = graph([
			{ id: 1, type: 'subpatch', patch: 'b' },
			{ id: 2, type: 'subpatch', patch: 'a' },
			{ id: 3, type: 'subpatch', patch: 'a' },
			{ id: 4, type: 'subpatch' }
		]);
		expect(referencedSubpatches(used)).toEqual(['a', 'b']);
	});
});

describe('what a preview sends', () => {
	const sampled = (id: string, asset: string) => ({
		id,
		name: id,
		graph: graph([{ id: 1, type: 'sample', asset }])
	});
	const expanding = (id: string, inner: string) => ({
		id,
		name: id,
		graph: graph([{ id: 1, type: 'subpatch', patch: inner }])
	});
	const asset = (id: string) => ({ id, name: id }) as AssetEntry;

	it('follows subpatches to the assets they name, and leaves the rest', () => {
		const library = [expanding('a', 'b'), sampled('b', 'used'), sampled('c', 'other')];
		const { patches, assets } = reachable(['a'], library, [asset('used'), asset('other')]);
		expect(patches.map((p) => p.id).sort()).toEqual(['a', 'b']);
		expect(assets.map((a) => a.id)).toEqual(['used']);
	});

	it('finishes on a graph that names itself, for the compiler to refuse', () => {
		const { patches } = reachable(['a'], [expanding('a', 'a')], []);
		expect(patches.map((p) => p.id)).toEqual(['a']);
	});

	it('leaves a missing patch for the compiler to name', () => {
		expect(reachable(['gone'], [], []).patches).toEqual([]);
	});
});

describe('probe targets', () => {
	const nodes = {
		'3': { ports: { out: { rate: 'audio' as const, step: 4, operand: 8193 } } },
		'4': { ports: { out: { rate: 'control' as const } } }
	};
	const probe = (node: number, port = 'out') => ({ node, port, label: `${node}` });

	it('finds where a node is in this image, from the first free slot', () => {
		expect(probeTargets(nodes, [probe(3)], 2)).toEqual([{ slot: 2, label: '3', step: 4, operand: 8193 }]);
	});

	it('leaves out a node that compiled away and one with nothing to read', () => {
		expect(probeTargets(nodes, [probe(9), probe(4), probe(3, 'l')], 2)).toEqual([]);
		expect(probeTargets(undefined, [probe(3)], 2)).toEqual([]);
	});

	it('stops at the last tap slot', () => {
		const many = Array.from({ length: 8 }, () => probe(3));
		expect(probeTargets(nodes, many, 2).map((t) => t.slot)).toEqual([2, 3, 4, 5, 6, 7]);
	});
});
