import { describe, expect, it } from 'vitest';
import {
	addNode,
	boundsOf,
	connect,
	copyNodes,
	detailOf,
	disconnect,
	edgeInto,
	freeSpot,
	insertSnap,
	inputsOf,
	isPort,
	layout,
	moveNode,
	moveNodes,
	nodeOfError,
	nodesTouching,
	outputsOf,
	parseCurve,
	pasteNodes,
	placed,
	rateErrorInput,
	removeNode,
	removeNodes,
	setLiteral,
	setOption,
	tidy,
	whyCompiledAway,
	type CatalogEntry,
	type GraphNode,
	type LibraryPatch
} from '#lib/GraphEdit.ts';
import { probeTargets } from '#lib/AudioEngine.ts';
import { buildRequest, reachable, type AssetEntry } from '#lib/Request.ts';
import { EMPTY_GRAPH, referencedSubpatches, timelineSchema, type Graph } from '#lib/Schema.ts';
import { compileRequest } from '#lib/server/Compile.ts';

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

	it('puts an envelope beside what it shapes, not at the far left', () => {
		const places = layout(EMPTY_GRAPH);
		const at = (type: string) => places.get(EMPTY_GRAPH.nodes.find((node) => node.type === type)!.id)!;
		expect(at('env').x).toBe(at('osc').x);
		expect(at('env').x).toBeLessThan(at('mul').x);
		expect(at('note').x).toBeLessThan(at('mtof').x);
	});

	it('levels a node with what feeds it, so a chain reads along one line', () => {
		const places = layout(EMPTY_GRAPH);
		expect(
			new Set(['note', 'mtof', 'osc', 'mul', 'out'].map((type) => places.get(idOf(EMPTY_GRAPH, type))!.y))
		).toEqual(new Set([0]));
	});

	it('keeps nodes in a column apart by how tall each is drawn', () => {
		const tall = graph([1, 2, 3].map((id) => ({ id, type: 'noise' as const })));
		const places = layout(tall, (node) => node.id * 100);
		expect(places.get(2)!.y).toBeGreaterThanOrEqual(places.get(1)!.y + 100);
		expect(places.get(3)!.y).toBeGreaterThanOrEqual(places.get(2)!.y + 200);
	});
});

const idOf = (g: Graph, type: string) => g.nodes.find((node) => node.type === type)!.id;

describe('tidying a graph', () => {
	const heap = graph(
		EMPTY_GRAPH.nodes.map((node) => ({ ...node, x: 0, y: 0 })),
		EMPTY_GRAPH.edges
	);
	const height = (node: GraphNode) => nodeHeightFor(node);

	it('moves every node where the layout puts it, in one edit, and changes nothing else', () => {
		const tidied = tidy(heap, height);
		const places = layout(heap, height);
		for (const node of tidied.nodes) expect({ x: node.x, y: node.y }).toEqual(places.get(node.id));
		expect(tidied.edges).toBe(heap.edges);
		expect(tidied.nodes.map(({ x: _x, y: _y, ...rest }) => rest)).toEqual(EMPTY_GRAPH.nodes);
		expect(heap.nodes.every((node) => node.x === 0 && node.y === 0)).toBe(true);
	});

	it('leaves no node on top of another', () => {
		const wide = graph(
			Array.from({ length: 12 }, (_, i) => ({
				id: i + 1,
				type: i % 3 ? ('osc' as const) : ('env' as const),
				x: 0,
				y: 0
			})),
			Array.from({ length: 11 }, (_, i) => ({ from: i + 1, to: 12 - (i % 2), input: 'freq' }))
		);
		const tidied = tidy(wide, height);
		expect(overlapping(tidied)).toEqual([]);
	});
});

// A stand-in for the editor's heights: an env is drawn with four inputs and anything else with one.
const nodeHeightFor = (node: GraphNode) => (node.type === 'env' ? 118 : 64);
const sizeFor = (node: GraphNode) => ({ width: 150, height: nodeHeightFor(node) });

