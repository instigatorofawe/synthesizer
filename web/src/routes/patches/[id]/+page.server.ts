import { error, fail, redirect } from '@sveltejs/kit';
import { guarded } from '#lib/Actions.ts';
import { isError, parseDocument } from '#lib/Form.ts';
import { nodeCatalog } from '#lib/server/Compile.ts';
import { db } from '#lib/server/Db.ts';
import { allPatches, assetsFor, deletePatch, getPatch, NotFound, patchUsers, savePatch } from '#lib/server/Repository.ts';
import { graphSchema } from '#lib/Schema.ts';

export const load = async ({ params }) => {
	try {
		const patch = getPatch(db(), params.id);
		// All of it, because an edit here can reach for any patch as a subpatch before anything is saved.
		const library = allPatches(db());
		return {
			patch: { id: patch.id, name: patch.name, graph: patch.graph, revision: patch.revision },
			users: patchUsers(db(), params.id),
			library,
			assets: assetsFor(db(), library.map((p) => p.id)),
			catalog: await nodeCatalog()
		};
	} catch (e) {
		if (e instanceof NotFound) error(404, e.message);
		throw e;
	}
};

export const actions = {
	save: async ({ params, request }) => {
		const form = await request.formData();
		const graph = parseDocument(graphSchema, form.get('graph'));
		if (isError(graph)) return fail(400, { message: graph.error });
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { message: 'a patch needs a name' });
		return guarded(() => ({
			revision: savePatch(db(), params.id, Number(form.get('revision')), name, graph),
			saved: true
		}));
	},
	delete: ({ params }) => {
		const result = guarded(() => {
			deletePatch(db(), params.id);
		});
		if (result) return result;
		redirect(303, '/');
	}
};
