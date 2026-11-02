// What the browser lists and every editor draws from. It reads no part of the address, so opening another timeline or patch
// doesn't send it again: the library holds the samples, which can run to megabytes.
import { nodeCatalog } from '#lib/server/Compile.ts';
import { db } from '#lib/server/Db.ts';
import { RECIPES } from '#lib/server/Recipes.ts';
import {
	allPatches,
	assetsFor,
	bundlesWithMembers,
	listAssets,
	listPatches,
	listTimelines,
	patchUsers
} from '#lib/server/Repository.ts';

export const load = async () => {
	const rows = new Map(listPatches(db()).map((row) => [row.id, row]));
	const patches = allPatches(db()).map((patch) => ({
		...patch,
		revision: rows.get(patch.id)?.revision ?? 0,
		users: patchUsers(db(), patch.id)
	}));
	const groups = [...new Set(RECIPES.map((recipe) => recipe.group))].sort();
	return {
		library: {
			patches,
			timelines: listTimelines(db()),
			samples: listAssets(db()),
			assets: assetsFor(
				db(),
				patches.map((patch) => patch.id)
			),
			bundles: bundlesWithMembers(db())
		},
		examples: groups.map((group) => ({
			name: group,
			recipes: RECIPES.filter((recipe) => recipe.group === group).map(({ name, listen_for }) => ({ name, listen_for }))
		})),
		catalog: await nodeCatalog()
	};
};
