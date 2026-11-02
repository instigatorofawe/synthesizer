// Every read and write the actions need. better-sqlite3 is synchronous, so a transaction here is one uninterrupted unit.
import { randomUUID } from 'node:crypto';
import { asc, desc, eq, inArray, and } from 'drizzle-orm';
import type { Db } from '#lib/server/Db.ts';
import {
	assets,
	bundleTimelines,
	bundles,
	patchAssets,
	patches,
	patchSubpatches,
	timelinePatches,
	timelines
} from '#lib/server/Tables.ts';
import { referencedAssets, referencedPatches, referencedSubpatches, type Graph, type Timeline } from '#lib/Schema.ts';
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

// A patch and every patch it expands, however deep. A graph can name itself, which the compiler refuses, so this keeps
// track of what it has seen rather than trusting the links to end.
export function withSubpatches(db: Db, ids: string[]): string[] {
	const seen = new Set(ids);
	let frontier = ids;
	while (frontier.length) {
		const next = db
			.select({ id: patchSubpatches.subpatchId })
			.from(patchSubpatches)
			.where(inArray(patchSubpatches.patchId, frontier))
			.all()
			.map((row) => row.id)
			.filter((id) => !seen.has(id));
		for (const id of next) seen.add(id);
		frontier = [...new Set(next)];
	}
	return [...seen].sort();
}

// A patch and every patch that expands it, however deep.
function withParents(db: Db, id: string): string[] {
	const seen = new Set([id]);
	let frontier = [id];
	while (frontier.length) {
		const next = db
			.select({ id: patchSubpatches.patchId })
			.from(patchSubpatches)
			.where(inArray(patchSubpatches.subpatchId, frontier))
			.all()
			.map((row) => row.id)
			.filter((other) => !seen.has(other));
		for (const other of next) seen.add(other);
		frontier = [...new Set(next)];
	}
	return [...seen];
}

// Every timeline an edit to this patch changes, including those that reach it through another patch.
export function patchUsers(db: Db, id: string) {
	return db
		.selectDistinct({ id: timelines.id, name: timelines.name })
		.from(timelinePatches)
		.innerJoin(timelines, eq(timelinePatches.timelineId, timelines.id))
		.where(inArray(timelinePatches.patchId, withParents(db, id)))
		.orderBy(asc(timelines.name))
		.all();
}

// The patches that expand this one, for the delete guard.
function patchParents(db: Db, id: string) {
	return db
		.select({ id: patches.id, name: patches.name })
		.from(patchSubpatches)
		.innerJoin(patches, eq(patchSubpatches.patchId, patches.id))
		.where(eq(patchSubpatches.subpatchId, id))
		.orderBy(asc(patches.name))
		.all()
		.filter((parent) => parent.id !== id);
}

function linkAssets(db: Db, id: string, graph: Graph) {
	const wanted = referencedAssets(graph);
	if (wanted.length) {
		const known = new Set(
			db
				.select({ id: assets.id })
				.from(assets)
				.where(inArray(assets.id, wanted))
				.all()
				.map((a) => a.id)
		);
		const missing = wanted.filter((a) => !known.has(a));
		if (missing.length) throw new NotFound(`no asset ${missing.join(', ')}`);
	}
	db.delete(patchAssets).where(eq(patchAssets.patchId, id)).run();
	if (wanted.length) {
		db.insert(patchAssets)
			.values(wanted.map((assetId) => ({ patchId: id, assetId })))
			.run();
	}
}

function linkSubpatches(db: Db, id: string, graph: Graph) {
	const wanted = referencedSubpatches(graph);
	if (wanted.length) {
		const known = new Set(
			db
				.select({ id: patches.id })
				.from(patches)
				.where(inArray(patches.id, wanted))
				.all()
				.map((p) => p.id)
		);
		const missing = wanted.filter((p) => !known.has(p));
		if (missing.length) throw new NotFound(`no patch ${missing.join(', ')}`);
	}
	db.delete(patchSubpatches).where(eq(patchSubpatches.patchId, id)).run();
	if (wanted.length) {
		db.insert(patchSubpatches)
			.values(wanted.map((subpatchId) => ({ patchId: id, subpatchId })))
			.run();
	}
}

export function createPatch(db: Db, name: string, graph: Graph, id: string = randomUUID()) {
	return db.transaction((tx) => {
		tx.insert(patches).values({ id, name, graph }).run();
		linkAssets(tx as unknown as Db, id, graph);
		linkSubpatches(tx as unknown as Db, id, graph);
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
		linkSubpatches(tx as unknown as Db, id, graph);
		return revision + 1;
	});
}

