// What the graph editor does to a graph, apart from drawing it. Every function returns a new graph, which is what makes undo
// a list of old ones. Nothing here decides what is legal: a graph that won't compile can still be drawn, and the compiler says
// what is wrong on the node it is wrong on.
import type { Graph } from '#lib/Schema.ts';

export type GraphNode = Graph['nodes'][number];
export type GraphEdge = Graph['edges'][number];

export interface CatalogInput {
	name: string;
	default: number;
}

export interface CatalogOption {
	name: string;
	choices: string[];
	number: boolean;
}

// One entry of the compiler's node table.
export interface CatalogEntry {
	type: string;
	inputs: CatalogInput[];
	outputs: string[];
	options: CatalogOption[];
}

export interface LibraryPatch {
	id: string;
	name: string;
	graph: Graph;
}

export type Point = { x: number; y: number };

export const COLUMN = 190;
export const ROW = 38;
export const NODE_WIDTH = 150;
export const NODE_HEADER = 40; // Two lines: the name a person reads, and the compiler's with what the node is set to
export const PORT_SPACING = 18;
const GAP = 24; // Between two nodes in a column

const entryOf = (catalog: CatalogEntry[], type: string) => catalog.find((entry) => entry.type === type);

const MATH_INPUTS: Record<string, string[]> = {
	min: ['a', 'b'],
	max: ['a', 'b'],
	abs: ['a'],
	clip: ['a', 'b', 'c'],
	floor: ['a'],
	divide: ['a', 'b'],
	compare: ['a', 'b'],
	select: ['a', 'b', 'c']
};
const MATH_DEFAULTS: Record<string, Record<string, number>> = {
	clip: { b: -1, c: 1 },
	divide: { b: 1 },
	select: { b: 1 }
};

function subpatchPorts(node: GraphNode, library: LibraryPatch[]) {
	const inner = library.find((patch) => patch.id === node.patch)?.graph;
	const inputs: CatalogInput[] = [];
	const outputs: string[] = [];
	for (const n of inner?.nodes ?? []) {
		const name = typeof n.name === 'string' ? n.name : '';
		if (n.type === 'inlet' && name) inputs.push({ name, default: typeof n.default === 'number' ? n.default : 0 });
		if (n.type === 'outlet' && name) outputs.push(name);
		if (n.type === 'in') inputs.push({ name: 'l', default: 0 }, { name: 'r', default: 0 });
		if (n.type === 'out') outputs.push('l', 'r');
	}
	return { inputs, outputs };
}

// The inputs this node reads as it is set up now. Some exist only in one mode, and showing the others would offer a wire the
// compiler refuses.
export function inputsOf(node: GraphNode, catalog: CatalogEntry[], library: LibraryPatch[]): CatalogInput[] {
	if (node.type === 'subpatch') return subpatchPorts(node, library).inputs;
	const all = entryOf(catalog, node.type)?.inputs ?? [];
	if (node.type === 'osc') {
		const modulated = node.mode === 'mod' || node.mode === 'mod-naive';
		const wave = node.wave ?? 'sine';
		const shown = new Set(['freq']);
		if (wave === 'square') shown.add('width');
		if (modulated) shown.add('phase').add('sync');
		if (modulated && wave === 'sine') shown.add('feedback');
		return all.filter((input) => shown.has(input.name));
	}
	if (node.type === 'math') {
		const mode = String(node.mode ?? 'min');
		return all
			.filter((input) => (MATH_INPUTS[mode] ?? []).includes(input.name))
			.map((input) => ({ ...input, default: MATH_DEFAULTS[mode]?.[input.name] ?? input.default }));
	}
	if (node.type === 'sample') {
		const names = node.mode === 'zones' ? ['note', 'start'] : ['ratio'];
		return all.filter((input) => names.includes(input.name));
	}
	return all;
}

export function outputsOf(node: GraphNode, catalog: CatalogEntry[], library: LibraryPatch[]): string[] {
	if (node.type === 'subpatch') return subpatchPorts(node, library).outputs;
	return entryOf(catalog, node.type)?.outputs ?? [];
}

export function optionsOf(node: GraphNode, catalog: CatalogEntry[]): CatalogOption[] {
	return entryOf(catalog, node.type)?.options ?? [];
}

export function nodeHeight(node: GraphNode, catalog: CatalogEntry[], library: LibraryPatch[]): number {
	const ports = Math.max(inputsOf(node, catalog, library).length, outputsOf(node, catalog, library).length, 1);
	return NODE_HEADER + ports * PORT_SPACING + 6;
}

