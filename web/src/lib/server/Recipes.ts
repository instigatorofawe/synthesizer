// The recipes in examples/Recipes and the pieces in examples/Pieces, as a read-only catalogue. They play from here as they
// are. Their patches are in every library as built-in ones, which Builtins.ts writes from these files, and adding an example
// copies only its timeline.
import { eq } from 'drizzle-orm';
import pieces from '../../../../examples/Pieces/Index.json';
import recipes from '../../../../examples/Recipes/Index.json';
import type { Db } from '#lib/server/Db.ts';
import { timelines } from '#lib/server/Tables.ts';
import type { AssetEntry } from '#lib/Request.ts';

export interface RecipeEntry {
	name: string;
	file: string;
	seconds: number;
	group: string;
	listen_for: string;
}

export interface RecipeProject {
	patches: Record<string, { name: string; graph: unknown }>;
	assets?: Record<string, Omit<AssetEntry, 'id' | 'name' | 'loop_start' | 'loop_end'> & Partial<AssetEntry>>;
	programs: { id: string; name: string; timeline: unknown }[];
}

export const RECIPES: RecipeEntry[] = [...pieces, ...recipes];
// The pieces' group comes first, as the examples that are music rather than a technique, and then the rest by name.
export const GROUPS = [...new Set([...pieces.map((p) => p.group), ...recipes.map((r) => r.group).sort()])];

// Loaded one at a time, because the ones with recordings are large and a page needs only one.
const files = import.meta.glob<{ default: RecipeProject }>([
	'../../../../examples/Pieces/*.json',
	'../../../../examples/Recipes/*.json'
]);
const folder = (entry: RecipeEntry) => (pieces.includes(entry) ? 'Pieces' : 'Recipes');

export async function readRecipe(name: string): Promise<RecipeProject | null> {
	const entry = RECIPES.find((recipe) => recipe.name === name);
	if (!entry) return null;
	const file = Object.keys(files).find((path) => path.endsWith(`/${folder(entry)}/${entry.file}`));
	return file ? (await files[file]()).default : null;
}

export const recipeTimelineId = (name: string) => `recipe-${name}`;

export const recipeInLibrary = (db: Db, name: string) =>
	db
		.select({ id: timelines.id })
		.from(timelines)
		.where(eq(timelines.id, recipeTimelineId(name)))
		.get() !== undefined;
