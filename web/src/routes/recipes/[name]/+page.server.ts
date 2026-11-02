import { error, redirect } from '@sveltejs/kit';
import { guarded } from '#lib/Actions.ts';
import { db } from '#lib/server/Db.ts';
import { addRecipe, readRecipe, recipeInLibrary, recipeTimelineId, RECIPES } from '#lib/server/Recipes.ts';

async function found(name: string) {
	const entry = RECIPES.find((recipe) => recipe.name === name);
	const project = await readRecipe(name);
	if (!entry || !project) error(404, `no recipe ${name}`);
	return { entry, project };
}

export const load = async ({ params }) => ({
	...(await found(params.name)),
	timeline: recipeInLibrary(db(), params.name) ? recipeTimelineId(params.name) : null
});

export const actions = {
	add: async ({ params }) => {
		const { project } = await found(params.name);
		let id = '';
		const result = guarded(() => {
			id = addRecipe(db(), params.name, project);
		});
		if (result) return result;
		redirect(303, `/timelines/${id}`);
	}
};
