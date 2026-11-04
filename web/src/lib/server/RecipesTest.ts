import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GM } from '#lib/GeneralMidi.ts';
import { GROUPS, inSet, readRecipe, RECIPES } from '#lib/server/Recipes.ts';

describe('the recipe catalogue', () => {
	it('lists every file in examples/Recipes, examples/Pieces and examples/Instruments', () => {
		const files = ['Recipes', 'Pieces', 'Instruments'].flatMap((folder) =>
			readdirSync(new URL(`../../../../examples/${folder}`, import.meta.url)).filter(
				(f) => f.endsWith('.json') && f !== 'Index.json' && f !== 'GeneralMidi.json'
			)
		);
		expect(RECIPES.map((recipe) => recipe.file).sort()).toEqual(files.sort());
	});

	it('names each example once, since the copies in a library are named after it', () => {
		expect(new Set(RECIPES.map((recipe) => recipe.name)).size).toBe(RECIPES.length);
	});

	it("shows the pieces first, then the standard set's, and then the recipes by group", () => {
		expect(GROUPS[0]).toBe('pieces');
		const set = RECIPES.some(inSet) ? 2 : 1;
		if (set === 2) expect(GROUPS[1]).toBe('instruments');
		expect(GROUPS.slice(set)).toEqual([...GROUPS.slice(set)].sort());
	});

	it("has the standard set's examples, each of a family, in General MIDI's order and then the kit and the effects", () => {
		const families = [...new Set(GM.programs.map((program) => program.family)), 'Drum kit', 'Effects'];
		const set = RECIPES.filter(inSet);
		for (const entry of set) expect([entry.group, families.includes(entry.family!)]).toEqual(['instruments', true]);
		const order = set.map((entry) => families.indexOf(entry.family!));
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(new Set(order).size).toBe(order.length);
		expect(RECIPES.filter((entry) => !inSet(entry)).every((entry) => entry.family === undefined)).toBe(true);
	});

	it('finds a recipe by name and nothing else', async () => {
		expect((await readRecipe(RECIPES[0].name))?.programs).toHaveLength(1);
		for (const entry of RECIPES.filter(inSet))
			expect((await readRecipe(entry.name))?.programs, entry.name).toHaveLength(1);
		expect(await readRecipe('Nothing')).toBeNull();
		expect(await readRecipe('../Demo')).toBeNull();
	});
});
