// What the patch picker lists, and in what order: the patches the open song already plays, then the library's own, then the
// built-in ones, grouped as the browser groups the examples they come from. Filtering is here too, so it can be tested
// without a page.
import type { PatchLike } from '#lib/TimelineEdit.ts';

// An example group as the browser lists it, with its examples in order.
export interface ExampleGroup {
	name: string;
	recipes: { name: string }[];
}

export interface PatchGroup<T extends PatchLike = PatchLike> {
	key: string;
	label: string; // The heading: "On this song", "My patches", or under "Built in", the examples' group
	builtin: boolean; // Under the "Built in" heading
	patches: T[];
}

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

	const names = examples.flatMap((group) => group.recipes.map((recipe) => recipe.name));
	const where = new Map<string, { group: number; at: number }>();
	examples.forEach((group, index) =>
		group.recipes.forEach((recipe, at) => where.set(recipe.name, { group: index, at }))
	);
	const builtins = examples.map((group) => ({ group, list: [] as { patch: T; at: number }[] }));
	const other: T[] = [];
	for (const patch of rest) {
		if (!patch.builtin) continue;
		const example = exampleOf(patch.id, names);
		const place = example === null ? undefined : where.get(example);
		if (place) builtins[place.group].list.push({ patch, at: place.at });
		else other.push(patch);
	}
	for (const { group, list } of builtins) {
		list.sort((a, b) => a.at - b.at || byName(a.patch, b.patch));
		groups.push({
			key: `builtin:${group.name}`,
			label: group.name,
			builtin: true,
			patches: list.map((entry) => entry.patch)
		});
	}
	// Built-ins no example names, such as one that stopped shipping while a timeline still plays it. With no examples to
	// group by, they all go here, under no heading of their own.
	groups.push({ key: 'builtin:', label: examples.length ? 'other' : '', builtin: true, patches: other.sort(byName) });
	return groups.filter((group) => group.patches.length);
}

// The groups with only what matches every word typed, in any case. A built-in also matches its group's name, so "drums"
// finds the drum kit.
export function filterGroups<T extends PatchLike>(groups: PatchGroup<T>[], query: string): PatchGroup<T>[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return groups;
	return groups
		.map((group) => ({
			...group,
			patches: group.patches.filter((patch) => {
				const text = `${patch.name} ${group.builtin ? group.label : ''}`.toLowerCase();
				return words.every((word) => text.includes(word));
			})
		}))
		.filter((group) => group.patches.length);
}