function overlapping(g: Graph) {
	const found: [number, number][] = [];
	for (const a of g.nodes)
		for (const b of g.nodes) {
			if (a.id >= b.id) continue;
			const [ax, ay, bx, by] = [a.x as number, a.y as number, b.x as number, b.y as number];
			const apart = ax >= bx + 150 || bx >= ax + 150 || ay >= by + nodeHeightFor(b) || by >= ay + nodeHeightFor(a);
			if (!apart) found.push([a.id, b.id]);
		}
	return found;
}

describe('placing a new node', () => {
	const one = graph([{ id: 1, type: 'osc', x: 100, y: 100 }]);

	it('lands where it was asked to when nothing is there', () => {
		expect(freeSpot(one, { x: 400, y: 100 }, { width: 150, height: 64 }, sizeFor)).toEqual({ x: 400, y: 100 });
	});

	it('moves off a node it would cover, as little as it can', () => {
		const at = freeSpot(one, { x: 110, y: 110 }, { width: 150, height: 64 }, sizeFor);
		const added = addNode(one, 'noise', at.x, at.y).graph;
		expect(overlapping(added)).toEqual([]);
		expect(Math.hypot(at.x - 110, at.y - 110)).toBeLessThan(150);
	});

	it('finds room in a crowded graph', () => {
		let crowded = graph([]);
		for (let i = 0; i < 30; ++i) {
			const at = freeSpot(crowded, { x: (i * 37) % 200, y: (i * 53) % 200 }, sizeFor({ id: 0, type: 'env' }), sizeFor);
			crowded = addNode(crowded, 'env', at.x, at.y).graph;
		}
		expect(overlapping(crowded)).toEqual([]);
	});
});

describe('the snap a rate error offers', () => {
	const message =
		"input 'cutoff' is read once a frame and cannot take audio. To read it once a frame on purpose, put a snap node on the wire";
	const filtered = graph(
		[...EMPTY_GRAPH.nodes, { id: 7, type: 'biquad', x: 0, y: 0 }],
		[
			...EMPTY_GRAPH.edges.filter((edge) => edge.to !== 6),
			{ from: 5, to: 7, input: 'in' },
			{ from: 7, to: 6, input: 'l' },
			{ from: 4, to: 7, input: 'cutoff' }
		]
	);

	it('reads which input the error is about, and nothing from any other error', () => {
		expect(rateErrorInput(message)).toBe('cutoff');
		expect(rateErrorInput("no input 'cutoff'")).toBeNull();
		expect(rateErrorInput('a patch has one out node')).toBeNull();
	});

	it('puts a snap between the wire and the input, as one edit', () => {
		const fixed = insertSnap(filtered, 7, 'cutoff', 20, 30)!;
		expect(fixed.id).toBe(8);
		expect(fixed.graph.nodes.at(-1)).toEqual({ id: 8, type: 'snap', x: 20, y: 30 });
		expect(edgeInto(fixed.graph, 8, 'in')).toEqual({ from: 4, port: 'out', to: 8, input: 'in' });
		expect(edgeInto(fixed.graph, 7, 'cutoff')).toEqual({ from: 8, port: 'out', to: 7, input: 'cutoff' });
		expect(fixed.graph.edges).toHaveLength(filtered.edges.length + 1);
		expect(filtered.nodes).toHaveLength(7);
	});

	it('offers nothing for an input with no wire', () => {
		expect(insertSnap(filtered, 7, 'q', 0, 0)).toBeNull();
	});

	it('is what the compiler asked for', async () => {
		const compile = async (g: Graph) => {
			const timeline = timelineSchema.parse({
				clips: [{ id: 'c', length: 960, notes: [{ tick: 0, note: 60, dur: 480 }] }],
				tracks: [{ id: 1, slots: ['p'], placements: [{ clip: 'c', tick: 0 }] }]
			});
			const request = buildRequest([{ id: 'p', name: 'P', graph: g }], [], [{ id: 't', name: 'T', timeline }]);
			return (await compileRequest(request)).report;
		};
		const before = await compile(filtered);
		expect(before.errors?.map((error) => [nodeOfError(error.where, 'p'), rateErrorInput(error.message)])).toEqual([
			[7, 'cutoff']
		]);
		const after = await compile(insertSnap(filtered, 7, 'cutoff', 0, 0)!.graph);
		expect(after.errors).toBeUndefined();
		expect(after.ok).toBe(true);
	});
});

