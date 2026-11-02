import { readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { compileRequest, compileSnapshot } from '#lib/server/Compile.ts';
import { openDatabase, type Db } from '#lib/server/Db.ts';
import { addRecipe, GROUPS, readRecipe, RECIPES, recipeInLibrary, recipeTimelineId } from '#lib/server/Recipes.ts';
import { deleteTimeline, getPatch, listPatches, listTimelines, savePatch, snapshot } from '#lib/server/Repository.ts';
import { EMPTY_GRAPH } from '#lib/Schema.ts';

let db: Db;

beforeEach(() => {
	db = openDatabase(':memory:');
});

describe('the recipe catalogue', () => {
	it('lists every file in examples/Recipes and examples/Pieces', () => {
		const files = ['Recipes', 'Pieces'].flatMap((folder) =>
			readdirSync(new URL(`../../../../examples/${folder}`, import.meta.url)).filter(
				(f) => f.endsWith('.json') && f !== 'Index.json'
			)
		);
		expect(RECIPES.map((recipe) => recipe.file).sort()).toEqual(files.sort());
	});

	it('names each example once, since the copies in a library are named after it', () => {
		expect(new Set(RECIPES.map((recipe) => recipe.name)).size).toBe(RECIPES.length);
	});

	it('shows the pieces first, and then the recipes by group', () => {
		expect(GROUPS[0]).toBe('pieces');
		expect(GROUPS.slice(1)).toEqual([...GROUPS.slice(1)].sort());
	});

	it('finds a recipe by name and nothing else', async () => {
		expect((await readRecipe(RECIPES[0].name))?.programs).toHaveLength(1);
		expect(await readRecipe('Nothing')).toBeNull();
		expect(await readRecipe('../Demo')).toBeNull();
	});
});

// An image is a function of what the compiler reads, so equal bytes mean nothing in the app's schema dropped a field and no id
// was missed, in any recipe.
describe('a recipe added to the library', () => {
	it.each(RECIPES.map((recipe) => recipe.name))('%s compiles to the bytes of the original', async (name) => {
		const project = (await readRecipe(name))!;
		const original = await compileRequest(JSON.stringify(project));
		expect(original.report.ok).toBe(true);
		const copy = await compileSnapshot(snapshot(db, [addRecipe(db, name, project)]));
		expect(copy.report.errors).toBeUndefined();
		expect(Buffer.from(copy.image).equals(Buffer.from(original.image))).toBe(true);
	});

	it('does nothing the second time, so an edit to a copy survives', async () => {
		const { name } = RECIPES[0];
		const project = (await readRecipe(name))!;
		const id = addRecipe(db, name, project);
		const patch = listPatches(db)[0];
		savePatch(db, patch.id, patch.revision, 'Mine now', EMPTY_GRAPH);
		expect(addRecipe(db, name, project)).toBe(id);
		expect(getPatch(db, patch.id).name).toBe('Mine now');
	});

	it('restores a timeline that was deleted without touching the patches that stayed', async () => {
		const { name } = RECIPES[0];
		const project = (await readRecipe(name))!;
		addRecipe(db, name, project);
		const patch = listPatches(db)[0];
		savePatch(db, patch.id, patch.revision, 'Mine now', EMPTY_GRAPH);
		deleteTimeline(db, recipeTimelineId(name));
		expect(recipeInLibrary(db, name)).toBe(false);
		addRecipe(db, name, project);
		expect(recipeInLibrary(db, name)).toBe(true);
		expect(listTimelines(db).map((t) => t.id)).toEqual([recipeTimelineId(name)]);
		expect(getPatch(db, patch.id).name).toBe('Mine now');
	});

	it('keeps two recipes from colliding, though both call their patch p', async () => {
		for (const { name } of RECIPES.slice(0, 2)) addRecipe(db, name, (await readRecipe(name))!);
		expect(listTimelines(db)).toHaveLength(2);
	});
});
