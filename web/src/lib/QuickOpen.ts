// Mod+K's quick open: what it can open, and how what was typed ranks it.
export interface Openable {
	kind: 'Song' | 'Example' | 'Patch' | 'Built-in';
	name: string;
	href: string;
}

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
