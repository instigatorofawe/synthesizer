import { sql } from 'drizzle-orm';
import { blob, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const timestamps = {
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
		.notNull()
		.default(sql`(unixepoch() * 1000)`)
};

// Global: every timeline can use every patch. A built-in patch is one of the examples' own, kept as it ships: the server writes
// it from examples/ at startup and refuses any other change to it.
export const patches = sqliteTable('patches', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	graph: text('graph', { mode: 'json' }).notNull(),
	revision: integer('revision').notNull().default(1),
	builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
	...timestamps
});

export const timelines = sqliteTable('timelines', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	doc: text('doc', { mode: 'json' }).notNull(),
	revision: integer('revision').notNull().default(1),
	...timestamps
});

// Derived from the document on every save. It backs the delete guard and "used by", and never decides what compiles.
export const timelinePatches = sqliteTable(
	'timeline_patches',
	{
		timelineId: text('timeline_id')
			.notNull()
			.references(() => timelines.id, { onDelete: 'cascade' }),
		patchId: text('patch_id')
			.notNull()
			.references(() => patches.id, { onDelete: 'restrict' })
	},
	(t) => [primaryKey({ columns: [t.timelineId, t.patchId] })]
);

// Which patches a patch expands as subpatches, derived from its graph on every save. Like timeline_patches it backs the
// delete guard and "used by", and it also says what an export has to carry along.
export const patchSubpatches = sqliteTable(
	'patch_subpatches',
	{
		patchId: text('patch_id')
			.notNull()
			.references(() => patches.id, { onDelete: 'cascade' }),
		subpatchId: text('subpatch_id')
			.notNull()
			.references(() => patches.id, { onDelete: 'restrict' })
	},
	(t) => [primaryKey({ columns: [t.patchId, t.subpatchId] })]
);

export const assets = sqliteTable('assets', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	encoding: text('encoding').notNull(),
	channels: integer('channels').notNull(),
	rate: integer('rate').notNull(),
	frames: integer('frames').notNull(),
	rootKey: integer('root_key').notNull().default(60),
	loopStart: integer('loop_start').notNull().default(0),
	loopEnd: integer('loop_end').notNull().default(0),
	bytes: blob('bytes', { mode: 'buffer' }).notNull(),
	builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false), // A built-in patch's recording, as it ships
	...timestamps
});

export const patchAssets = sqliteTable(
	'patch_assets',
	{
		patchId: text('patch_id')
			.notNull()
			.references(() => patches.id, { onDelete: 'cascade' }),
		assetId: text('asset_id')
			.notNull()
			.references(() => assets.id, { onDelete: 'restrict' })
	},
	(t) => [primaryKey({ columns: [t.patchId, t.assetId] })]
);

// A set of Programs compiled together, with one shared set of patches.
export const bundles = sqliteTable('bundles', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	revision: integer('revision').notNull().default(1),
	...timestamps
});

export const bundleTimelines = sqliteTable(
	'bundle_timelines',
	{
		bundleId: text('bundle_id')
			.notNull()
			.references(() => bundles.id, { onDelete: 'cascade' }),
		timelineId: text('timeline_id')
			.notNull()
			.references(() => timelines.id, { onDelete: 'restrict' }),
		position: integer('position').notNull()
	},
	(t) => [primaryKey({ columns: [t.bundleId, t.timelineId] })]
);
