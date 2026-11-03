import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { guarded } from '#lib/Actions.ts';
import { isError, parseDocument, toBase64 } from '#lib/Form.ts';
import { compileSnapshot } from '#lib/server/Compile.ts';
import { db } from '#lib/server/Db.ts';
import { importInstrument, ImportError, type Upload } from '#lib/server/Import.ts';
import { addRecipe, readCatalogue } from '#lib/server/Builtins.ts';
import { readRecipe, recipeInLibrary, recipeTimelineId, RECIPES } from '#lib/server/Recipes.ts';
import {
	createBundle,
	createPatch,
	createTimeline,
	deleteAsset,
	deleteBundle,
	deletePatch,
	deleteTimeline,
	duplicatePatch,
	getBundle,
	getTimeline,
	latestTimeline,
	NotFound,
	saveBundle,
	saveEdits,
	snapshot,
	type Edits
} from '#lib/server/Repository.ts';
import { EMPTY_GRAPH, graphSchema, timelineSchema } from '#lib/Schema.ts';
import { NEW_TIMELINE } from '#lib/Template.ts';

// The address says what is open: `timeline` or `recipe` in the lower panel, and `patch` or `part` above it. Only the first two
// need anything from here, and a load reruns only for the parameters it reads, so choosing a patch costs no round trip.
export const load = async ({ url }) => {
	const recipe = url.searchParams.get('recipe');
	if (recipe !== null) {
		const entry = RECIPES.find((candidate) => candidate.name === recipe);
		const project = entry ? await readRecipe(recipe) : null;
		if (!entry || !project) error(404, `no recipe ${recipe}`);
		return {
			open: {
				kind: 'recipe' as const,
				entry,
				project,
				// The same documents with their defaults filled in, for the editors to draw. What plays is `project`, as it ships.
				patches: Object.entries(project.patches).map(([id, patch]) => ({
					id,
					name: patch.name || id,
					graph: graphSchema.parse(patch.graph)
				})),
				timeline: timelineSchema.parse(project.programs[0].timeline),
				assets: Object.keys(project.assets ?? {}).map((id) => ({ id, name: id })),
				builtins: (await readCatalogue()).parts[recipe] ?? {}, // Each patch's built-in id, which Duplicate copies
				inLibrary: recipeInLibrary(db(), recipe) ? recipeTimelineId(recipe) : null
			}
		};
	}
	const id = url.searchParams.get('timeline');
	if (id === null) {
		const latest = latestTimeline(db());
		if (latest === null) return { open: null };
		const next = new URL(url);
		next.searchParams.set('timeline', latest);
		redirect(307, `/${next.search}`);
	}
	try {
		const timeline = getTimeline(db(), id);
		return {
			open: {
				kind: 'timeline' as const,
				id: timeline.id,
				name: timeline.name,
				revision: timeline.revision,
				doc: timeline.doc // As saved, for the JSON view. The page fills in defaults to draw it.
			}
		};
	} catch (e) {
		if (e instanceof NotFound) error(404, e.message);
		throw e;
	}
};

// Where to go after an action: the address the form was sent from, with some parameters changed.
function back(form: FormData, change: Record<string, string | null>) {
	const params = new URLSearchParams(String(form.get('back') ?? ''));
	for (const [key, value] of Object.entries(change)) {
		if (value === null) params.delete(key);
		else params.set(key, value);
	}
	const search = params.toString();
	return search ? `/?${search}` : '/';
}

const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

const editsSchema = z.array(
	z.object({
		kind: z.enum(['patch', 'timeline']),
		id: z.string(),
		revision: z.number().int(),
		name: z.string(),
		text: z.string()
	})
);

