import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readCatalogue, syncBuiltins } from '#lib/server/Builtins.ts';
import { seedDemo } from '#lib/server/Seed.ts';
import * as tables from '#lib/server/Tables.ts';

export type Db = BetterSQLite3Database<typeof tables>;

export function openDatabase(path: string): Db {
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
	const sqlite = new Database(path);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON'); // Off by default in SQLite, and the delete guards rest on it
	const db = drizzle(sqlite, { schema: tables });
	migrate(db, { migrationsFolder: resolve(process.env.MIGRATIONS_PATH ?? 'drizzle') });
	return db;
}

let database: Db | undefined;

export function db(): Db {
	database ??= openDatabase(process.env.DATABASE_PATH ?? 'data/Modsynth.sqlite');
	return database;
}

// The demo goes into a library with nothing of its own, and the built-in patches are made what ships, every time.
export async function prepareDatabase() {
	if (process.env.SEED_DEMO !== '0') seedDemo(db());
	const kept = syncBuiltins(db(), await readCatalogue());
	if (kept.length) console.warn(`kept built-ins that no longer ship, because something uses them: ${kept.join(', ')}`);
}
