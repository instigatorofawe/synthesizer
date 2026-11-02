import { error, redirect } from '@sveltejs/kit';
import { guarded } from '#lib/Actions.ts';
import { nodeCatalog } from '#lib/server/Compile.ts';
import { db } from '#lib/server/Db.ts';
import { addRecipe, readRecipe, recipeInLibrary, recipeTimelineId, RECIPES } from '#lib/server/Recipes.ts';
import { graphSchema, timelineSchema } from '#lib/Schema.ts';

async function found(name: string) {
	const entry = RECIPES.find((recipe) => recipe.name === name);
	const project = await readRecipe(name);
	if (!entry || !project) error(404, `no recipe ${name}`);
	return { entry, project };
}

export const load = async ({ params }) => {
	const { entry, project } = await found(params.name);
	return {
		entry,
		project,
		// The same documents with their defaults filled in, for the editors to draw. What plays is `project`, as it ships.
		patches: Object.entries(project.patches).map(([id, patch]) => ({
			id,
			name: patch.name || id,
			graph: graphSchema.parse(patch.graph)
		})),
		timeline: timelineSchema.parse(project.programs[0].timeline),
		assets: Object.entries(project.assets ?? {}).map(([id]) => ({ id, name: id })),
		catalog: await nodeCatalog(),
		inLibrary: recipeInLibrary(db(), params.name) ? recipeTimelineId(params.name) : null
	};
};

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
