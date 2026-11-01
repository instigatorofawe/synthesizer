// Every read and write the actions need. better-sqlite3 is synchronous, so a transaction here is one uninterrupted unit.
import { randomUUID } from 'node:crypto';
import { asc, eq, inArray, and } from 'drizzle-orm';
import type { Db } from '#lib/server/Db.ts';
import {
	assets,
	bundleTimelines,
	bundles,
	patchAssets,
	patches,
	timelinePatches,
	timelines
} from '#lib/server/Tables.ts';
import { referencedAssets, referencedPatches, type Graph, type Timeline } from '#lib/Schema.ts';
import type { AssetEntry, PatchEntry, ProgramEntry } from '#lib/Request.ts';

export class NotFound extends Error {}
export class Conflict extends Error {}
export class InUse extends Error {}

function assetEntry(row: typeof assets.$inferSelect): AssetEntry {
	return {
		id: row.id,
		name: row.name,
		encoding: row.encoding,
		channels: row.channels,
		rate: row.rate,
		frames: row.frames,
		root_key: row.rootKey,
		loop_start: row.loopStart,
		loop_end: row.loopEnd,
		data: Buffer.from(row.bytes).toString('base64')
	};
}

function patchEntry(row: typeof patches.$inferSelect): PatchEntry {
	return { id: row.id, name: row.name, graph: row.graph as Graph };
}

export function listPatches(db: Db) {
	const rows = db.select().from(patches).orderBy(asc(patches.name)).all();
	const uses = db.select().from(timelinePatches).all();
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		revision: row.revision,
		timelines: uses.filter((u) => u.patchId === row.id).length
	}));
}

export function getPatch(db: Db, id: string) {
	const row = db.select().from(patches).where(eq(patches.id, id)).get();
	if (!row) throw new NotFound(`no patch ${id}`);
	return row;
}

export function allPatches(db: Db): PatchEntry[] {
	return db.select().from(patches).orderBy(asc(patches.id)).all().map(patchEntry);
}

export function patchUsers(db: Db, id: string) {
	return db
		.select({ id: timelines.id, name: timelines.name })
		.from(timelinePatches)
		.innerJoin(timelines, eq(timelinePatches.timelineId, timelines.id))
		.where(eq(timelinePatches.patchId, id))
		.orderBy(asc(timelines.name))
		.all();
}

function linkAssets(db: Db, id: string, graph: Graph) {
	const wanted = referencedAssets(graph);
	if (wanted.length) {
		const known = new Set(
			db.select({ id: assets.id }).from(assets).where(inArray(assets.id, wanted)).all().map((a) => a.id)
		);
		const missing = wanted.filter((a) => !known.has(a));
		if (missing.length) throw new NotFound(`no asset ${missing.join(', ')}`);
	}
	db.delete(patchAssets).where(eq(patchAssets.patchId, id)).run();
	if (wanted.length) {
		db.insert(patchAssets).values(wanted.map((assetId) => ({ patchId: id, assetId }))).run();
	}
}

export function createPatch(db: Db, name: string, graph: Graph, id: string = randomUUID()) {
	return db.transaction((tx) => {
		tx.insert(patches).values({ id, name, graph }).run();
		linkAssets(tx as unknown as Db, id, graph);
		return id;
	});
}

export function savePatch(db: Db, id: string, revision: number, name: string, graph: Graph) {
	return db.transaction((tx) => {
		const result = tx
			.update(patches)
			.set({ name, graph, revision: revision + 1, updatedAt: new Date() })
			.where(and(eq(patches.id, id), eq(patches.revision, revision)))
			.run();
		if (result.changes === 0) throw new Conflict('this patch was changed elsewhere; reload before saving');
		linkAssets(tx as unknown as Db, id, graph);
		return revision + 1;
	});
}

export function deletePatch(db: Db, id: string) {
	const users = patchUsers(db, id);
	if (users.length) throw new InUse(`used by ${users.map((u) => u.name).join(', ')}`);
	db.delete(patches).where(eq(patches.id, id)).run();
}

export function listTimelines(db: Db) {
	return db
		.select({ id: timelines.id, name: timelines.name, revision: timelines.revision })
		.from(timelines)
		.orderBy(asc(timelines.name))
		.all();
}

export function getTimeline(db: Db, id: string) {
	const row = db.select().from(timelines).where(eq(timelines.id, id)).get();
	if (!row) throw new NotFound(`no timeline ${id}`);
	return row;
}

function linkPatches(db: Db, id: string, doc: Timeline) {
	const wanted = referencedPatches(doc);
	if (wanted.length) {
		const known = new Set(
			db.select({ id: patches.id }).from(patches).where(inArray(patches.id, wanted)).all().map((p) => p.id)
		);
		const missing = wanted.filter((p) => !known.has(p));
		if (missing.length) throw new NotFound(`no patch ${missing.join(', ')}`);
	}
	db.delete(timelinePatches).where(eq(timelinePatches.timelineId, id)).run();
	if (wanted.length) {
		db.insert(timelinePatches).values(wanted.map((patchId) => ({ timelineId: id, patchId }))).run();
	}
}

