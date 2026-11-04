import { resolve } from 'node:path';
import type { FullConfig } from '@playwright/test';
import Database from 'better-sqlite3';

// Runs once the server is up. A page answers only once the server has made its library (the demo songs and the built-in
// patches), so after this answer the library is as every test should find it, and Fixtures.ts copies it back before each.
export default async function globalSetup(config: FullConfig) {
	const url = config.projects[0].use.baseURL!;
	const response = await fetch(`${url}/?timeline=song`, { headers: { 'X-Forwarded-Proto': 'http' } });
	if (!response.ok) throw new Error(`the e2e server answered ${response.status}`);
	const source = new Database(resolve(import.meta.dirname, '../.e2e/Test.sqlite'), { readonly: true });
	await source.backup(resolve(import.meta.dirname, '../.e2e/Template.sqlite')); // Fixtures.ts's template
	source.close();
}