// What a node's title adds to its type, so that two oscillators can be told apart.
export function detailOf(node: GraphNode, graph: Graph, library: LibraryPatch[]): string {
	if (node.type === 'osc') return [node.wave ?? 'sine', node.mode].filter(Boolean).join(' ');
	if (node.type === 'math' || node.type === 'biquad')
		return String(node.mode ?? (node.type === 'math' ? 'min' : 'lowpass'));
	if (node.type === 'subpatch')
		return library.find((patch) => patch.id === node.patch)?.name ?? String(node.patch ?? '');
	if (node.type === 'param') {
		const param = graph.params.find((p) => p.id === node.param);
		return param?.name || (node.param === undefined ? '' : `param ${node.param}`);
	}
	if (node.type === 'inlet' || node.type === 'outlet') return String(node.name ?? '');
	if (node.type === 'const') return String(node.value ?? 0);
	return '';
}

const placedAt = (node: GraphNode) => typeof node.x === 'number' && typeof node.y === 'number';

// How tall a node is drawn, which only the editor knows, since it depends on the catalog and the library.
export type HeightOf = (node: GraphNode) => number;
const spacedRows: HeightOf = () => 3 * ROW - GAP;

// Left to right by how far each node is from a source, which reads like signal flow. Then each moves as far right as the first
// node it feeds allows, so an envelope sits beside what it shapes rather than at the far left. A delay can close a loop, so
// this gives up on a loop rather than following it round: depths stop at the node count. In a column, a node goes level with
// the highest node that feeds it where there is room, so a chain reads along one line with what shapes it below, and nodes fed
// by nothing to their left go below them all.
export function layout(graph: Graph, heightOf: HeightOf = spacedRows): Map<number, Point> {
	const count = graph.nodes.length;
	const depth = new Map<number, number>(graph.nodes.map((node) => [node.id, 0]));
	const edges = graph.edges.filter((edge) => edge.from !== edge.to && depth.has(edge.from) && depth.has(edge.to));
	for (let pass = 0; pass < count; ++pass) {
		let moved = false;
		for (const edge of edges) {
			const from = depth.get(edge.from)!;
			if (depth.get(edge.to)! < from + 1 && from + 1 < count) {
				depth.set(edge.to, from + 1);
				moved = true;
			}
		}
		if (!moved) break;
	}
	for (let pass = 0; pass < count; ++pass) {
		let moved = false;
		for (const node of graph.nodes) {
			const fed = edges.filter((edge) => edge.from === node.id).map((edge) => depth.get(edge.to)!);
			const furthest = Math.min(...fed) - 1;
			if (fed.length && furthest > depth.get(node.id)!) {
				depth.set(node.id, furthest);
				moved = true;
			}
		}
		if (!moved) break;
	}

	const places = new Map<number, Point>();
	const columns = [...new Set(depth.values())].sort((a, b) => a - b);
	for (const column of columns) {
		const level = new Map<number, number>();
		for (const node of graph.nodes) {
			if (depth.get(node.id) !== column) continue;
			const tops = edges
				.filter((edge) => edge.to === node.id && places.has(edge.from))
				.map((edge) => places.get(edge.from)!.y);
			if (tops.length) level.set(node.id, Math.min(...tops));
		}
		const nodes = graph.nodes
			.filter((node) => depth.get(node.id) === column)
			.sort((a, b) => (level.get(a.id) ?? Infinity) - (level.get(b.id) ?? Infinity) || a.id - b.id);
		let free = 0;
		for (const node of nodes) {
			const y = Math.max(free, level.get(node.id) ?? free);
			places.set(node.id, { x: column * COLUMN, y });
			free = y + heightOf(node) + GAP;
		}
	}
	return places;
}

// Every node with a position, so that one drag can't move the ones that were only laid out.
export function placed(graph: Graph, heightOf?: HeightOf): Graph {
	if (graph.nodes.every(placedAt)) return graph;
	const places = layout(graph, heightOf);
	return { ...graph, nodes: graph.nodes.map((node) => (placedAt(node) ? node : { ...node, ...places.get(node.id) })) };
}

// Every node where the layout puts it, as one edit, for a graph whose nodes were moved about or added in a heap.
export function tidy(graph: Graph, heightOf?: HeightOf): Graph {
	const places = layout(graph, heightOf);
	return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, ...places.get(node.id) })) };
}

