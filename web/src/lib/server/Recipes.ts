// The recipes in examples/Recipes, as a read-only catalogue. They play from here as they are, and adding one makes copies in
// the library, which are then ordinary patches and timelines. Copies rather than rows of their own, so nobody's edit can
// change what ships, and a library holds only what someone chose: all of them together carry about 600 KB of samples, and
// every patch page loads the library.
import { eq } from 'drizzle-orm';
import index from '../../../../examples/Recipes/Index.json';
import type { Db } from '#lib/server/Db.ts';
import { createAsset, createPatch, createTimeline } from '#lib/server/Repository.ts';
import { assets, patches, timelines } from '#lib/server/Tables.ts';
import { graphSchema, timelineSchema, type Graph, type Timeline } from '#lib/Schema.ts';
import type { AssetEntry } from '#lib/Request.ts';

export interface RecipeEntry {
	name: string;
	file: string;
	seconds: number;
	group: string;
	listen_for: string;
}

export interface RecipeProject {
	patches: Record<string, { name: string; graph: unknown }>;
	assets?: Record<string, Omit<AssetEntry, 'id' | 'name' | 'loop_start' | 'loop_end'> & Partial<AssetEntry>>;
	programs: { id: string; name: string; timeline: unknown }[];
}

export const RECIPES: RecipeEntry[] = index;

// Loaded one at a time, because the ones with recordings are large and a page needs only one.
const files = import.meta.glob<{ default: RecipeProject }>('../../../../examples/Recipes/*.json');

export async function readRecipe(name: string): Promise<RecipeProject | null> {
	const entry = RECIPES.find((recipe) => recipe.name === name);
	if (!entry) return null;
	const file = Object.keys(files).find((path) => path.endsWith(`/${entry.file}`));
	return file ? (await files[file]()).default : null;
}

export const recipeTimelineId = (name: string) => `recipe-${name}`;
const patchId = (name: string, id: string) => `recipe-${name}-${id}`;
const assetId = patchId;

function exists(db: Db, table: typeof patches | typeof assets | typeof timelines, id: string) {
	return db.select({ id: table.id }).from(table).where(eq(table.id, id)).get() !== undefined;
}

export const recipeInLibrary = (db: Db, name: string) => exists(db, timelines, recipeTimelineId(name));

// Ids are unique within a recipe and every recipe says `p`, so a copy's ids carry the recipe's name.
function renamedGraph(graph: Graph, name: string): Graph {
	return {
		...graph,
		nodes: graph.nodes.map((node) => {
			if (node.type !== 'sample') return node;
			const copy = { ...node };
			if (typeof copy.asset === 'string') copy.asset = assetId(name, copy.asset);
			if (Array.isArray(copy.zones)) {
				copy.zones = copy.zones.map((zone: { asset: string }) => ({ ...zone, asset: assetId(name, zone.asset) }));
			}
			return copy;
		})
	};
}

function renamedTimeline(doc: Timeline, name: string): Timeline {
	const renamedInserts = <T extends { inserts: { patch: string }[] }>(chain: T): T => ({
		...chain,
		inserts: chain.inserts.map((insert) => ({ ...insert, patch: patchId(name, insert.patch) }))
	});
	return {
		...doc,
		tracks: doc.tracks.map((track) => ({
			...renamedInserts(track),
			slots: track.slots.map((slot) => patchId(name, slot))
		})),
		buses: doc.buses.map(renamedInserts),
		master: renamedInserts(doc.master)
	};
}

// Copies a recipe into the library and returns its timeline. A part already there is left alone, because someone may have
// changed it, so adding a recipe twice loses nothing.
export function addRecipe(db: Db, name: string, project: RecipeProject): string {
	const id = recipeTimelineId(name);
	return db.transaction((tx) => {
		const t = tx as unknown as Db;
		if (exists(t, timelines, id)) return id;
		for (const [key, asset] of Object.entries(project.assets ?? {})) {
			const copy = assetId(name, key);
			if (exists(t, assets, copy)) continue;
			createAsset(t, { loop_start: 0, loop_end: 0, ...asset, id: copy, name: `${name} ${key}` });
		}
		const ids = Object.keys(project.patches);
		for (const [key, patch] of Object.entries(project.patches)) {
			const copy = patchId(name, key);
			if (exists(t, patches, copy)) continue;
			const label = ids.length === 1 ? name : `${name} ${patch.name || key}`;
			createPatch(t, label, renamedGraph(graphSchema.parse(patch.graph), name), copy);
		}
		const doc = renamedTimeline(timelineSchema.parse(project.programs[0].timeline), name);
		return createTimeline(t, name, doc, id);
	});
}
