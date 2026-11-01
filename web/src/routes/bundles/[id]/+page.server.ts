import { error, fail, redirect } from '@sveltejs/kit';
import { guarded } from '#lib/Actions.ts';
import { toBase64 } from '#lib/Form.ts';
import { compileSnapshot } from '#lib/server/Compile.ts';
import { db } from '#lib/server/Db.ts';
import {
	deleteBundle,
	getBundle,
	listTimelines,
	NotFound,
	saveBundle,
	snapshot
} from '#lib/server/Repository.ts';

export const load = ({ params }) => {
	try {
		const { id, name, revision, timelines } = getBundle(db(), params.id);
		return { bundle: { id, name, revision, timelines }, all: listTimelines(db()) };
	} catch (e) {
		if (e instanceof NotFound) error(404, e.message);
		throw e;
	}
};

export const actions = {
	save: async ({ params, request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { message: 'a bundle needs a name' });
		const members = form.getAll('timeline').map(String);
		return guarded(() => ({
			revision: saveBundle(db(), params.id, Number(form.get('revision')), name, members),
			saved: true
		}));
	},
	delete: ({ params }) => {
		deleteBundle(db(), params.id);
		redirect(303, '/');
	},
	// One snapshot, so a patch cannot change between two Programs. A thin image is for a receiver that already holds the
	// patches: they stay in the manifest and their bytes are left out.
	export: async ({ params, request }) => {
		const thin = (await request.formData()).get('thin') === 'on';
		const members = getBundle(db(), params.id).timelines.map((t) => t.id);
		if (members.length === 0) return fail(400, { message: 'add a timeline first' });
		const rows = snapshot(db(), members);
		const full = await compileSnapshot(rows);
		if (!full.report.ok) return fail(422, { message: full.report.errors?.[0]?.message ?? 'compile failed' });
		if (!thin) return { exported: { image: toBase64(full.image), report: full.report } };
		const omit = full.report.chunks.filter((c) => c.kind !== 'program').map((c) => c.hash);
		const slim = await compileSnapshot(rows, { omit });
		return { exported: { image: toBase64(slim.image), report: slim.report } };
	}
};