export interface Size {
	width: number;
	height: number;
}

const MARGIN = 16; // Kept clear around a node placed by the editor, so that its ports and title aren't hidden
const SEARCH_STEP = 10;
const SEARCH_RINGS = 300;

// The nearest place to `want` where a node of this size covers no other, searched outwards one ring at a time. A new node
// never lands on top of another, where it would hide one and look like a single node.
export function freeSpot(graph: Graph, want: Point, size: Size, sizeOf: (node: GraphNode) => Size): Point {
	const boxes = graph.nodes
		.filter(placedAt)
		.map((node) => ({ x: node.x as number, y: node.y as number, ...sizeOf(node) }));
	const free = (x: number, y: number) =>
		boxes.every(
			(box) =>
				x >= box.x + box.width + MARGIN ||
				box.x >= x + size.width + MARGIN ||
				y >= box.y + box.height + MARGIN ||
				box.y >= y + size.height + MARGIN
		);
	const start = { x: Math.round(want.x), y: Math.round(want.y) };
	for (let ring = 0; ring <= SEARCH_RINGS; ++ring) {
		const cells: Point[] = [];
		for (let i = -ring; i <= ring; ++i) cells.push({ x: i, y: -ring }, { x: i, y: ring });
		for (let j = -ring + 1; j < ring; ++j) cells.push({ x: -ring, y: j }, { x: ring, y: j });
		let best: Point | null = null;
		let distance = Infinity;
		for (const cell of cells) {
			const at = { x: start.x + cell.x * SEARCH_STEP, y: start.y + cell.y * SEARCH_STEP };
			const d = Math.hypot(cell.x, cell.y);
			if (d < distance && free(at.x, at.y)) {
				best = at;
				distance = d;
			}
		}
		if (best) return best;
	}
	return { x: start.x, y: Math.max(start.y, ...boxes.map((box) => box.y + box.height + MARGIN)) };
}

export function addNode(graph: Graph, type: GraphNode['type'], x: number, y: number): { graph: Graph; id: number } {
	const id = Math.max(0, ...graph.nodes.map((node) => node.id)) + 1;
	return { graph: { ...graph, nodes: [...graph.nodes, { id, type, x, y }] }, id };
}

export function removeNode(graph: Graph, id: number): Graph {
	return {
		...graph,
		nodes: graph.nodes.filter((node) => node.id !== id),
		edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id)
	};
}

export function moveNode(graph: Graph, id: number, x: number, y: number): Graph {
	return { ...graph, nodes: graph.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)) };
}

const inputName = (edge: GraphEdge) => edge.input ?? 'in';
const portName = (edge: GraphEdge) => edge.port ?? 'out';

export const edgeInto = (graph: Graph, id: number, input: string) =>
	graph.edges.find((edge) => edge.to === id && inputName(edge) === input);

// An input takes one wire, so a new one replaces whatever was there. A wire takes over from a typed-in value too.
export function connect(graph: Graph, from: number, port: string, to: number, input: string): Graph {
	const edges = graph.edges.filter((edge) => !(edge.to === to && inputName(edge) === input));
	return { ...graph, edges: [...edges, { from, port, to, input }] };
}

export function disconnect(graph: Graph, to: number, input: string): Graph {
	return { ...graph, edges: graph.edges.filter((edge) => !(edge.to === to && inputName(edge) === input)) };
}

export function setLiteral(graph: Graph, id: number, input: string, value: number | undefined): Graph {
	return {
		...graph,
		nodes: graph.nodes.map((node) => {
			if (node.id !== id) return node;
			const inputs = { ...node.inputs };
			if (value === undefined) delete inputs[input];
			else inputs[input] = value;
			const { inputs: _, ...rest } = node;
			return Object.keys(inputs).length ? { ...rest, inputs } : (rest as GraphNode);
		})
	};
}

// A change of mode can take inputs and outputs away, and a wire left on one would be an error nobody asked for.
export function setOption(
	graph: Graph,
	id: number,
	name: string,
	value: string | number | undefined,
	catalog: CatalogEntry[],
	library: LibraryPatch[]
): Graph {
	const nodes = graph.nodes.map((node) => {
		if (node.id !== id) return node;
		const next: GraphNode = { ...node };
		if (value === undefined) delete next[name];
		else next[name] = value;
		return next;
	});
	const changed = nodes.find((node) => node.id === id);
	if (!changed) return graph;
	const inputs = new Set(inputsOf(changed, catalog, library).map((input) => input.name));
	const outputs = new Set(outputsOf(changed, catalog, library));
	const edges = graph.edges.filter(
		(edge) => (edge.to !== id || inputs.has(inputName(edge))) && (edge.from !== id || outputs.has(portName(edge)))
	);
	return { ...graph, nodes, edges };
}