export function deletePatch(db: Db, id: string) {
	const users = [...patchParents(db, id), ...patchUsers(db, id)];
	if (users.length) throw new InUse(`used by ${users.map((u) => u.name).join(', ')}`);
	db.transaction((tx) => {
		// A link from a patch to itself would otherwise hold it in place.
		tx.delete(patchSubpatches).where(eq(patchSubpatches.patchId, id)).run();
		tx.delete(patches).where(eq(patches.id, id)).run();
	});
}

export function listTimelines(db: Db) {
	return db
		.select({ id: timelines.id, name: timelines.name, revision: timelines.revision })
		.from(timelines)
		.orderBy(asc(timelines.name))
		.all();
}

// The timeline saved last, which is the one a fresh visit opens.
export function latestTimeline(db: Db): string | null {
	return (
		db
			.select({ id: timelines.id })
			.from(timelines)
			.orderBy(desc(timelines.updatedAt), asc(timelines.name))
			.limit(1)
			.get()?.id ?? null
	);
}

export interface Edits {
	patches: { id: string; revision: number; name: string; graph: Graph }[];
	timelines: { id: string; revision: number; name: string; doc: Timeline }[];
}

// Every unsaved document at once, in one transaction, so a timeline is never saved against a patch edit that was refused.
// Patches go first, because a timeline's links are checked against them. Returns each document's new revision.
export function saveEdits(db: Db, edits: Edits): Record<string, number> {
	return db.transaction((tx) => {
		const t = tx as unknown as Db;
		const revisions: Record<string, number> = {};
		for (const { id, revision, name, graph } of edits.patches)
			revisions[`patch:${id}`] = savePatch(t, id, revision, name, graph);
		for (const { id, revision, name, doc } of edits.timelines) {
			revisions[`timeline:${id}`] = saveTimeline(t, id, revision, name, doc);
		}
		return revisions;
	});
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
			db
				.select({ id: patches.id })
				.from(patches)
				.where(inArray(patches.id, wanted))
				.all()
				.map((p) => p.id)
		);
		const missing = wanted.filter((p) => !known.has(p));
		if (missing.length) throw new NotFound(`no patch ${missing.join(', ')}`);
	}
	db.delete(timelinePatches).where(eq(timelinePatches.timelineId, id)).run();
	if (wanted.length) {
		db.insert(timelinePatches)
			.values(wanted.map((patchId) => ({ timelineId: id, patchId })))
			.run();
	}
}

export function createTimeline(db: Db, name: string, doc: Timeline, id: string = randomUUID()) {
	return db.transaction((tx) => {
		// To the millisecond, as a save stamps it, so the one made last is the one a fresh visit opens.
		tx.insert(timelines).values({ id, name, doc, updatedAt: new Date() }).run();
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
	const rows = db
		.select({
			id: assets.id,
			name: assets.name,
			channels: assets.channels,
			rate: assets.rate,
			frames: assets.frames,
			encoding: assets.encoding
		})
		.from(assets)
		.orderBy(asc(assets.name))
		.all();
	const uses = db.select({ assetId: patchAssets.assetId }).from(patchAssets).all();
	return rows.map((row) => ({ ...row, patches: uses.filter((use) => use.assetId === row.id).length }));
}

export function deleteAsset(db: Db, id: string) {
	const users = db
		.select({ name: patches.name })
		.from(patchAssets)
		.innerJoin(patches, eq(patchAssets.patchId, patches.id))
		.where(eq(patchAssets.assetId, id))
		.orderBy(asc(patches.name))
		.all();
	if (users.length) throw new InUse(`used by ${users.map((u) => u.name).join(', ')}`);
	db.delete(assets).where(eq(assets.id, id)).run();
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

// Every bundle with its timelines in order, which is all the bundle dialog needs.
export function bundlesWithMembers(db: Db) {
	const members = db.select().from(bundleTimelines).orderBy(asc(bundleTimelines.position)).all();
	return listBundles(db).map(({ id, name, revision }) => ({
		id,
		name,
		revision,
		timelines: members.filter((m) => m.bundleId === id).map((m) => m.timelineId)
	}));
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
		const wanted = withSubpatches(t, [...new Set(programs.flatMap((p) => referencedPatches(p.timeline)))]);
		const entries = wanted.length
			? t.select().from(patches).where(inArray(patches.id, wanted)).orderBy(asc(patches.id)).all().map(patchEntry)
			: [];
		return { patches: entries, assets: assetsFor(t, wanted), programs };
	});
}
