// The examples' patches, as built-in patches that every library holds from the start, so any timeline can play one in a slot
// or an insert. They are rows like any patch, so the delete guards, "used by" and exports treat them as they treat the rest,
// but only `syncBuiltins` writes them, from examples/ as it ships, every time the server starts. Nothing anyone does in the
// app reaches examples/ or changes these rows: a change goes to a copy, which Edit a copy makes.
//
// A graph several examples share, such as the drum loop's kick and the Kick808 recipe's, is one built-in patch, and so is a
// recording. Their recordings are rows too, and a page loads one only once something uses it (`libraryAssets`).
//
// The standard set's patches are named for what they are rather than where they come from: its instrument GrandPiano is
// `builtin-gm-GrandPiano`, whichever of the set's examples plays it, so MIDI import can name the patch a program plays. The
// set's examples come first, so a piece or a recipe whose graph is one of the set's plays the set's patch.
import { setPatch } from '#lib/GeneralMidi.ts';
import type { Db } from '#lib/server/Db.ts';
import {
	GROUPS,
	inSet,
	readRecipe,
	RECIPES,
	recipeInLibrary,
	recipeTimelineId,
	type RecipeEntry,
	type RecipeProject
} from '#lib/server/Recipes.ts';
import {
	createTimeline,
	duplicatePatch,
	NotFound,
	putBuiltinAsset,
	putBuiltinPatch,
	retireBuiltins
} from '#lib/server/Repository.ts';
import { graphSchema, referencedSubpatches, timelineSchema, type Graph, type Timeline } from '#lib/Schema.ts';
import type { AssetEntry } from '#lib/Request.ts';

export interface BuiltinPatch {
	id: string;
	name: string;
	graph: Graph;
	example: string; // The example it is named after, which is the first of those that have it
}

export interface Catalogue {
	patches: BuiltinPatch[]; // A patch comes after any it expands, so each can be written in order
	assets: AssetEntry[];
	// Each example's own patch ids, as built-in ones, in the order the example lists its patches
	parts: Record<string, Record<string, string>>;
}

export interface Example {
	name: string;
	project: RecipeProject;
	set?: boolean; // One of the standard set's, from examples/Instruments
}

export const BUILTIN = 'builtin-';

// An example with one patch names it after itself, and one with several adds the patch's own name. The set's are the
// instrument's, by its key and its title.
const patchId = (example: Example, key: string) =>
	example.set
		? setPatch(key)
		: Object.keys(example.project.patches).length === 1
			? `${BUILTIN}${example.name}`
			: `${BUILTIN}${example.name}-${key}`;
const patchName = (example: Example, key: string) =>
	example.set
		? example.project.patches[key].name || key
		: Object.keys(example.project.patches).length === 1
			? example.name
			: `${example.name} ${example.project.patches[key].name || key}`;

function renamed(graph: Graph, assets: Record<string, string>, parts: Record<string, string>): Graph {
	const asset = (id: string) => assets[id] ?? id;
	return {
		...graph,
		nodes: graph.nodes.map((node) => {
			if (node.type === 'sample') {
				const copy = { ...node };
				if (typeof copy.asset === 'string') copy.asset = asset(copy.asset);
				if (Array.isArray(copy.zones)) {
					copy.zones = copy.zones.map((zone: { asset: string }) => ({ ...zone, asset: asset(zone.asset) }));
				}
				return copy;
			}
			if (node.type === 'subpatch' && typeof node.patch === 'string')
				return { ...node, patch: parts[node.patch] ?? node.patch };
			return node;
		})
	};
}

export function renamedTimeline(doc: Timeline, part: (key: string) => string): Timeline {
	const renamedInserts = <T extends { inserts: { patch: string }[] }>(chain: T): T => ({
		...chain,
		inserts: chain.inserts.map((insert) => ({ ...insert, patch: part(insert.patch) }))
	});
	return {
		...doc,
		tracks: doc.tracks.map((track) => ({ ...renamedInserts(track), slots: track.slots.map(part) })),
		buses: doc.buses.map(renamedInserts),
		master: renamedInserts(doc.master)
	};
}

