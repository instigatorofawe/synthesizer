// What the browser lists and every editor draws from. It reads no part of the address, so opening another timeline or patch
// doesn't send it again: the library holds the samples, which can run to megabytes. A built-in patch's recordings come only
// once something uses it, and the page asks /assets for those of one it opens before then.
import { exampleGroups, readCatalogue } from '#lib/server/Builtins.ts';
import { nodeCatalog } from '#lib/server/Compile.ts';
import { db } from '#lib/server/Db.ts';
import {
	allPatches,
	bundlesWithMembers,
	libraryAssets,
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
		builtin: rows.get(patch.id)?.builtin ?? false,
		users: patchUsers(db(), patch.id)
	}));
	return {
		library: {
			patches,
			timelines: listTimelines(db()),
			samples: listAssets(db()),
			assets: libraryAssets(db()),
			bundles: bundlesWithMembers(db())
		},
		examples: exampleGroups(await readCatalogue()),
		catalog: await nodeCatalog()
	};
};
