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

export interface MixRoute {
	to: string;
	left: number;
	right: number;
}

export interface ChainReport {
	id: number | string;
	name?: string;
	index?: number;
	step: number;
	bus: number;
	mix: MixRoute[];
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
	master: { step: number; bus: number };
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
