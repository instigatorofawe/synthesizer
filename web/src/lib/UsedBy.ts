// Where a patch is used, as the page has it: with the unsaved edits counted, so what the Patch view says agrees with what the
// keys play. The server's "used by" knows only what is saved.
import { referencedPatches, referencedSubpatches, timelineSchema, type Timeline } from '#lib/Schema.ts';
import type { PatchLike } from '#lib/TimelineEdit.ts';

// A timeline as the library lists it, with the patches it plays as saved.
export interface ListedTimeline {
	id: string;
	name: string;
	patches: string[];
}

// The patches a timeline's text plays, or null for text that isn't a timeline.
export function playedBy(text: string): string[] | null {
	try {
		const checked = timelineSchema.safeParse(JSON.parse(text));
		return checked.success ? referencedPatches(checked.data) : null;
	} catch {
		return null;
	}
}

// The patch and every patch that expands it, however deep, as the graphs are now. A graph can name itself, which the compiler
// refuses, so this keeps track of what it has seen.
function withParents(id: string, patches: PatchLike[]): Set<string> {
	const parents = new Map<string, string[]>();
	for (const patch of patches) {
		for (const sub of referencedSubpatches(patch.graph)) parents.set(sub, [...(parents.get(sub) ?? []), patch.id]);
	}
	const seen = new Set([id]);
	let frontier = [id];
	while (frontier.length) {
		frontier = frontier.flatMap((one) => parents.get(one) ?? []).filter((other) => !seen.has(other));
		for (const other of frontier) seen.add(other);
	}
	return seen;
}

// Every timeline an edit to this patch changes, including those that reach it through another patch, by name. A timeline with
// unsaved edits counts as `now` has it, under its unsaved name, and the rest as saved.
export function usedBy(
	id: string,
	patches: PatchLike[],
	timelines: ListedTimeline[],
	now: ReadonlyMap<string, { name: string; patches: string[] }>
): { id: string; name: string }[] {
	const reach = withParents(id, patches);
	return timelines
		.map((timeline) => ({ id: timeline.id, ...(now.get(timeline.id) ?? timeline) }))
		.filter((timeline) => timeline.patches.some((patch) => reach.has(patch)))
		.map(({ id, name }) => ({ id, name }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// The track a copy of a patch is chosen on once it takes the patch's place: the one preferred, which is where the keys played
// it, if it plays the patch, and otherwise the first that plays it as a voice, and then the first with it as an insert. Null
// when no track plays it, as when a bus does, or it is only inside another patch.
export function playedOn(doc: Timeline, patch: string, preferred: number | null): number | null {
	const voice = (track: Timeline['tracks'][number]) => track.slots.includes(patch);
	const insert = (track: Timeline['tracks'][number]) => track.inserts.some((one) => one.patch === patch);
	const chosen = doc.tracks.find((track) => track.id === preferred);
	if (chosen && (voice(chosen) || insert(chosen))) return chosen.id;
	return (doc.tracks.find(voice) ?? doc.tracks.find(insert))?.id ?? null;
}
