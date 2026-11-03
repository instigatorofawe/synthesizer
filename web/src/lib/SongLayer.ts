// The song layer: lanes above the tracks for what belongs to the whole song rather than to one track. Tempo is the one there
// is. Time signatures and markers would join it, each as a lane here, once the format has a field for them, since nothing
// in a document says either today.

export interface SongLane {
	id: string;
	name: string;
}

export const SONG_LANES: readonly SongLane[] = [{ id: 'tempo', name: 'Tempo' }];

// A folded lane is a thin row that reads at a glance, and an unfolded one is tall enough to draw a curve and drag it.
export const FOLDED = 18;
export const UNFOLDED = 72;

export const laneHeight = (open: boolean) => (open ? UNFOLDED : FOLDED);

// How tall the layer is, with these lanes unfolded.
export const layerHeight = (open: ReadonlySet<string>, lanes: readonly SongLane[] = SONG_LANES) =>
	lanes.reduce((sum, lane) => sum + laneHeight(open.has(lane.id)), 0);

// Which lanes are unfolded is the editor's, kept for each timeline across a reload in one entry of localStorage, never in the
// document, which the compiler would refuse. A timeline with every lane folded, as they start, has no entry. The newest come
// last, and the oldest go past `KEPT`, so the entry stays small however many timelines are opened.
export const LANES_KEY = 'modsynth.songLanes';
const KEPT = 200;

function parse(text: string | null): Record<string, string[]> {
	try {
		const parsed: unknown = JSON.parse(text ?? '{}');
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		const kept: Record<string, string[]> = {};
		for (const [timeline, lanes] of Object.entries(parsed)) {
			if (Array.isArray(lanes)) kept[timeline] = lanes.filter((lane): lane is string => typeof lane === 'string');
		}
		return kept;
	} catch {
		return {};
	}
}

export const keptOpen = (text: string | null, timeline: string): Set<string> => new Set(parse(text)[timeline] ?? []);

export function keepOpen(text: string | null, timeline: string, open: ReadonlySet<string>, most = KEPT): string {
	const kept = parse(text);
	delete kept[timeline];
	if (open.size) kept[timeline] = [...open].sort();
	const timelines = Object.keys(kept);
	for (const old of timelines.slice(0, Math.max(0, timelines.length - most))) delete kept[old];
	return JSON.stringify(kept);
}
