import { error, fail, redirect } from '@sveltejs/kit';
import { guarded } from '#lib/Actions.ts';
import { isError, parseDocument } from '#lib/Form.ts';
import { db } from '#lib/server/Db.ts';
import { assetsFor, deletePatch, getPatch, NotFound, patchUsers, savePatch } from '#lib/server/Repository.ts';
import { graphSchema } from '#lib/Schema.ts';

export const load = ({ params }) => {
	try {
		const patch = getPatch(db(), params.id);
		return {
			patch: { id: patch.id, name: patch.name, graph: patch.graph, revision: patch.revision },
			users: patchUsers(db(), params.id),
			assets: assetsFor(db(), [params.id])
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
