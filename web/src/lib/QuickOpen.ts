// Mod+K's quick open: what it can open, and how what was typed ranks it.
import { GM } from '#lib/GeneralMidi.ts';

export interface Openable {
	kind: 'Song' | 'Example' | 'Patch' | 'Instrument' | 'Built-in';
	name: string;
	href: string;
}

// What a patch is called there: the library's own, one of the standard set's, or another built-in, an example's own. The set's
// are told apart from those, since a kit's Snare and the Snare recipe's are both built in.
export const patchKind = (patch: { id: string; builtin?: boolean }): 'Patch' | 'Instrument' | 'Built-in' =>
	!patch.builtin ? 'Patch' : patch.id.startsWith(GM.prefix) ? 'Instrument' : 'Built-in';

// The library's own patches come first, then the set's, then the other built-ins.
export const PATCH_KINDS = ['Patch', 'Instrument', 'Built-in'] as const;

// What matches what was typed, best first: a name that starts with it, then one with a word that does, then any that holds
// it, each in the order given. Empty, it is everything, up to `most`.
export function rank(items: Openable[], typed: string, most = 50): Openable[] {
	const query = typed.trim().toLowerCase();
	if (!query) return items.slice(0, most);
	const score = (name: string) => {
		const lower = name.toLowerCase();
		if (lower.startsWith(query)) return 0;
		if (name.split(/[\s_-]+|(?=[A-Z])/).some((word) => word.toLowerCase().startsWith(query))) return 1;
		return lower.includes(query) ? 2 : 3;
	};
	return items
		.map((item, at) => ({ item, at, score: score(item.name) }))
		.filter((entry) => entry.score < 3)
		.sort((a, b) => a.score - b.score || a.at - b.at)
		.slice(0, most)
		.map((entry) => entry.item);
}
