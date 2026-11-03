import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	addRecipe,
	BUILTIN,
	buildCatalogue,
	readCatalogue,
	syncBuiltins,
	type Catalogue
} from '#lib/server/Builtins.ts';
import { compileRequest, compileSnapshot } from '#lib/server/Compile.ts';
import { openDatabase, type Db } from '#lib/server/Db.ts';
import { readRecipe, RECIPES, recipeInLibrary, recipeTimelineId, type RecipeProject } from '#lib/server/Recipes.ts';
import {
	assetsById,
	assetsFor,
	createTimeline,
	deleteAsset,
	deletePatch,
	deleteTimeline,
	duplicatePatch,
	getPatch,
	getTimeline,
	libraryAssets,
	listAssets,
	listPatches,
	listTimelines,
	patchUsers,
	ReadOnly,
	saveEdits,
	savePatch,
	saveTimeline,
	snapshot
} from '#lib/server/Repository.ts';
import { seedDemo } from '#lib/server/Seed.ts';
import { patches } from '#lib/server/Tables.ts';
import { EMPTY_GRAPH, referencedPatches, timelineSchema, type Graph, type Timeline } from '#lib/Schema.ts';
import { replacePatch } from '#lib/TimelineEdit.ts';
import { eq } from 'drizzle-orm';

let catalogue: Catalogue;
let db: Db;

beforeAll(async () => {
	catalogue = await readCatalogue();
});

beforeEach(() => {
	db = openDatabase(':memory:');
	syncBuiltins(db, catalogue);
});

const project = async (name: string) => (await readRecipe(name)) as RecipeProject;
const builtins = () => listPatches(db).filter((patch) => patch.builtin);

