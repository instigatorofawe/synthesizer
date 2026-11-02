import { fail, redirect } from '@sveltejs/kit';
import { guarded } from '#lib/Actions.ts';
import { db } from '#lib/server/Db.ts';
import { importInstrument, ImportError, type Upload } from '#lib/server/Import.ts';
import {
	createBundle,
	createPatch,
	createTimeline,
	deleteAsset,
	listAssets,
	listBundles,
	listPatches,
	listTimelines
} from '#lib/server/Repository.ts';
import { EMPTY_GRAPH, EMPTY_TIMELINE } from '#lib/Schema.ts';

export const load = () => ({
	patches: listPatches(db()),
	timelines: listTimelines(db()),
	assets: listAssets(db()),
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
	},
	importSamples: async ({ request }) => {
		const form = await request.formData();
		const files = form.getAll('files').filter((file): file is File => file instanceof File && file.size > 0);
		if (!files.length) return fail(400, { message: 'choose one or more WAV files' });
		const name = String(form.get('name') ?? '').trim() || files[0].name.replace(/\.[^.]*$/, '');
		const uploads: Upload[] = await Promise.all(
			files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }))
		);
		let patch: string;
		try {
			patch = importInstrument(db(), name, uploads);
		} catch (e) {
			if (e instanceof ImportError) return fail(400, { message: e.message });
			throw e;
		}
		redirect(303, `/patches/${patch}`);
	},
	deleteAsset: async ({ request }) => {
		const id = String((await request.formData()).get('id') ?? '');
		return guarded(() => {
			deleteAsset(db(), id);
		});
	}
};
