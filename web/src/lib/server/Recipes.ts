// The recipes in examples/Recipes, the pieces in examples/Pieces and the standard set's families in examples/Instruments, as
// a read-only catalogue. They play from here as they are. Their patches are in every library as built-in ones, which
// Builtins.ts writes from these files, and adding an example copies only its timeline.
import { eq } from 'drizzle-orm';
import instruments from '../../../../examples/Instruments/Index.json';
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
	family?: string; // A family of the standard set's, such as "Piano" or "Drum kit", for one of its examples
	listen_for: string;
}

export interface RecipeProject {
	patches: Record<string, { name: string; graph: unknown }>;
	assets?: Record<string, Omit<AssetEntry, 'id' | 'name' | 'loop_start' | 'loop_end'> & Partial<AssetEntry>>;
	programs: { id: string; name: string; timeline: unknown }[];
}

// The standard set's examples, one for each family it has, in General MIDI's order of families and then the kit and the
// effects, as MakeInstruments.py writes them.
const SET: RecipeEntry[] = instruments;

export const RECIPES: RecipeEntry[] = [...pieces, ...SET, ...recipes];
// The pieces' group comes first, as the examples that are music rather than a technique, then the standard set's, and then
// the recipes' by name.
export const GROUPS = [
	...new Set([...pieces.map((p) => p.group), ...SET.map((s) => s.group), ...recipes.map((r) => r.group).sort()])
];

// Whether an example is one of the standard set's, whose patches are the set's instruments.
export const inSet = (entry: RecipeEntry) => SET.includes(entry);

// Loaded one at a time, because the ones with recordings are large and a page needs only one.
const files = import.meta.glob<{ default: RecipeProject }>([
	'../../../../examples/Pieces/*.json',
	'../../../../examples/Instruments/*.json',
	'../../../../examples/Recipes/*.json'
]);
const folder = (entry: RecipeEntry) => (pieces.includes(entry) ? 'Pieces' : inSet(entry) ? 'Instruments' : 'Recipes');

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
