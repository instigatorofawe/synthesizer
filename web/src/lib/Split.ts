// The line between the arrangement and the notes. The arrangement is as tall as its tracks, up to a part of the window, until
// the tab strip under it is dragged, as the line between them is in Live, Logic and Bitwig: then it is as tall as it was
// dragged to, and a double-click on the strip gives it back its own height. Each song keeps its own across a reload, in one
// entry of localStorage, never in the document. A song at its own height has no entry, and the oldest go past `KEPT`.

export const SPLIT_KEY = 'modsynth.split';
const KEPT = 200;

// However it is dragged, the arrangement keeps its ruler, its loop strip and a folded song lane, and a track's head shows, and
// the notes keep room for a few rows.
export const LEAST_ARRANGEMENT = 72;
export const LEAST_NOTES = 120;

// The arrangement's height for a drag of `by` pixels from `from`, when it and the notes have `room` between them.
export function splitAt(from: number, by: number, room: number): number {
	const most = Math.max(LEAST_ARRANGEMENT, room - LEAST_NOTES);
	return Math.round(Math.min(most, Math.max(LEAST_ARRANGEMENT, from + by)));
}

function parse(text: string | null): Record<string, number> {
	try {
		const parsed: unknown = JSON.parse(text ?? '{}');
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		const kept: Record<string, number> = {};
		for (const [song, height] of Object.entries(parsed)) {
			if (typeof height === 'number' && Number.isFinite(height) && height >= LEAST_ARRANGEMENT) kept[song] = height;
		}
		return kept;
	} catch {
		return {};
	}
}

export const keptSplit = (text: string | null, song: string): number | null => parse(text)[song] ?? null;

export function keepSplit(text: string | null, song: string, height: number | null, most = KEPT): string {
	const kept = parse(text);
	delete kept[song];
	if (height !== null) kept[song] = Math.round(height);
	const songs = Object.keys(kept);
	for (const old of songs.slice(0, Math.max(0, songs.length - most))) delete kept[old];
	return JSON.stringify(kept);
}
