import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '#lib/server/Db.ts';
import {
	Conflict,
	createAsset,
	createBundle,
	createPatch,
	createTimeline,
	deleteBundle,
	deletePatch,
	deleteTimeline,
	getBundle,
	getTimeline,
	InUse,
	listPatches,
	NotFound,
	patchUsers,
	saveBundle,
	savePatch,
	saveTimeline,
	snapshot
} from '#lib/server/Repository.ts';
import { seedDemo } from '#lib/server/Seed.ts';
import { compileSnapshot } from '#lib/server/Compile.ts';
import { EMPTY_GRAPH, timelineSchema, type Timeline } from '#lib/Schema.ts';

const timeline = (slots: string[]): Timeline =>
	timelineSchema.parse({
		clips: [{ id: 'c', length: 480, notes: [{ tick: 0, note: 60, dur: 100 }] }],
		tracks: [{ id: 1, slots, placements: [{ clip: 'c', tick: 0 }] }]
	});

let db: Db;

beforeEach(() => {
	db = openDatabase(':memory:');
});

describe('patches are global', () => {
	it('lets any timeline use one patch', () => {
		const patch = createPatch(db, 'Shared', EMPTY_GRAPH);
		createTimeline(db, 'One', timeline([patch]));
		createTimeline(db, 'Two', timeline([patch]));
		expect(patchUsers(db, patch).map((t) => t.name)).toEqual(['One', 'Two']);
		expect(listPatches(db)[0].timelines).toBe(2);
	});

	it('refuses to delete a patch in use, and allows it afterwards', () => {
		const patch = createPatch(db, 'Shared', EMPTY_GRAPH);
		const t = createTimeline(db, 'One', timeline([patch]));
		expect(() => deletePatch(db, patch)).toThrow(InUse);
		deleteTimeline(db, t);
		deletePatch(db, patch);
		expect(listPatches(db)).toEqual([]);
	});

	it('refuses a timeline naming a patch that does not exist, and saves nothing', () => {
		expect(() => createTimeline(db, 'Bad', timeline(['gone']))).toThrow(NotFound);
		expect(() => getTimeline(db, 'gone')).toThrow(NotFound);
	});

	it('keeps the use list in step with every save', () => {
		const a = createPatch(db, 'A', EMPTY_GRAPH);
		const b = createPatch(db, 'B', EMPTY_GRAPH);
		const t = createTimeline(db, 'One', timeline([a]));
		saveTimeline(db, t, 1, 'One', timeline([b]));
		expect(patchUsers(db, a)).toEqual([]);
		expect(patchUsers(db, b).map((u) => u.name)).toEqual(['One']);
	});

	it('counts inserts on tracks, buses and the master as uses', () => {
		const p = createPatch(db, 'FX', EMPTY_GRAPH);
		const doc = timelineSchema.parse({ buses: [{ id: 'b', inserts: [{ patch: p }] }] });
		createTimeline(db, 'One', doc);
		expect(() => deletePatch(db, p)).toThrow(InUse);
	});
});

describe('revisions', () => {
	it('refuses a stale save rather than overwriting another tab', () => {
		const p = createPatch(db, 'P', EMPTY_GRAPH);
		expect(savePatch(db, p, 1, 'First tab', EMPTY_GRAPH)).toBe(2);
		expect(() => savePatch(db, p, 1, 'Second tab', EMPTY_GRAPH)).toThrow(Conflict);
		expect(listPatches(db)[0].name).toBe('First tab');
	});

	it('leaves the use list alone when a save is refused', () => {
		const a = createPatch(db, 'A', EMPTY_GRAPH);
		const b = createPatch(db, 'B', EMPTY_GRAPH);
		const t = createTimeline(db, 'One', timeline([a]));
		expect(() => saveTimeline(db, t, 9, 'One', timeline([b]))).toThrow(Conflict);
		expect(patchUsers(db, a).length).toBe(1);
	});
});

