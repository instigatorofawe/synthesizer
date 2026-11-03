import { describe, expect, it } from 'vitest';
import { edgeInto, type GraphNode } from '#lib/GraphEdit.ts';
import { amountParam, modulate, offsetOf, outputRange, readsOnceAFrame, sources } from '#lib/Modulate.ts';
import { NODE_HELP } from '#lib/NodeHelp.ts';
import type { Graph } from '#lib/Schema.ts';
import { nodeCatalog } from '#lib/server/Compile.ts';

// A saw through a filter, with an envelope that reaches nothing yet: what a filter envelope is made from.
const GRAPH: Graph = {
	params: [],
	nodes: [
		{ id: 1, type: 'note', x: 0, y: 0 },
		{ id: 2, type: 'osc', wave: 'saw', x: 200, y: 0 },
		{ id: 3, type: 'env', x: 200, y: 200 },
		{ id: 4, type: 'biquad', inputs: { cutoff: 900 }, x: 400, y: 0 },
		{ id: 5, type: 'out', x: 600, y: 0 }
	],
	edges: [
		{ from: 2, port: 'out', to: 4, input: 'in' },
		{ from: 4, port: 'out', to: 5, input: 'l' }
	]
};

const node = (graph: Graph, id: number) => graph.nodes.find((n) => n.id === id) as GraphNode;
const spots = {
	snap: { x: 0, y: 400 },
	mul: { x: 100, y: 400 },
	add: { x: 200, y: 400 },
	param: { x: 100, y: 300 }
};

describe('which inputs are read once a frame', () => {
	it("takes Format.md's table: audio only into a signal's own input, the arithmetic and the ports", () => {
		expect(readsOnceAFrame(node(GRAPH, 4), 'cutoff')).toBe(true);
		expect(readsOnceAFrame(node(GRAPH, 4), 'q')).toBe(true);
		expect(readsOnceAFrame(node(GRAPH, 4), 'in')).toBe(false);
		expect(readsOnceAFrame(node(GRAPH, 2), 'freq')).toBe(true);
		expect(readsOnceAFrame({ id: 9, type: 'osc', mode: 'mod' }, 'freq')).toBe(false);
		expect(readsOnceAFrame({ id: 9, type: 'mul' }, 'b')).toBe(false);
		expect(readsOnceAFrame({ id: 9, type: 'mtof' }, 'in')).toBe(true); // KMtoF reads a scalar note
	});

	it('names output ranges only for ports the compiler has', async () => {
		for (const entry of await nodeCatalog()) {
			for (const port of Object.keys(NODE_HELP[entry.type].outputs ?? {}))
				expect(entry.outputs, entry.type).toContain(port);
		}
	});
});

describe('the sources an input is offered', () => {
	it("leaves out the input's own node and what depends on it, which would be a loop", () => {
		const offered = sources(GRAPH, 4).map(({ from, port }) => `${from}.${port}`);
		expect(offered).toEqual(['1.pitch', '1.velocity', '1.gate', '2.out', '3.out']);
		expect(sources(GRAPH, 2).map(({ from }) => from)).not.toContain(4);
	});

	it('knows how far each swings', () => {
		expect(outputRange(node(GRAPH, 3), 'out', GRAPH)).toEqual({ low: 0, high: 1 });
		expect(outputRange(node(GRAPH, 2), 'out', GRAPH)).toEqual({ low: -1, high: 1 });
		expect(outputRange({ id: 9, type: 'lfo', inputs: { depth: 0.25 } }, 'out', GRAPH)).toEqual({
			low: -0.25,
			high: 0.25
		});
		expect(outputRange({ id: 9, type: 'mul' }, 'out', GRAPH)).toBeNull();
	});
});

describe("the amount's Control", () => {
	it("spans the input's range either way, and starts with an envelope sweeping halfway up from where the input was", () => {
		const amount = amountParam(GRAPH, 'cutoff', NODE_HELP.biquad.inputs.cutoff, 900, { low: 0, high: 1 });
		expect(amount).toEqual({
			id: 1,
			name: 'cutoff amount',
			scope: 'track',
			min: -20000,
			max: 20000,
			default: 9550,
			smooth_ms: 10
		});
	});

	it('swings a wave halfway to the nearer end, and takes a name no Control has', () => {
		const taken = { ...GRAPH, params: [{ ...amountParam(GRAPH, 'q', NODE_HELP.biquad.inputs.q, 0.7, null) }] };
		const amount = amountParam(taken, 'q', NODE_HELP.biquad.inputs.q, 0.7, { low: -1, high: 1 });
		expect(amount.name).toBe('q amount 2');
		expect(amount.id).toBe(2);
		expect(amount.default).toBe(0.3);
	});
});

describe('a modulation put in', () => {
	it('snaps audio first, so the multiply and the add run once a frame, then puts it into the input as one edit', () => {
		const offset = offsetOf(node(GRAPH, 4), { name: 'cutoff', default: 1000 });
		expect(offset).toBe(900);
		const amount = amountParam(GRAPH, 'cutoff', NODE_HELP.biquad.inputs.cutoff, offset, { low: 0, high: 1 });
		const done = modulate(
			GRAPH,
			{ to: 4, input: 'cutoff', offset },
			{ from: 3, port: 'out', audio: true },
			amount,
			spots
		);
		const [param, snap, mul, add] = done.added;
		const g = done.graph;
		expect(g.params).toEqual([amount]);
		expect(node(g, param)).toMatchObject({ type: 'param', param: amount.id });
		expect(node(g, snap).type).toBe('snap');
		expect(edgeInto(g, snap, 'in')).toMatchObject({ from: 3, port: 'out' });
		expect(edgeInto(g, mul, 'a')).toMatchObject({ from: snap });
		expect(edgeInto(g, mul, 'b')).toMatchObject({ from: param });
		expect(edgeInto(g, add, 'a')).toMatchObject({ from: mul });
		expect(node(g, add).inputs).toEqual({ b: 900 });
		expect(edgeInto(g, 4, 'cutoff')).toMatchObject({ from: add, port: 'out' });
		expect(g.edges).toHaveLength(GRAPH.edges.length + 5);
	});

	it('needs no snap for a source read once a frame already', () => {
		const lfo: Graph = { ...GRAPH, nodes: [...GRAPH.nodes, { id: 6, type: 'lfo', x: 200, y: 300 }] };
		const amount = amountParam(lfo, 'cutoff', NODE_HELP.biquad.inputs.cutoff, 900, { low: -1, high: 1 });
		const done = modulate(
			lfo,
			{ to: 4, input: 'cutoff', offset: 900 },
			{ from: 6, port: 'out', audio: false },
			amount,
			spots
		);
		expect(done.added.map((id) => node(done.graph, id).type)).toEqual(['param', 'mul', 'add']);
		expect(edgeInto(done.graph, done.added[1], 'a')).toMatchObject({ from: 6 });
	});
});
