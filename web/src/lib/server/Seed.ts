import demo from '../../../../examples/Demo.json';
import type { Db } from '#lib/server/Db.ts';
import { createAsset, createBundle, createPatch, createTimeline, listPatches } from '#lib/server/Repository.ts';
import { graphSchema, timelineSchema } from '#lib/Schema.ts';

// Fills an empty database with the project every target renders in CI, so the app opens onto something that plays. Built-in
// patches don't count, since every library has them.
export function seedDemo(db: Db) {
	if (listPatches(db).some((patch) => !patch.builtin)) return;
	for (const [id, asset] of Object.entries(demo.assets)) createAsset(db, { id, ...asset });
	for (const [id, patch] of Object.entries(demo.patches)) {
		createPatch(db, patch.name, graphSchema.parse(patch.graph), id);
	}
	for (const program of demo.programs) {
		createTimeline(db, program.name, timelineSchema.parse(program.timeline), program.id);
	}
	createBundle(
		db,
		'Demo set',
		demo.programs.map((p) => p.id),
		'demo-set'
	);
}
