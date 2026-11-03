import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GROUPS, readRecipe, RECIPES } from '#lib/server/Recipes.ts';

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