export const actions = {
	// Every unsaved document in one go, which is what a project's Save means in a DAW.
	save: async ({ request }) => {
		const form = await request.formData();
		let list: z.infer<typeof editsSchema>;
		try {
			list = editsSchema.parse(JSON.parse(String(form.get('edits') ?? '[]')));
		} catch {
			return fail(400, { message: 'nothing to save' });
		}
		const edits: Edits = { patches: [], timelines: [] };
		for (const { kind, id, revision, name, text } of list) {
			const what = `${kind} ${name || id}`;
			if (!name.trim()) return fail(400, { message: `the ${what} needs a name` });
			if (kind === 'patch') {
				const graph = parseDocument(graphSchema, text);
				if (isError(graph)) return fail(400, { message: `${what}: ${graph.error}` });
				edits.patches.push({ id, revision, name: name.trim(), graph });
			} else {
				const doc = parseDocument(timelineSchema, text);
				if (isError(doc)) return fail(400, { message: `${what}: ${doc.error}` });
				edits.timelines.push({ id, revision, name: name.trim(), doc });
			}
		}
		return guarded(() => ({ revisions: saveEdits(db(), edits), saved: true }));
	},
	// A new patch starts as a sine with an envelope, which sounds at once. The browser's form says where it was sent from, and
	// goes back there with the patch open. A track's New patch sends no `back`: it gets the id, to put the patch on the track
	// before opening it.
	createPatch: async ({ request }) => {
		const form = await request.formData();
		const name = field(form, 'name');
		if (!name) return fail(400, { message: 'a patch needs a name' });
		const id = createPatch(db(), name, EMPTY_GRAPH);
		if (form.has('back')) redirect(303, back(form, { patch: id, part: null }));
		return { created: id };
	},
	// A new timeline starts from the template, a track with a patch and an empty clip, so that it makes a sound at once.
	createTimeline: async ({ request }) => {
		const form = await request.formData();
		const name = field(form, 'name');
		if (!name) return fail(400, { message: 'a timeline needs a name' });
		redirect(303, back(form, { timeline: createTimeline(db(), name, NEW_TIMELINE), recipe: null, part: null }));
	},
	createBundle: async ({ request }) => {
		const form = await request.formData();
		const name = field(form, 'name');
		if (!name) return fail(400, { message: 'a bundle needs a name' });
		redirect(303, back(form, { bundle: createBundle(db(), name) }));
	},
	importSamples: async ({ request }) => {
		const form = await request.formData();
		const files = form.getAll('files').filter((file): file is File => file instanceof File && file.size > 0);
		if (!files.length) return fail(400, { message: 'choose one or more WAV files' });
		const name = field(form, 'name') || files[0].name.replace(/\.[^.]*$/, '');
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
		redirect(303, back(form, { patch, part: null }));
	},
	deleteAsset: async ({ request }) => {
		const id = field(await request.formData(), 'id');
		return guarded(() => {
			deleteAsset(db(), id);
		});
	},
	// An ordinary copy of any patch, which is how a built-in one is changed. The page opens it, and puts a built-in one's copy in
	// its place in the timeline open below.
	duplicatePatch: async ({ request }) => {
		const id = field(await request.formData(), 'id');
		return guarded(() => ({ duplicated: { from: id, to: duplicatePatch(db(), id) } }));
	},
	deletePatch: async ({ request }) => {
		const form = await request.formData();
		const result = guarded(() => {
			deletePatch(db(), field(form, 'id'));
		});
		if (result) return result;
		redirect(303, back(form, { patch: null }));
	},
	// Opens whichever timeline was saved last instead.
	deleteTimeline: async ({ request }) => {
		const form = await request.formData();
		const result = guarded(() => {
			deleteTimeline(db(), field(form, 'id'));
		});
		if (result) return result;
		redirect(303, back(form, { timeline: null }));
	},
	// Compiles what is saved, not what is on screen, from one database snapshot.
	exportTimeline: async ({ request }) => {
		const id = field(await request.formData(), 'id');
		const { report, image } = await compileSnapshot(snapshot(db(), [id]));
		if (!report.ok) return fail(422, { message: report.errors?.[0]?.message ?? 'compile failed' });
		return { exported: { image: toBase64(image), report, name: report.programs[0]?.name ?? id } };
	},
	addRecipe: async ({ request }) => {
		const name = field(await request.formData(), 'name');
		const project = await readRecipe(name);
		if (!project) return fail(404, { message: `no recipe ${name}` });
		const catalogue = await readCatalogue();
		let id = '';
		const result = guarded(() => {
			id = addRecipe(db(), name, project, catalogue);
		});
		if (result) return result;
		redirect(303, `/?timeline=${encodeURIComponent(id)}`);
	},
	saveBundle: async ({ request }) => {
		const form = await request.formData();
		const name = field(form, 'name');
		if (!name) return fail(400, { message: 'a bundle needs a name' });
		const members = form.getAll('timeline').map(String);
		return guarded(() => ({
			bundleRevision: saveBundle(db(), field(form, 'id'), Number(form.get('revision')), name, members),
			saved: true
		}));
	},
	deleteBundle: async ({ request }) => {
		const form = await request.formData();
		deleteBundle(db(), field(form, 'id'));
		redirect(303, back(form, { bundle: null }));
	},
	// One snapshot, so a patch cannot change between two Programs. A thin image is for a receiver that already holds the
	// patches: they stay in the manifest and their bytes are left out.
	exportBundle: async ({ request }) => {
		const form = await request.formData();
		const thin = form.get('thin') === 'on';
		const bundle = getBundle(db(), field(form, 'id'));
		const members = bundle.timelines.map((t) => t.id);
		if (members.length === 0) return fail(400, { message: 'add a timeline first' });
		const rows = snapshot(db(), members);
		const full = await compileSnapshot(rows);
		if (!full.report.ok) return fail(422, { message: full.report.errors?.[0]?.message ?? 'compile failed' });
		if (!thin) return { exported: { image: toBase64(full.image), report: full.report, name: bundle.name } };
		const omit = full.report.chunks.filter((c) => c.kind !== 'program').map((c) => c.hash);
		const slim = await compileSnapshot(rows, { omit });
		return { exported: { image: toBase64(slim.image), report: slim.report, name: bundle.name } };
	}
};
