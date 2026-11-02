import { RECIPES } from '#lib/server/Recipes.ts';

export const load = () => {
	const groups = [...new Set(RECIPES.map((recipe) => recipe.group))].sort();
	return { groups: groups.map((name) => ({ name, recipes: RECIPES.filter((recipe) => recipe.group === name) })) };
};
