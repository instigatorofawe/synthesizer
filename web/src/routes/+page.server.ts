import { fail, redirect } from '@sveltejs/kit';
import { db } from '#lib/server/Db.ts';
import {
	createBundle,
	createPatch,
	createTimeline,
	listBundles,
	listPatches,
	listTimelines
} from '#lib/server/Repository.ts';
import { EMPTY_GRAPH, EMPTY_TIMELINE } from '#lib/Schema.ts';

export const load = () => ({
	patches: listPatches(db()),
	timelines: listTimelines(db()),
	bundles: listBundles(db()).map(({ id, name }) => ({ id, name }))
});

const nameOf = async (request: Request) => String((await request.formData()).get('name') ?? '').trim();

export const actions = {
	createPatch: async ({ request }) => {
		const name = await nameOf(request);
		if (!name) return fail(400, { message: 'a patch needs a name' });
		redirect(303, `/patches/${createPatch(db(), name, EMPTY_GRAPH)}`);
	},
	createTimeline: async ({ request }) => {
		const name = await nameOf(request);
		if (!name) return fail(400, { message: 'a timeline needs a name' });
		redirect(303, `/timelines/${createTimeline(db(), name, EMPTY_TIMELINE)}`);
	},
	createBundle: async ({ request }) => {
		const name = await nameOf(request);
		if (!name) return fail(400, { message: 'a bundle needs a name' });
		redirect(303, `/bundles/${createBundle(db(), name)}`);
	}
};