describe('the built-in patches', () => {
	it("are every example's patches, and a graph several examples share is one of them", () => {
		const ids = new Set(catalogue.patches.map((patch) => patch.id));
		expect(ids.size).toBe(catalogue.patches.length);
		for (const { name } of RECIPES) {
			expect(Object.keys(catalogue.parts[name]).length).toBeGreaterThan(0);
			for (const id of Object.values(catalogue.parts[name])) expect(ids.has(id)).toBe(true);
		}
		expect(catalogue.parts.DrumLoop.kick).toBe(`${BUILTIN}Kick808`);
		expect(catalogue.parts.DrumLoop.hat).toBe(`${BUILTIN}HiHat`);
		expect(catalogue.patches.length).toBeLessThan(RECIPES.flatMap((r) => Object.keys(catalogue.parts[r.name])).length);
	});

	it('share a recording several examples have', () => {
		const ids = catalogue.assets.map((asset) => asset.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain(`${BUILTIN}OneShotSample-soft`);
		expect(ids).not.toContain(`${BUILTIN}VelocityLayers-soft`);
		const layers = catalogue.patches.find((patch) => patch.id === `${BUILTIN}VelocityLayers`)!;
		expect(JSON.stringify(layers.graph)).toContain(`${BUILTIN}OneShotSample-soft`);
		expect(JSON.stringify(layers.graph)).toContain(`${BUILTIN}VelocityLayers-loud`);
	});

	it('are named after their example, with the part for one of several', () => {
		const byId = new Map(catalogue.patches.map((patch) => [patch.id, patch]));
		expect(byId.get(`${BUILTIN}Kick808`)?.name).toBe('Kick808');
		expect(byId.get(`${BUILTIN}PassionChorale-horn`)?.name).toBe('PassionChorale Horn');
		for (const patch of catalogue.patches) expect(patch.name.startsWith(patch.example)).toBe(true);
	});

	it('are in a library from the start, and syncing again changes nothing', () => {
		expect(builtins().map((p) => p.id)).toEqual(
			[...catalogue.patches].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((p) => p.id)
		);
		expect(listAssets(db).filter((asset) => asset.builtin)).toHaveLength(catalogue.assets.length);
		expect(syncBuiltins(db, catalogue)).toEqual([]);
		expect(builtins().every((patch) => patch.revision === 1)).toBe(true);
	});

	it("can't be saved, deleted or have their recordings deleted, however the request comes", () => {
		const kick = getPatch(db, `${BUILTIN}Kick808`);
		expect(() => savePatch(db, kick.id, kick.revision, 'Mine', EMPTY_GRAPH)).toThrow(ReadOnly);
		expect(() =>
			saveEdits(db, {
				patches: [{ id: kick.id, revision: kick.revision, name: 'Mine', graph: EMPTY_GRAPH }],
				timelines: []
			})
		).toThrow(ReadOnly);
		expect(() => deletePatch(db, kick.id)).toThrow(ReadOnly);
		expect(() => deleteAsset(db, `${BUILTIN}OneShotSample-soft`)).toThrow(ReadOnly);
		expect(getPatch(db, kick.id)).toEqual(kick);
	});

	it('are put back as they ship by the next sync, whatever happened to their rows', () => {
		const id = `${BUILTIN}Kick808`;
		const before = getPatch(db, id);
		db.update(patches).set({ graph: EMPTY_GRAPH, name: 'Changed' }).where(eq(patches.id, id)).run();
		syncBuiltins(db, catalogue);
		const after = getPatch(db, id);
		expect(after.graph).toEqual(before.graph);
		expect(after.name).toBe('Kick808');
		expect(after.revision).toBe(before.revision + 1); // So an editor holding the old one knows
	});

	it('go when they no longer ship, unless something uses them', () => {
		const used = `${BUILTIN}Kick808`;
		const unused = `${BUILTIN}Snare`;
		createTimeline(db, 'Mine', timeline([used]), 'mine');
		const fewer: Catalogue = {
			...catalogue,
			patches: catalogue.patches.filter((patch) => patch.id !== used && patch.id !== unused)
		};
		expect(syncBuiltins(db, fewer)).toEqual([used]);
		expect(getPatch(db, used).builtin).toBe(true);
		expect(() => getPatch(db, unused)).toThrow();
		expect(() => savePatch(db, used, 1, 'Mine', EMPTY_GRAPH)).toThrow(ReadOnly);
	});

	it('name the built-in that a part they expand became, and keep patches that expand each other apart', () => {
		const leaf: Graph = { params: [], nodes: [{ id: 1, type: 'noise' }], edges: [] };
		const using = (patch: string): Graph => ({ params: [], nodes: [{ id: 1, type: 'subpatch', patch }], edges: [] });
		const built = buildCatalogue([
			{
				name: 'Big',
				project: { patches: { a: { name: 'a', graph: using('b') }, b: { name: 'b', graph: leaf } }, programs: [] }
			},
			{ name: 'Small', project: { patches: { p: { name: 'p', graph: leaf } }, programs: [] } },
			{
				name: 'Loop',
				project: { patches: { x: { name: 'x', graph: using('y') }, y: { name: 'y', graph: using('x') } }, programs: [] }
			}
		]);
		expect(built.parts.Small.p).toBe(`${BUILTIN}Small`);
		expect(built.parts.Big.b).toBe(`${BUILTIN}Small`);
		expect(built.patches.find((p) => p.id === built.parts.Big.a)?.graph.nodes[0].patch).toBe(`${BUILTIN}Small`);
		expect(built.parts.Loop).toEqual({ x: `${BUILTIN}Loop-x`, y: `${BUILTIN}Loop-y` });
		expect(built.patches.find((p) => p.id === `${BUILTIN}Loop-x`)?.graph.nodes[0].patch).toBe(`${BUILTIN}Loop-y`);
	});
});

const timeline = (slots: string[], inserts: string[] = []): Timeline =>
	timelineSchema.parse({
		clips: [{ id: 'c', length: 480, notes: [{ tick: 0, note: 60, dur: 100 }] }],
		tracks: [{ id: 1, slots, placements: [{ clip: 'c', tick: 0 }], inserts: inserts.map((patch) => ({ patch })) }]
	});

describe("an editor page's recordings", () => {
	it('are what they were before built-ins when a library uses none', () => {
		seedDemo(db);
		const own = listPatches(db)
			.filter((patch) => !patch.builtin)
			.map((patch) => patch.id);
		expect(libraryAssets(db)).toEqual(assetsFor(db, own));
		expect(libraryAssets(db).some((asset) => asset.id.startsWith(BUILTIN))).toBe(false);
	});

	it("include a built-in patch's once a timeline plays it", () => {
		createTimeline(db, 'Mine', timeline([`${BUILTIN}OneShotSample`]), 'mine');
		expect(libraryAssets(db).map((asset) => asset.id)).toEqual([`${BUILTIN}OneShotSample-soft`]);
	});

	it('come by id for a built-in patch nothing uses yet', () => {
		const ids = [`${BUILTIN}VelocityLayers-loud`, `${BUILTIN}OneShotSample-soft`];
		expect(assetsById(db, ids).map((asset) => asset.id)).toEqual([...ids].sort());
		expect(assetsById(db, [])).toEqual([]);
	});
});

// An image is a function of what the compiler reads, so equal bytes mean nothing in the app's schema dropped a field and no id
// was missed, in any example.
describe('an example added to the library', () => {
	it.each(RECIPES.map((recipe) => recipe.name))('%s compiles to the bytes of the original', async (name) => {
		const original = await compileRequest(JSON.stringify(await project(name)));
		expect(original.report.ok).toBe(true);
		const copy = await compileSnapshot(snapshot(db, [addRecipe(db, name, await project(name), catalogue)]));
		expect(copy.report.errors).toBeUndefined();
		expect(Buffer.from(copy.image).equals(Buffer.from(original.image))).toBe(true);
	});

	it('is only a timeline, which plays the built-in patches', async () => {
		const before = listPatches(db).length;
		const id = addRecipe(db, 'DrumLoop', await project('DrumLoop'), catalogue);
		expect(listPatches(db)).toHaveLength(before);
		expect(referencedPatches(timelineSchema.parse(getTimeline(db, id).doc))).toEqual(
			[`${BUILTIN}Clap`, `${BUILTIN}HiHat`, `${BUILTIN}Kick808`, `${BUILTIN}Snare`].sort()
		);
		expect(patchUsers(db, `${BUILTIN}Kick808`).map((t) => t.name)).toEqual(['DrumLoop']);
	});

	it('does nothing the second time, so an edit to the copy survives', async () => {
		const id = addRecipe(db, 'Kick808', await project('Kick808'), catalogue);
		const row = getTimeline(db, id);
		saveTimeline(db, id, row.revision, 'Mine now', row.doc as Timeline);
		expect(addRecipe(db, 'Kick808', await project('Kick808'), catalogue)).toBe(id);
		expect(getTimeline(db, id).name).toBe('Mine now');
	});

	it('comes back after its timeline was deleted', async () => {
		addRecipe(db, 'Kick808', await project('Kick808'), catalogue);
		deleteTimeline(db, recipeTimelineId('Kick808'));
		expect(recipeInLibrary(db, 'Kick808')).toBe(false);
		addRecipe(db, 'Kick808', await project('Kick808'), catalogue);
		expect(listTimelines(db).map((t) => t.id)).toEqual([recipeTimelineId('Kick808')]);
	});
});

describe('a duplicate of a built-in patch', () => {
	it.each(['OneShotSample', 'Reverb', 'SidechainDucking'])(
		'is an ordinary patch, and %s compiles to the same bytes playing copies',
		async (name) => {
			const original = await compileRequest(JSON.stringify(await project(name)));
			const id = addRecipe(db, name, await project(name), catalogue);
			let doc = timelineSchema.parse(getTimeline(db, id).doc);
			for (const builtin of referencedPatches(doc)) doc = replacePatch(doc, builtin, duplicatePatch(db, builtin));
			saveTimeline(db, id, getTimeline(db, id).revision, name, doc);
			expect(referencedPatches(doc).some((patch) => patch.startsWith(BUILTIN))).toBe(false);
			const copy = await compileSnapshot(snapshot(db, [id]));
			expect(Buffer.from(copy.image).equals(Buffer.from(original.image))).toBe(true);
		}
	);

	it('can be changed and deleted, and shares its recording rather than copying it', () => {
		const assets = listAssets(db).length;
		const copy = duplicatePatch(db, `${BUILTIN}OneShotSample`);
		expect(listAssets(db)).toHaveLength(assets);
		const row = getPatch(db, copy);
		expect(row.name).toBe('OneShotSample copy');
		expect(row.builtin).toBe(false);
		expect(libraryAssets(db).map((asset) => asset.id)).toEqual([`${BUILTIN}OneShotSample-soft`]);
		savePatch(db, copy, row.revision, 'Mine', row.graph as Graph);
		deletePatch(db, copy);
		expect(libraryAssets(db)).toEqual([]);
	});
});
