// What the patch picker lists, and in what order: the patches the open song already plays, then the library's own, then the
// built-in ones: the standard set's under their families, and then the examples' own under one heading. Filtering is here
// too, so it can be tested without a page.
import type { PatchLike } from '#lib/TimelineEdit.ts';

// An example group as the browser lists it, with its examples in order. The standard set's examples name their family and
// the built-in patches they play, in their own order.
export interface ExampleGroup {
	name: string;
	recipes: { name: string; family?: string; patches?: string[] }[];
}

export interface PatchGroup<T extends PatchLike = PatchLike> {
	key: string;
	label: string; // The heading: "On this song", "My patches", or under "Built in", a family of the set's or "Techniques"
	builtin: boolean; // Under the "Built in" heading
	patches: T[];
	words?: Map<string, string>; // What else a patch here matches, by its id: a technique's example group, such as "drums"
}

// The heading every built-in patch that isn't the set's goes under: the recipes' and the pieces' own.
export const TECHNIQUES = 'Techniques';

// Builtins.ts names a built-in patch after its example, as `builtin-Kick808`, or with its part, as
// `builtin-PassionChorale-horn`. That module is the server's, so the prefix is repeated here.
const BUILTIN = 'builtin-';

// The example a built-in patch came from, or null. The longest name wins, so one example's name can start another's.
export function exampleOf(id: string, names: string[]): string | null {
	if (!id.startsWith(BUILTIN)) return null;
	const rest = id.slice(BUILTIN.length);
	let found: string | null = null;
	for (const name of names) {
		if ((rest === name || rest.startsWith(`${name}-`)) && name.length > (found?.length ?? -1)) found = name;
	}
	return found;
}

const byName = (a: PatchLike, b: PatchLike) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// Each patch once, in the first group it belongs to. `used` is in the order the song plays them, which "On this song" keeps.
// A group with nothing in it is left out.
export function patchGroups<T extends PatchLike>(
	patches: T[],
	used: string[],
	examples: ExampleGroup[]
): PatchGroup<T>[] {
	const byId = new Map(patches.map((patch) => [patch.id, patch]));
	const song = [...new Set(used)].flatMap((id) => byId.get(id) ?? []);
	const onSong = new Set(song.map((patch) => patch.id));
	const rest = patches.filter((patch) => !onSong.has(patch.id));
	const groups: PatchGroup<T>[] = [
		{ key: 'song', label: 'On this song', builtin: false, patches: song },
		{ key: 'mine', label: 'My patches', builtin: false, patches: rest.filter((patch) => !patch.builtin).sort(byName) }
	];

	// The set's, under their families in the order the examples come, each in the order its example plays them. A patch two
	// of them play, as the effects' example plays the grand piano, is in the first.
	const families = new Map<string, string[]>();
	const family = new Map<string, string>();
	for (const group of examples) {
		for (const recipe of group.recipes) {
			if (recipe.family === undefined) continue;
			const list = families.get(recipe.family) ?? [];
			families.set(recipe.family, list);
			for (const id of recipe.patches ?? []) {
				if (family.has(id)) continue;
				family.set(id, recipe.family);
				list.push(id);
			}
		}
	}
	const builtins = rest.filter((patch) => patch.builtin);
	const inFamily = new Map(builtins.filter((patch) => family.has(patch.id)).map((patch) => [patch.id, patch]));
	for (const [name, ids] of families) {
		groups.push({
			key: `family:${name}`,
			label: name,
			builtin: true,
			patches: ids.flatMap((id) => inFamily.get(id) ?? [])
		});
	}

	// The rest are the examples' own, in the order the browser lists their examples.
	const where = new Map<string, { group: string; at: number }>();
	let at = 0;
	for (const group of examples) {
		for (const recipe of group.recipes) {
			if (recipe.family === undefined) where.set(recipe.name, { group: group.name, at: at++ });
		}
	}
	const names = [...where.keys()];
	const techniques: { patch: T; at: number; group: string }[] = [];
	const other: T[] = [];
	for (const patch of builtins) {
		if (inFamily.has(patch.id)) continue;
		const example = exampleOf(patch.id, names);
		const place = example === null ? undefined : where.get(example);
		if (place) techniques.push({ patch, ...place });
		else other.push(patch);
	}
	techniques.sort((a, b) => a.at - b.at || byName(a.patch, b.patch));
	groups.push({
		key: 'builtin:techniques',
		label: TECHNIQUES,
		builtin: true,
		patches: techniques.map((entry) => entry.patch),
		words: new Map(techniques.map((entry) => [entry.patch.id, entry.group]))
	});
	// Built-ins no example names, such as one that stopped shipping while a timeline still plays it. With no examples to
	// group by, they all go here, under no heading of their own.
	groups.push({ key: 'builtin:', label: examples.length ? 'other' : '', builtin: true, patches: other.sort(byName) });
	return groups.filter((group) => group.patches.length);
}

// The groups with only what matches every word typed, in any case. A built-in also matches its group's name, so "drum"
// finds the drum kit and "piano" the piano family, and a technique its example group's, so "drums" finds the Kick808.
export function filterGroups<T extends PatchLike>(groups: PatchGroup<T>[], query: string): PatchGroup<T>[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return groups;
	return groups
		.map((group) => ({
			...group,
			patches: group.patches.filter((patch) => {
				const text = `${patch.name} ${group.builtin ? `${group.label} ${group.words?.get(patch.id) ?? ''}` : ''}`;
				return words.every((word) => text.toLowerCase().includes(word));
			})
		}))
		.filter((group) => group.patches.length);
}