// The built-in patches and recordings the examples make. The set's examples come first, in the order given, and the same
// key in two of them is one patch, as the effects' example plays the piano family's grand piano. Then an example with fewer
// patches names what it shares, and then the first by name, so the kick that the drum loop and Kick808 share is Kick808's.
export function buildCatalogue(examples: Example[]): Catalogue {
	const order = [
		...examples.filter((example) => example.set),
		...examples
			.filter((example) => !example.set)
			.sort(
				(a, b) =>
					Object.keys(a.project.patches).length - Object.keys(b.project.patches).length ||
					(a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
			)
	];
	const assets: AssetEntry[] = [];
	const assetByContent = new Map<string, string>();
	const patches: BuiltinPatch[] = [];
	const made = new Set<string>();
	const patchByGraph = new Map<string, string>();
	const parts: Catalogue['parts'] = {};

	for (const example of order) {
		const assetIds: Record<string, string> = {};
		for (const [key, asset] of Object.entries(example.project.assets ?? {})) {
			const entry: AssetEntry = {
				id: `${BUILTIN}${example.name}-${key}`,
				name: `${example.name} ${key}`,
				encoding: asset.encoding,
				channels: asset.channels,
				rate: asset.rate,
				frames: asset.frames,
				root_key: asset.root_key,
				loop_start: asset.loop_start ?? 0,
				loop_end: asset.loop_end ?? 0,
				data: asset.data
			};
			const { id: _, name: __, ...content } = entry;
			const same = JSON.stringify(content);
			const known = assetByContent.get(same);
			if (known) {
				assetIds[key] = known;
			} else {
				assetByContent.set(same, entry.id);
				assets.push(entry);
				assetIds[key] = entry.id;
			}
		}

		// A patch that expands another of this example's waits for it, so it names the built-in that one became.
		const own: Record<string, string> = {};
		const graphs = Object.fromEntries(
			Object.entries(example.project.patches).map(([key, patch]) => [key, graphSchema.parse(patch.graph)])
		);
		let waiting = Object.keys(graphs);
		while (waiting.length) {
			const ready = waiting.filter((key) =>
				referencedSubpatches(graphs[key]).every((name) => !(name in graphs) || name in own)
			);
			// Patches that expand each other can't be compiled, so each keeps a name of its own and nothing is shared.
			const cycle = ready.length === 0;
			if (cycle) for (const key of waiting) own[key] = patchId(example, key);
			for (const key of cycle ? waiting : ready) {
				const graph = renamed(graphs[key], assetIds, own);
				const same = JSON.stringify(graph);
				// Every instrument of the set is a patch of its own, even one whose graph another has, since a program names it.
				const known = cycle || example.set ? undefined : patchByGraph.get(same);
				if (known) {
					own[key] = known;
					continue;
				}
				const id = patchId(example, key);
				own[key] = id;
				if (made.has(id)) continue; // The set's, in an earlier example of the set
				made.add(id);
				if (!cycle && !patchByGraph.has(same)) patchByGraph.set(same, id);
				patches.push({ id, name: patchName(example, key), graph, example: example.name });
			}
			waiting = cycle ? [] : waiting.filter((key) => !ready.includes(key));
		}
		parts[example.name] = Object.fromEntries(Object.keys(graphs).map((key) => [key, own[key]]));
	}
	return { patches, assets, parts };
}

let catalogue: Promise<Catalogue> | undefined;

// Every example's file, read once.
export function readCatalogue(): Promise<Catalogue> {
	catalogue ??= Promise.all(
		RECIPES.map(async (entry) => ({
			name: entry.name,
			project: (await readRecipe(entry.name)) as RecipeProject,
			set: inSet(entry)
		}))
	).then(buildCatalogue);
	return catalogue;
}

// The examples as the browser lists them, in their groups. The set's examples name their family and the built-in patches
// they play, in the order they list them, which the patch pickers list the set's patches by.
export function exampleGroups(from: Catalogue, groups = GROUPS, entries: RecipeEntry[] = RECIPES) {
	return groups.map((group) => ({
		name: group,
		recipes: entries
			.filter((entry) => entry.group === group)
			.map(({ name, listen_for, family }) =>
				family === undefined
					? { name, listen_for }
					: { name, listen_for, family, patches: Object.values(from.parts[name] ?? {}) }
			)
	}));
}

// Makes the library's built-in patches and recordings what ships, in one transaction. Those that no longer ship go, unless
// something uses them, and the ids of those kept are returned.
export function syncBuiltins(db: Db, from: Catalogue): string[] {
	return db.transaction((tx) => {
		const t = tx as unknown as Db;
		for (const asset of from.assets) putBuiltinAsset(t, asset);
		for (const patch of from.patches) putBuiltinPatch(t, patch.id, patch.name, patch.graph);
		return retireBuiltins(t, new Set(from.patches.map((p) => p.id)), new Set(from.assets.map((a) => a.id)));
	});
}

// Adds a copy of an example's timeline to the library, playing the built-in patches it was made with, and returns it. Its
// patches are already there, so only the timeline is new. Adding one again leaves the copy as it is, so an edit survives.
export function addRecipe(db: Db, name: string, project: RecipeProject, from: Catalogue): string {
	const id = recipeTimelineId(name);
	if (recipeInLibrary(db, name)) return id;
	const parts = from.parts[name] ?? {};
	const doc = renamedTimeline(timelineSchema.parse(project.programs[0].timeline), (key) => parts[key] ?? key);
	return createTimeline(db, name, doc, id);
}

// Edit a copy: a built-in patch copied into the library, where it can be changed. From an example, which can't change either,
// the example comes too, as its copy in the library, added as Add to library adds it, or the copy already there, so the page
// can put the patch's copy in place of the original there. One transaction, so a copy that fails adds no timeline. Returns
// the patch copied, its copy, and the timeline, if there was an example.
export function editCopy(
	db: Db,
	id: string,
	example: { name: string; project: RecipeProject; from: Catalogue } | null
): { from: string; to: string; timeline: string | null } {
	return db.transaction((tx) => {
		const t = tx as unknown as Db;
		if (!example) return { from: id, to: duplicatePatch(t, id), timeline: null };
		if (!Object.values(example.from.parts[example.name] ?? {}).includes(id))
			throw new NotFound(`${example.name} doesn't play ${id}`);
		const timeline = addRecipe(t, example.name, example.project, example.from);
		return { from: id, to: duplicatePatch(t, id), timeline };
	});
}
