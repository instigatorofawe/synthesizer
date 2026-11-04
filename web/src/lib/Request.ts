// Builds the compiler's input. The browser preview and the server export both come through here, so given the same rows
// they send the same JSON and get the same bytes.
import { referencedAssets, referencedSubpatches, type Graph, type Timeline } from '#lib/Schema.ts';

export interface PatchEntry {
	id: string;
	name: string;
	graph: Graph;
}

export interface AssetEntry {
	id: string;
	name: string;
	encoding: string;
	channels: number;
	rate: number;
	frames: number;
	root_key: number;
	loop_start: number;
	loop_end: number;
	data: string; // base64
}

export interface ProgramEntry {
	id: string;
	name: string;
	timeline: Timeline;
}

export interface RequestOptions {
	omit?: string[];
	live?: boolean;
}

// What a preview has to send: these patches, what they expand, and the assets all of those name. A compile runs on every edit,
// and a library can hold megabytes of samples that this one has nothing to do with.
export function reachable(roots: string[], patches: PatchEntry[], assets: AssetEntry[]) {
	const byId = new Map(patches.map((patch) => [patch.id, patch]));
	const found = new Map<string, PatchEntry>();
	const waiting = [...roots];
	while (waiting.length) {
		const patch = byId.get(waiting.pop() as string);
		if (!patch || found.has(patch.id)) continue;
		found.set(patch.id, patch);
		waiting.push(...referencedSubpatches(patch.graph));
	}
	const named = new Set([...found.values()].flatMap((patch) => referencedAssets(patch.graph)));
	return { patches: [...found.values()], assets: assets.filter((asset) => named.has(asset.id)) };
}

// The recordings those patches name that the page doesn't hold yet, which a built-in patch's are until something saved uses it.
export function missingAssets(roots: string[], patches: PatchEntry[], assets: AssetEntry[]): string[] {
	const have = new Set(assets.map((asset) => asset.id));
	const named = reachable(roots, patches, []).patches.flatMap((patch) => referencedAssets(patch.graph));
	return [...new Set(named)].filter((id) => !have.has(id)).sort();
}

export function buildRequest(
	patches: PatchEntry[],
	assets: AssetEntry[],
	programs: ProgramEntry[],
	options: RequestOptions = {}
): string {
	return JSON.stringify({
		patches: Object.fromEntries(patches.map((p) => [p.id, { name: p.name, graph: p.graph }])),
		assets: Object.fromEntries(assets.map(({ id, ...rest }) => [id, rest])),
		programs,
		omit: options.omit ?? [],
		live: options.live ?? false
	});
}

export interface ChunkReport {
	kind: 'asset' | 'table' | 'patch' | 'program';
	hash: string;
	size: number;
	present: boolean;
	programs: number;
}

// A pair of mix registers, and the factors whose product it holds.
export interface MixPair {
	left: number;
	right: number;
	of?: ('fader' | 'mute' | 'pan' | 'send' | 'master')[];
}

export interface MixRoute extends MixPair {
	to: string;
	pre?: boolean;
}

export interface ChainReport {
	id: number | string;
	name?: string;
	index?: number;
	step: number;
	bus: number;
	mix: MixRoute[];
	stages?: MixPair[]; // A factor applied to the whole chain by a step of its own, once a lane on it would share a pair
	notes_at_once?: number; // The most notes a track holds at once while it plays poly
	// A track's: the song's slot each of the image's slots is, in order. The image holds only the slots notes play, unless it
	// was compiled `live`, so a live note naming a slot names it as the image numbers it.
	slots?: number[];
}

// Something that compiles but may not sound as meant, such as a track with too few voices for what it holds.
export interface CompileWarning {
	where: string;
	message: string;
	tick?: number;
}

export interface ProgramReport {
	id?: string;
	name: string;
	index: number;
	hash: string;
	ppq: number;
	length_ticks: number;
	size: number;
	tracks: ChainReport[];
	buses: ChainReport[];
	master: { step: number; bus: number; stages?: MixPair[] };
	warnings?: CompileWarning[];
	inserts: { id: number; index: number }[]; // Where each insert id sits in the image, which a live change addresses
	patches: { id: string; hash: string }[];
}

// The debug sidecar: what each graph node's outputs became. A node that compiled away isn't in it.
export interface PortReport {
	rate: 'audio' | 'control';
	step?: number;
	operand?: number;
}

export type NodesReport = Record<string, { ports: Record<string, PortReport> }>;

export interface CompileReport {
	ok: boolean;
	sidecar?: Record<string, NodesReport>;
	errors?: { where: string; message: string }[];
	programs: ProgramReport[];
	chunks: ChunkReport[];
	image_bytes: number;
	chunk_bytes: number;
	omitted_bytes: number;
	library_patches: number;
	compiled_patches: number;
}