export function createTimeline(db: Db, name: string, doc: Timeline, id: string = randomUUID()) {
	return db.transaction((tx) => {
		tx.insert(timelines).values({ id, name, doc }).run();
		linkPatches(tx as unknown as Db, id, doc);
		return id;
	});
}

export function saveTimeline(db: Db, id: string, revision: number, name: string, doc: Timeline) {
	return db.transaction((tx) => {
		const result = tx
			.update(timelines)
			.set({ name, doc, revision: revision + 1, updatedAt: new Date() })
			.where(and(eq(timelines.id, id), eq(timelines.revision, revision)))
			.run();
		if (result.changes === 0) throw new Conflict('this timeline was changed elsewhere; reload before saving');
		linkPatches(tx as unknown as Db, id, doc);
		return revision + 1;
	});
}

export function deleteTimeline(db: Db, id: string) {
	const used = db
		.select({ name: bundles.name })
		.from(bundleTimelines)
		.innerJoin(bundles, eq(bundleTimelines.bundleId, bundles.id))
		.where(eq(bundleTimelines.timelineId, id))
		.all();
	if (used.length) throw new InUse(`in bundle ${used.map((b) => b.name).join(', ')}`);
	db.delete(timelines).where(eq(timelines.id, id)).run();
}

export function listAssets(db: Db) {
	return db.select({ id: assets.id, name: assets.name }).from(assets).orderBy(asc(assets.name)).all();
}

export function createAsset(db: Db, entry: AssetEntry) {
	db.insert(assets)
		.values({
			id: entry.id,
			name: entry.name,
			encoding: entry.encoding,
			channels: entry.channels,
			rate: entry.rate,
			frames: entry.frames,
			rootKey: entry.root_key,
			loopStart: entry.loop_start,
			loopEnd: entry.loop_end,
			bytes: Buffer.from(entry.data, 'base64')
		})
		.run();
}

// The assets a set of patches needs, and no others.
export function assetsFor(db: Db, patchIds: string[]): AssetEntry[] {
	if (patchIds.length === 0) return [];
	const links = db
		.selectDistinct({ assetId: patchAssets.assetId })
		.from(patchAssets)
		.where(inArray(patchAssets.patchId, patchIds))
		.all();
	if (links.length === 0) return [];
	return db
		.select()
		.from(assets)
		.where(
			inArray(
				assets.id,
				links.map((l) => l.assetId)
			)
		)
		.orderBy(asc(assets.id))
		.all()
		.map(assetEntry);
}

export function listBundles(db: Db) {
	return db.select().from(bundles).orderBy(asc(bundles.name)).all();
}

export function getBundle(db: Db, id: string) {
	const row = db.select().from(bundles).where(eq(bundles.id, id)).get();
	if (!row) throw new NotFound(`no bundle ${id}`);
	const members = db
		.select({ id: timelines.id, name: timelines.name })
		.from(bundleTimelines)
		.innerJoin(timelines, eq(bundleTimelines.timelineId, timelines.id))
		.where(eq(bundleTimelines.bundleId, id))
		.orderBy(asc(bundleTimelines.position))
		.all();
	return { ...row, timelines: members };
}

export function createBundle(db: Db, name: string, timelineIds: string[] = [], id: string = randomUUID()) {
	return db.transaction((tx) => {
		tx.insert(bundles).values({ id, name }).run();
		setMembers(tx as unknown as Db, id, timelineIds);
		return id;
	});
}

function setMembers(db: Db, id: string, timelineIds: string[]) {
	db.delete(bundleTimelines).where(eq(bundleTimelines.bundleId, id)).run();
	if (timelineIds.length) {
		db.insert(bundleTimelines)
			.values(timelineIds.map((timelineId, position) => ({ bundleId: id, timelineId, position })))
			.run();
	}
}

export function saveBundle(db: Db, id: string, revision: number, name: string, timelineIds: string[]) {
	return db.transaction((tx) => {
		const result = tx
			.update(bundles)
			.set({ name, revision: revision + 1, updatedAt: new Date() })
			.where(and(eq(bundles.id, id), eq(bundles.revision, revision)))
			.run();
		if (result.changes === 0) throw new Conflict('this bundle was changed elsewhere; reload before saving');
		setMembers(tx as unknown as Db, id, timelineIds);
		return revision + 1;
	});
}

export function deleteBundle(db: Db, id: string) {
	db.delete(bundles).where(eq(bundles.id, id)).run();
}

export interface Snapshot {
	patches: PatchEntry[];
	assets: AssetEntry[];
	programs: ProgramEntry[];
}

// Everything an export reads, in one transaction, so a patch cannot change partway through a bundle.
export function snapshot(db: Db, timelineIds: string[]): Snapshot {
	return db.transaction((tx) => {
		const t = tx as unknown as Db;
		const programs: ProgramEntry[] = timelineIds.map((id) => {
			const row = getTimeline(t, id);
			return { id: row.id, name: row.name, timeline: row.doc as Timeline };
		});
		const wanted = [...new Set(programs.flatMap((p) => referencedPatches(p.timeline)))].sort();
		const entries = wanted.length
			? t.select().from(patches).where(inArray(patches.id, wanted)).orderBy(asc(patches.id)).all().map(patchEntry)
			: [];
		return { patches: entries, assets: assetsFor(t, wanted), programs };
	});
}
