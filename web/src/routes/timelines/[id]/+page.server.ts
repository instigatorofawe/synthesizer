import { error, fail, redirect } from '@sveltejs/kit';
import { guarded } from '#lib/Actions.ts';
import { isError, parseDocument, toBase64 } from '#lib/Form.ts';
import { compileSnapshot } from '#lib/server/Compile.ts';
import { db } from '#lib/server/Db.ts';
import {
	allPatches,
	assetsFor,
	deleteTimeline,
	getTimeline,
	NotFound,
	saveTimeline,
	snapshot
} from '#lib/server/Repository.ts';
import { timelineSchema } from '#lib/Schema.ts';

export const load = ({ params }) => {
	try {
		const timeline = getTimeline(db(), params.id);
		const patches = allPatches(db());
		return {
			timeline: { id: timeline.id, name: timeline.name, doc: timeline.doc, revision: timeline.revision },
			patches,
			assets: assetsFor(db(), patches.map((p) => p.id))
		};
	} catch (e) {
		if (e instanceof NotFound) error(404, e.message);
		throw e;
	}
};

export const actions = {
	save: async ({ params, request }) => {
		const form = await request.formData();
		const doc = parseDocument(timelineSchema, form.get('doc'));
		if (isError(doc)) return fail(400, { message: doc.error });
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { message: 'a timeline needs a name' });
		return guarded(() => ({
			revision: saveTimeline(db(), params.id, Number(form.get('revision')), name, doc),
			saved: true
		}));
	},
	delete: ({ params }) => {
		const result = guarded(() => {
			deleteTimeline(db(), params.id);
		});
		if (result) return result;
		redirect(303, '/');
	},
	// Compiles what is saved, not what is on screen, from one database snapshot.
	export: async ({ params }) => {
		const { report, image } = await compileSnapshot(snapshot(db(), [params.id]));
		if (!report.ok) return fail(422, { message: report.errors?.[0]?.message ?? 'compile failed' });
		return { exported: { image: toBase64(image), report } };
	}
};
