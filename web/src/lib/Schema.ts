// The documents the app stores. The same schemas validate on the server and shape the editors, and they are deliberately
// close to what the compiler reads, so a saved document needs no translation.
import { z } from 'zod';

export const NODE_TYPES = [
	'note', 'param', 'const', 'osc', 'noise', 'biquad', 'env', 'sample', 'mul', 'add', 'mtof', 'snap', 'ratio', 'pan',
	'delay', 'comb', 'allpass', 'follow', 'lfo', 'in', 'out'
] as const;

const id16 = z.number().int().min(0).max(65535);
const tick = z.number().int().min(0).max(0x7fffffff);

export const paramSchema = z.object({
	id: id16,
	name: z.string().max(100).default(''),
	scope: z.enum(['voice', 'track', 'global']).default('track'),
	min: z.number(),
	max: z.number(),
	default: z.number(),
	smooth_ms: z.number().int().min(0).max(5000).default(10)
});

const nodeSchema = z.looseObject({
	id: z.number().int().min(0).max(1 << 20),
	type: z.enum(NODE_TYPES),
	inputs: z.record(z.string(), z.number()).optional()
});

const edgeSchema = z.object({
	from: z.number().int(),
	port: z.string().optional(),
	to: z.number().int(),
	input: z.string().optional()
});

export const graphSchema = z.object({
	params: z.array(paramSchema).default([]),
	nodes: z.array(nodeSchema),
	edges: z.array(edgeSchema).default([])
});

const noteSchema = z.object({
	tick,
	note: z.number().int().min(0).max(127),
	vel: z.number().int().min(0).max(127).default(100),
	dur: z.number().int().min(1),
	slot: z.number().int().min(0).optional()
});

// A lane with no target moves a parameter of its own track's patch. A target reaches past it, and new kinds of target
// can join this union later, which is why it is an object and refuses keys it doesn't know.
const laneTargetSchema = z.union([
	z.strictObject({ insert: id16 }),
	z.strictObject({ mix: z.literal('fader'), track: id16 }),
	z.strictObject({ mix: z.literal('fader'), bus: z.string().min(1) }),
	z.strictObject({ mix: z.literal('fader'), master: z.literal(true) }),
	z.strictObject({ mix: z.literal('pan'), track: id16 }),
	z.strictObject({ mix: z.literal('pan'), bus: z.string().min(1) }),
	z.strictObject({ mix: z.literal('send'), track: id16, to: z.string().min(1) }),
	z.strictObject({ mix: z.literal('send'), bus: z.string().min(1), to: z.string().min(1) })
]);

const automationSchema = z.object({
	param: id16.optional(),
	target: laneTargetSchema.optional(),
	tick,
	value: z.number(),
	ramp: z.number().int().min(0).optional()
});

const playFields = {
	mode: z.enum(['poly', 'mono', 'legato']).default('poly'),
	priority: z.enum(['last', 'high', 'low']).default('last'),
	glide: z.number().min(0).max(60).default(0)
};
const playSchema = z.object(playFields);
const playChangeSchema = z.object({ tick, ...playFields });

const clipSchema = z.object({
	id: z.string().min(1),
	length: z.number().int().min(1),
	notes: z.array(noteSchema).default([]),
	automation: z.array(automationSchema).default([]),
	play: z.array(playChangeSchema).default([])
});

const insertSchema = z.object({
	id: id16.optional(),
	patch: z.string().min(1),
	params: z.record(z.string(), z.number()).optional(),
	key: z.string().optional()
});

const sendSchema = z.object({ bus: z.string().min(1), gain: z.number().min(0).max(4).default(1) });

const routing = {
	gain: z.number().min(0).max(4).default(1),
	pan: z.number().min(-1).max(1).default(0),
	mute: z.boolean().default(false),
	output: z.string().default('master'),
	sends: z.array(sendSchema).default([]),
	inserts: z.array(insertSchema).default([])
};

const placementSchema = z.object({
	clip: z.string().min(1),
	tick,
	repeat: z.number().int().min(1).max(100000).default(1)
});

const trackSchema = z.object({
	id: id16,
	name: z.string().max(100).default(''),
	voices: z.number().int().min(1).max(256).default(4),
	slots: z.array(z.string().min(1)).default([]),
	params: z.record(z.string(), z.number()).default({}),
	placements: z.array(placementSchema).default([]),
	play: playSchema.optional(),
	...routing
});

const busSchema = z.object({ id: z.string().min(1), ...routing });

export const timelineSchema = z.object({
	ppq: z.number().int().min(1).max(65535).default(480),
	tempo: z.array(z.object({ tick, bpm: z.number().min(1).max(1000) })).default([{ tick: 0, bpm: 120 }]),
	clips: z.array(clipSchema).default([]),
	tracks: z.array(trackSchema).default([]),
	buses: z.array(busSchema).default([]),
	master: z
		.object({ gain: z.number().min(0).max(4).default(1), inserts: z.array(insertSchema).default([]) })
		.default({ gain: 1, inserts: [] }),
	globals: z.record(z.string(), z.number()).default({})
});

export type Graph = z.infer<typeof graphSchema>;
export type Param = z.infer<typeof paramSchema>;
export type Timeline = z.infer<typeof timelineSchema>;

export const EMPTY_GRAPH: Graph = {
	params: [],
	nodes: [
		{ id: 1, type: 'note' },
		{ id: 2, type: 'mtof' },
		{ id: 3, type: 'osc', wave: 'sine' },
		{ id: 4, type: 'env' },
		{ id: 5, type: 'mul' },
		{ id: 6, type: 'out' }
	],
	edges: [
		{ from: 1, port: 'pitch', to: 2, input: 'in' },
		{ from: 2, to: 3, input: 'freq' },
		{ from: 3, to: 5, input: 'a' },
		{ from: 4, to: 5, input: 'b' },
		{ from: 5, to: 6, input: 'l' }
	]
};

export const EMPTY_TIMELINE: Timeline = timelineSchema.parse({});

// Every library patch a timeline names, whether or not a note plays it. This feeds the delete guard. What goes into an
// image is the compiler's walk, which is narrower.
export function referencedPatches(doc: Timeline): string[] {
	const ids = new Set<string>();
	for (const track of doc.tracks) {
		for (const slot of track.slots) ids.add(slot);
		for (const insert of track.inserts) ids.add(insert.patch);
	}
	for (const bus of doc.buses) {
		for (const insert of bus.inserts) ids.add(insert.patch);
	}
	for (const insert of doc.master.inserts) ids.add(insert.patch);
	return [...ids].sort();
}

export function referencedAssets(graph: Graph): string[] {
	const ids = new Set<string>();
	for (const node of graph.nodes) {
		if (node.type !== 'sample') continue;
		if (typeof node.asset === 'string') ids.add(node.asset);
		if (Array.isArray(node.zones)) {
			for (const zone of node.zones) {
				if (typeof zone?.asset === 'string') ids.add(zone.asset);
			}
		}
	}
	return [...ids].sort();
}
