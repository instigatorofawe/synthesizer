// The editor is one page now, and these addresses open it on what they used to show.
import { error, redirect } from '@sveltejs/kit';
import { RECIPES } from '#lib/server/Recipes.ts';

export const GET = ({ params }) => {
	if (!RECIPES.some((recipe) => recipe.name === params.name)) error(404, `no recipe ${params.name}`);
	redirect(308, `/?recipe=${encodeURIComponent(params.name)}`);
};
