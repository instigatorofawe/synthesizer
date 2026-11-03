// "Modulate this input…": what a filter envelope takes, as one edit. An input read once a frame gets `amount × source + offset`,
// with the offset the value it had and the amount a new Control, so the source moves it about where it was, and the Control says
// how far. Audio is read once a frame first, by a snap, which is what the compiler asks for and what only the patch's author can
// choose (section 5 of Design.md), so the editor offers this and never does it unasked. The snap comes first rather than last,
// so the multiply and the add are KMul and KAdd, run once a frame, rather than Mul and AddS on every sample: what is heard is
// the same, since the input reads one value a frame either way, and on a Cortex-M4 it costs a frame's two scalar steps.
import { addNode, connect, setLiteral, type CatalogInput, type GraphNode } from '#lib/GraphEdit.ts';
import { helpOf, shown, type InputHelp } from '#lib/NodeHelp.ts';
import type { Graph, Param } from '#lib/Schema.ts';

// The inputs that take audio, as Format.md's opcode table has them: B and E operands. Every other input of these types is an S
// operand, read once a frame. An oscillator in a "mod" mode is OscMod, all of whose inputs take either.
const AUDIO_INPUTS: Record<string, readonly string[]> = {
	biquad: ['in'],
	comb: ['in'],
	allpass: ['in'],
	follow: ['in'],
	snap: ['in'],
	delay: ['in'],
	pan: ['in'],
	shape: ['in'],
	add: ['a', 'b'],
	mul: ['a', 'b'],
	math: ['a', 'b', 'c'],
	out: ['l', 'r'],
	outlet: ['in']
};

// Whether a node reads this input once a frame. A subpatch's inputs are read inside another graph, which this can't see.
export function readsOnceAFrame(node: GraphNode, input: string): boolean {
	if (node.type === 'subpatch' || node.type === 'inlet') return false;
	if (node.type === 'osc' && (node.mode === 'mod' || node.mode === 'mod-naive')) return false;
	return !(AUDIO_INPUTS[node.type] ?? []).includes(input);
}

// What a source's output runs between, where its kernel says so: an envelope and a follower 0 to 1, a wave −1 to 1, and an LFO
// ±depth. What isn't known is null.
export function outputRange(node: GraphNode, port: string, graph: Graph): { low: number; high: number } | null {
	const help = helpOf(node.type)?.outputs?.[port];
	if (help) return { low: help.min, high: help.max };
	if (node.type === 'lfo') {
		const depth = typeof node.inputs?.depth === 'number' ? Math.abs(node.inputs.depth) : 1;
		return { low: -depth, high: depth };
	}
	if (node.type === 'param') {
		const param = graph.params.find((p) => p.id === node.param);
		return param ? { low: param.min, high: param.max } : null;
	}
	return null;
}

// The sources a menu offers for an input: every output with a known range, of a node that doesn't depend on the input's node,
// since a wire from one would be a loop with no delay in it, which the compiler refuses.
export function sources(graph: Graph, to: number): { from: number; port: string }[] {
	const after = new Set([to]);
	for (let grew = true; grew;) {
		grew = false;
		for (const edge of graph.edges) {
			if (after.has(edge.from) && !after.has(edge.to)) {
				after.add(edge.to);
				grew = true;
			}
		}
	}
	return graph.nodes.flatMap((node) =>
		after.has(node.id)
			? []
			: Object.keys(helpOf(node.type)?.outputs ?? (node.type === 'lfo' ? { out: 0 } : {})).map((port) => ({
					from: node.id,
					port
				}))
	);
}

// The span an input's value is moved over: its range where it has one, and for one bounded by the sample rate, such as a
// cutoff, the 20 kHz that is the most heard.
function span(help: InputHelp | undefined, offset: number): { min: number; max: number } {
	const min = typeof help?.min === 'number' ? help.min : undefined;
	const max =
		typeof help?.max === 'number' ? help.max : help?.max !== undefined && help.unit === 'Hz' ? 20000 : undefined;
	if (min !== undefined && max !== undefined) return { min, max };
	const wide = Math.max(1, Math.abs(offset) * 2);
	return { min: min ?? offset - wide / 2, max: max ?? (min ?? offset - wide / 2) + wide };
}

const rounded = (value: number) => Number(value.toPrecision(3));

// The amount's Control: from minus the input's span to plus it, so the source can move the input anywhere in its range either
// way. It starts where a source from 0 to 1 sweeps halfway up from the offset, or one either side of 0 swings halfway to the
// nearer end, which the Control then moves.
export function amountParam(
	graph: Graph,
	input: string,
	help: InputHelp | undefined,
	offset: number,
	source: { low: number; high: number } | null
): Param {
	const id = Math.max(0, ...graph.params.map((param) => param.id)) + 1;
	const { min, max } = span(help, offset);
	const width = max - min;
	const bipolar = (source?.low ?? 0) < 0;
	const room = bipolar ? Math.min(offset - min, max - offset) : max - offset;
	const start = rounded(room > 0 ? room / 2 : width / 10) || rounded(width / 10);
	const words = graph.params.map((param) => param.name);
	let name = `${input} amount`;
	for (let n = 2; words.includes(name); n++) name = `${input} amount ${n}`;
	return { id, name, scope: 'track', min: -rounded(width), max: rounded(width), default: start, smooth_ms: 10 };
}

export interface Spots {
	snap?: { x: number; y: number };
	mul: { x: number; y: number };
	add: { x: number; y: number };
	param: { x: number; y: number };
}

// The modulation put in, as one edit: the source (and a snap after it, if it is audio), times the amount's Control, plus the
// offset, into the input. Gives the graph and the nodes it added, the Control's own first.
export function modulate(
	graph: Graph,
	target: { to: number; input: string; offset: number },
	source: { from: number; port: string; audio: boolean },
	amount: Param,
	at: Spots
): { graph: Graph; added: number[] } {
	let next: Graph = { ...graph, params: [...graph.params, amount] };
	const added: number[] = [];
	const put = (type: GraphNode['type'], spot: { x: number; y: number }) => {
		const made = addNode(next, type, spot.x, spot.y);
		next = made.graph;
		added.push(made.id);
		return made.id;
	};
	const control = put('param', at.param);
	next = { ...next, nodes: next.nodes.map((node) => (node.id === control ? { ...node, param: amount.id } : node)) };
	let from = { id: source.from, port: source.port };
	if (source.audio && at.snap) {
		const snap = put('snap', at.snap);
		next = connect(next, from.id, from.port, snap, 'in');
		from = { id: snap, port: 'out' };
	}
	const mul = put('mul', at.mul);
	next = connect(next, from.id, from.port, mul, 'a');
	next = connect(next, control, 'out', mul, 'b');
	const add = put('add', at.add);
	next = connect(next, mul, 'out', add, 'a');
	next = setLiteral(next, add, 'b', target.offset);
	next = connect(next, add, 'out', target.to, target.input);
	return { graph: next, added };
}

// What an input is set to, which a modulation moves about: its own value, or its default.
export function offsetOf(node: GraphNode, input: CatalogInput): number {
	const own = node.inputs?.[input.name];
	return typeof own === 'number' ? own : Number(shown(input.default));
}