describe('assets', () => {
	const asset = {
		id: 'a',
		name: 'A',
		encoding: 'i16',
		channels: 1,
		rate: 24000,
		frames: 2,
		root_key: 60,
		loop_start: 0,
		loop_end: 0,
		data: Buffer.from(new Int16Array([1, 2]).buffer).toString('base64')
	};
	const graph = {
		...EMPTY_GRAPH,
		nodes: [...EMPTY_GRAPH.nodes.filter((n) => n.type !== 'osc'), { id: 3, type: 'sample' as const, asset: 'a' }]
	};

	it('refuses a patch naming an unknown asset', () => {
		expect(() => createPatch(db, 'P', graph)).toThrow(NotFound);
		expect(listPatches(db)).toEqual([]);
	});

	it('includes only the assets the chosen patches need', () => {
		createAsset(db, asset);
		createAsset(db, { ...asset, id: 'unused' });
		const p = createPatch(db, 'P', graph);
		const t = createTimeline(db, 'One', timeline([p]));
		expect(snapshot(db, [t]).assets.map((a) => a.id)).toEqual(['a']);
	});
});

describe('bundles', () => {
	it('keeps the order Programs were chosen in', () => {
		const p = createPatch(db, 'P', EMPTY_GRAPH);
		const a = createTimeline(db, 'A', timeline([p]));
		const b = createTimeline(db, 'B', timeline([p]));
		const bundle = createBundle(db, 'Set', [b, a]);
		expect(getBundle(db, bundle).timelines.map((t) => t.name)).toEqual(['B', 'A']);
		saveBundle(db, bundle, 1, 'Set', [a, b]);
		expect(getBundle(db, bundle).timelines.map((t) => t.name)).toEqual(['A', 'B']);
	});

	it('protects a timeline in a bundle until the bundle lets go', () => {
		const p = createPatch(db, 'P', EMPTY_GRAPH);
		const t = createTimeline(db, 'A', timeline([p]));
		const bundle = createBundle(db, 'Set', [t]);
		expect(() => deleteTimeline(db, t)).toThrow(InUse);
		deleteBundle(db, bundle);
		deleteTimeline(db, t);
	});
});

describe('exports from saved rows', () => {
	beforeEach(() => seedDemo(db));

	it('seeds the demo once', () => {
		seedDemo(db);
		expect(listPatches(db).length).toBe(5);
	});

	it('compiles only the patches a timeline reaches', async () => {
		const { report, image } = await compileSnapshot(snapshot(db, ['ballad']));
		expect(report.ok).toBe(true);
		expect(image.length).toBeGreaterThan(0);
		expect(report.programs[0].patches.map((p) => p.id).sort()).toEqual(['lead', 'reverb']);
		expect(report.chunks.filter((c) => c.kind === 'patch').length).toBe(2);
	});

	it('shares patches across a bundle, each once', async () => {
		const { report } = await compileSnapshot(snapshot(db, ['song', 'ballad']));
		expect(report.programs.length).toBe(2);
		expect(report.chunks.filter((c) => c.kind === 'patch').length).toBe(4);
		expect(report.chunks.filter((c) => c.programs === 2).map((c) => c.kind).sort()).toEqual(['patch', 'patch']);
	});

	it('gives the same bytes for the same rows', async () => {
		const one = await compileSnapshot(snapshot(db, ['song', 'ballad']));
		const two = await compileSnapshot(snapshot(db, ['song', 'ballad']));
		expect(Buffer.compare(one.image, two.image)).toBe(0);
	});

	it('reports a compile error as data', async () => {
		const p = createPatch(db, 'Broken', { ...EMPTY_GRAPH, nodes: [{ id: 1, type: 'note' }], edges: [] });
		const t = createTimeline(db, 'T', timeline([p]));
		const { report, image } = await compileSnapshot(snapshot(db, [t]));
		expect(report.ok).toBe(false);
		expect(report.errors?.[0].message).toContain('no out node');
		expect(image.length).toBe(0);
	});

	it('leaves patches out of a thin image but keeps them in the manifest', async () => {
		const full = await compileSnapshot(snapshot(db, ['song']));
		const omit = full.report.chunks.filter((c) => c.kind !== 'program').map((c) => c.hash);
		const thin = await compileSnapshot(snapshot(db, ['song']), { omit });
		expect(thin.image.length).toBeLessThan(full.image.length / 2);
		expect(thin.report.chunks.length).toBe(full.report.chunks.length);
		expect(thin.report.chunks.filter((c) => c.present).map((c) => c.kind)).toEqual(['program']);
	});
});