export interface Zone {
	asset: string;
	keys?: [number, number];
	velocities?: [number, number];
	root?: number;
}

export const zonesOf = (node: GraphNode): Zone[] => (Array.isArray(node.zones) ? (node.zones as Zone[]) : []);

// A value that isn't one of a node's plain options, such as a list of zones or a switch, which nothing wires to.
export function setField(graph: Graph, id: number, name: string, value: unknown): Graph {
	return {
		...graph,
		nodes: graph.nodes.map((node) => {
			if (node.id !== id) return node;
			const next: GraphNode = { ...node };
			if (value === undefined) delete next[name];
			else next[name] = value;
			return next;
		})
	};
}

export function setZone(graph: Graph, id: number, index: number, change: Partial<Zone>): Graph {
	const node = graph.nodes.find((candidate) => candidate.id === id);
	if (!node) return graph;
	return setField(
		graph,
		id,
		'zones',
		zonesOf(node).map((zone, i) => (i === index ? { ...zone, ...change } : zone))
	);
}

export function addZone(graph: Graph, id: number, asset: string): Graph {
	const node = graph.nodes.find((candidate) => candidate.id === id);
	return node ? setField(graph, id, 'zones', [...zonesOf(node), { asset }]) : graph;
}

export function removeZone(graph: Graph, id: number, index: number): Graph {
	const node = graph.nodes.find((candidate) => candidate.id === id);
	return node
		? setField(
				graph,
				id,
				'zones',
				zonesOf(node).filter((_, i) => i !== index)
			)
		: graph;
}

// A snap on the wire into an input, which is what the compiler asks for when audio reaches an input it reads once a frame. The
// snap takes the wire's source, and the input takes the snap. Only the patch's author knows whether reading once a frame is
// right, section 5 of Design.md, so the editor offers this and never does it on its own.
export function insertSnap(
	graph: Graph,
	to: number,
	input: string,
	x: number,
	y: number
): { graph: Graph; id: number } | null {
	const wire = edgeInto(graph, to, input);
	if (!wire) return null;
	const { graph: added, id } = addNode(graph, 'snap', x, y);
	const edges = added.edges.flatMap((edge) =>
		edge === wire
			? [
					{ from: edge.from, port: portName(edge), to: id, input: 'in' },
					{ from: id, port: 'out', to, input }
				]
			: [edge]
	);
	return { graph: { ...added, edges }, id };
}

const RATE_ERROR = /^input '([^']+)' is read once a frame and cannot take audio/;

// The input a compile error says can't take audio, which a snap on its wire would fix, or null for any other error.
export const rateErrorInput = (message: string): string | null => RATE_ERROR.exec(message)?.[1] ?? null;

// Why the compiler left a node out, where the graph alone shows it. The compiler keeps what the out node depends on, so a node
// none of whose wires lead there makes nothing that is heard. A node that does lead there and was still left out, such as a
// subpatch whose own outlets go nowhere, has its reason inside another graph, and this says nothing.
export function whyCompiledAway(graph: Graph, id: number): string | null {
	const seen = new Set<number>();
	const stack = [id];
	while (stack.length) {
		const current = stack.pop()!;
		if (seen.has(current)) continue;
		seen.add(current);
		if (graph.nodes.find((node) => node.id === current)?.type === 'out') return null;
		for (const edge of graph.edges) if (edge.from === current) stack.push(edge.to);
	}
	return 'Nothing it makes reaches the out node, so it compiled away.';
}

// Which of this patch's nodes an error belongs to. Inside a subpatch that is the subpatch's node, since that is what is on
// screen. An error somewhere else in the library has no node here.
export function nodeOfError(where: string, patch: string): number | null {
	const prefix = `patch:${patch}/node:`;
	if (!where.startsWith(prefix)) return null;
	const id = Number.parseInt(where.slice(prefix.length), 10);
	return Number.isNaN(id) ? null : id;
}

// A curve as an author types it: numbers with commas or spaces between them.
export function parseCurve(text: string): number[] {
	return text
		.split(/[\s,]+/)
		.filter(Boolean)
		.map(Number);
}