describe('why a node compiled away', () => {
	it('says so for a node whose wires never reach the out node', () => {
		const loose = graph(
			[...EMPTY_GRAPH.nodes, { id: 7, type: 'noise' }, { id: 8, type: 'biquad' }],
			[...EMPTY_GRAPH.edges, { from: 7, to: 8, input: 'in' }]
		);
		expect(whyCompiledAway(loose, 7)).toContain('reaches the out node');
		expect(whyCompiledAway(loose, 8)).toContain('reaches the out node');
	});

	it("says nothing where the reason isn't in this graph", () => {
		expect(whyCompiledAway(EMPTY_GRAPH, 4)).toBeNull();
		const looped = graph(
			[
				{ id: 1, type: 'delay' },
				{ id: 2, type: 'add' },
				{ id: 3, type: 'out' }
			],
			[
				{ from: 1, to: 2, input: 'a' },
				{ from: 2, to: 1, input: 'in' },
				{ from: 2, to: 3, input: 'l' }
			]
		);
		expect(whyCompiledAway(looped, 1)).toBeNull();
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

describe('choosing several nodes, and moving or deleting them', () => {
	const tall = () => 50;
	const laid = graph(
		[
			{ id: 1, type: 'note', x: 0, y: 0 },
			{ id: 2, type: 'osc', x: 200, y: 0 },
			{ id: 3, type: 'out', x: 400, y: 100 }
		],
		[
			{ from: 1, port: 'pitch', to: 2, input: 'freq' },
			{ from: 2, to: 3, input: 'l' }
		]
	);

	it('chooses the nodes a box touches, however little of each', () => {
		expect(nodesTouching(laid, { x: 140, y: 40, width: 70, height: 5 }, tall)).toEqual([1, 2]);
		expect(nodesTouching(laid, { x: 160, y: 60, width: 30, height: 30 }, tall)).toEqual([]);
		expect(nodesTouching(laid, { x: -1000, y: -1000, width: 3000, height: 3000 }, tall)).toEqual([1, 2, 3]);
	});

	it('measures the box round some nodes', () => {
		expect(boundsOf(laid.nodes, tall)).toEqual({ x: 0, y: 0, width: 550, height: 150 });
		expect(boundsOf(laid.nodes.slice(1, 2), tall)).toEqual({ x: 200, y: 0, width: 150, height: 50 });
	});

	it('moves several by the same amount, and no others', () => {
		const moved = moveNodes(laid, [1, 3], 10, -5);
		expect(moved.nodes.map((node) => [node.x, node.y])).toEqual([
			[10, -5],
			[200, 0],
			[410, 95]
		]);
		expect(moved.edges).toBe(laid.edges);
	});

	it('takes several away, with every wire to or from them', () => {
		const next = removeNodes(laid, [2, 3]);
		expect(next.nodes.map((node) => node.id)).toEqual([1]);
		expect(next.edges).toEqual([]);
		expect(removeNodes(laid, [])).toEqual(laid);
	});

	it('knows what a patch is played and wired through', () => {
		const types = ['note', 'in', 'out', 'inlet', 'outlet', 'osc', 'subpatch', 'param'] as GraphNode['type'][];
		expect(types.filter((type) => isPort({ id: 1, type }))).toEqual(['note', 'in', 'out', 'inlet', 'outlet']);
	});
});

describe('copying and pasting nodes', () => {
	const params: Graph['params'] = [
		{ id: 1, name: 'cutoff', scope: 'track', min: 80, max: 12000, default: 900, smooth_ms: 10 },
		{ id: 2, name: 'detune', scope: 'track', min: 0, max: 1, default: 0.1, smooth_ms: 10 }
	];
	const source: Graph = {
		params,
		nodes: [
			{ id: 1, type: 'note', x: 0, y: 0 },
			{ id: 2, type: 'mtof', x: 190, y: 0 },
			{ id: 3, type: 'osc', wave: 'saw', x: 380, y: 0, inputs: { width: 0.3 } },
			{ id: 4, type: 'param', param: 1, x: 380, y: 120 },
			{ id: 5, type: 'biquad', x: 570, y: 0 },
			{ id: 6, type: 'subpatch', patch: 'pair', x: 570, y: 200, inputs: { depth: 0.5 } },
			{ id: 7, type: 'out', x: 760, y: 0 }
		],
		edges: [
			{ from: 1, port: 'pitch', to: 2, input: 'in' },
			{ from: 2, port: 'out', to: 3, input: 'freq' },
			{ from: 3, port: 'out', to: 5, input: 'in' },
			{ from: 4, port: 'out', to: 5, input: 'cutoff' },
			{ from: 5, port: 'out', to: 7, input: 'l' },
			{ from: 6, port: 'l', to: 7, input: 'r' }
		]
	};
	const pasted = (into: Graph, ids: number[]) => into.nodes.filter((node) => ids.includes(node.id));

	it('copies the nodes chosen, the wires between them, and the parameters they read', () => {
		const copied = copyNodes(source, [3, 4, 5], 'lead')!;
		expect(copied.from).toBe('lead');
		expect(copied.nodes.map((node) => node.id)).toEqual([3, 4, 5]);
		expect(copied.edges).toEqual([
			{ from: 3, port: 'out', to: 5, input: 'in' },
			{ from: 4, port: 'out', to: 5, input: 'cutoff' }
		]);
		expect(copied.params).toEqual([params[0]]);
		expect(copyNodes(source, [], 'lead')).toBeNull();
		expect(copyNodes(source, [99], 'lead')).toBeNull();
	});

	it('keeps a copy apart from the graph it came from', () => {
		const copied = copyNodes(source, [3], 'lead')!;
		(copied.nodes[0].inputs as Record<string, number>).width = 0.9;
		expect(source.nodes[2].inputs).toEqual({ width: 0.3 });
	});

	it('gives pasted nodes fresh ids that clash with none, however often they are pasted', () => {
		const copied = copyNodes(source, [2, 3], 'lead')!;
		const once = pasteNodes(source, copied, 'lead', { x: 0, y: 200 });
		expect(once.ids).toEqual([8, 9]);
		const twice = pasteNodes(once.graph, copied, 'lead', { x: 0, y: 400 });
		expect(twice.ids).toEqual([10, 11]);
		const ids = twice.graph.nodes.map((node) => node.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(twice.graph.nodes.slice(0, source.nodes.length)).toEqual(source.nodes);
		expect(twice.graph.edges.slice(0, source.edges.length)).toEqual(source.edges);
	});

	it('keeps the wires between them, renumbered, and moves them by the offset', () => {
		const { graph: next, ids } = pasteNodes(source, copyNodes(source, [2, 3], 'lead')!, 'lead', { x: 10, y: 200 });
		expect(next.edges.slice(source.edges.length)).toEqual([{ from: 8, port: 'out', to: 9, input: 'freq' }]);
		expect(pasted(next, ids)).toEqual([
			{ id: 8, type: 'mtof', x: 200, y: 200 },
			{ id: 9, type: 'osc', wave: 'saw', x: 390, y: 200, inputs: { width: 0.3 } }
		]);
	});

	it('drops a wire from a node that was not copied, which leaves the input its own value', () => {
		const { graph: next, ids } = pasteNodes(source, copyNodes(source, [3], 'lead')!, 'lead', { x: 0, y: 0 });
		expect(next.edges).toEqual(source.edges);
		expect(edgeInto(next, ids[0], 'freq')).toBeUndefined();
		expect(pasted(next, ids)[0].inputs).toEqual({ width: 0.3 });
	});

	it('copies a subpatch whole, naming the same patch, with its typed-in values', () => {
		const { graph: next, ids } = pasteNodes(EMPTY_GRAPH, copyNodes(source, [6], 'lead')!, 'pad', { x: 0, y: 0 });
		expect(pasted(next, ids)).toEqual([
			{ id: 7, type: 'subpatch', patch: 'pair', x: 570, y: 200, inputs: { depth: 0.5 } }
		]);
	});

	it('keeps a param node reading its parameter, in the patch it came from', () => {
		const { graph: next, ids } = pasteNodes(source, copyNodes(source, [4], 'lead')!, 'lead', { x: 0, y: 0 });
		expect(pasted(next, ids)[0].param).toBe(1);
		expect(next.params).toEqual(params);
	});

	it('has a param node read the parameter of the same name in another patch, whatever its id there', () => {
		const other = {
			...EMPTY_GRAPH,
			params: [
				{ ...params[1], id: 1 },
				{ ...params[0], id: 5, min: 20 }
			]
		};
		const { graph: next, ids } = pasteNodes(other, copyNodes(source, [4], 'lead')!, 'pad', { x: 0, y: 0 });
		expect(pasted(next, ids)[0].param).toBe(5);
		expect(next.params).toEqual(other.params);
	});

	it('brings the parameter along to a patch with none of that name, under its own id if that is free', () => {
		const copied = copyNodes(source, [4], 'lead')!;
		const into = pasteNodes(EMPTY_GRAPH, copied, 'pad', { x: 0, y: 0 });
		expect(into.graph.params).toEqual([params[0]]);
		expect(pasted(into.graph, into.ids)[0].param).toBe(1);

		const taken = { ...EMPTY_GRAPH, params: [{ ...params[1], id: 1 }] };
		const moved = pasteNodes(taken, copied, 'pad', { x: 0, y: 0 });
		expect(moved.graph.params).toEqual([taken.params[0], { ...params[0], id: 2 }]);
		expect(pasted(moved.graph, moved.ids)[0].param).toBe(2);
	});

	it('leaves out a second out node, and its wires', () => {
		const copied = copyNodes(source, [5, 7], 'lead')!;
		const into = pasteNodes(source, copied, 'lead', { x: 0, y: 300 });
		expect(pasted(into.graph, into.ids).map((node) => node.type)).toEqual(['biquad']);
		expect(into.graph.edges).toEqual(source.edges);
		const alone = pasteNodes(graph([{ id: 1, type: 'note' }]), copied, 'pad', { x: 0, y: 0 });
		expect(pasted(alone.graph, alone.ids).map((node) => node.type)).toEqual(['biquad', 'out']);
		expect(alone.graph.edges).toEqual([{ from: 2, port: 'out', to: 3, input: 'l' }]);
	});

	it('makes a graph the compiler takes, pasted into another patch and wired in', async () => {
		const compile = async (g: Graph) => {
			const timeline = timelineSchema.parse({
				clips: [{ id: 'c', length: 960, notes: [{ tick: 0, note: 60, dur: 480 }] }],
				tracks: [{ id: 1, slots: ['p'], placements: [{ clip: 'c', tick: 0 }] }]
			});
			const request = buildRequest([{ id: 'p', name: 'P', graph: g }], [], [{ id: 't', name: 'T', timeline }]);
			return (await compileRequest(request)).report;
		};
		// A filter with its cutoff on a parameter, from the lead into a new patch, between its mul and its out.
		const { graph: next, ids } = pasteNodes(EMPTY_GRAPH, copyNodes(source, [4, 5], 'lead')!, 'p', { x: 0, y: 0 });
		const [, filter] = ids;
		const wired = connect(connect(next, 5, 'out', filter, 'in'), filter, 'out', 6, 'l');
		const report = await compile(wired);
		expect(report.errors).toBeUndefined();
		expect(report.ok).toBe(true);
	});
});
