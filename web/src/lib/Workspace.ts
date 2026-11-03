// The editor page's decisions that aren't drawing: what is unsaved, what the library looks like with it, and where a key
// pressed in the patch panel is heard.
import type { SubmitFunction } from '$app/forms';
import type { ProgramReport } from '#lib/Request.ts';
import type { Graph, Timeline } from '#lib/Schema.ts';
import { patchUses, type PatchLike } from '#lib/TimelineEdit.ts';

// An unsaved document. The text is what the JSON view shows and what is saved, so text that doesn't parse can still be kept
// and fixed. `revision` is the one it was edited from, so saving over someone else's save is refused.
export interface Draft {
	kind: 'patch' | 'timeline';
	id: string;
	revision: number;
	name: string;
	text: string;
	graph?: Graph; // A patch's text as it last parsed, which is what is drawn and heard while the text doesn't
}

export const draftKey = (kind: Draft['kind'], id: string) => `${kind}:${id}`;

// A graph as the editors want it, or null for text that isn't one.
export function parseGraph(text: string): Graph | null {
	try {
		const parsed = JSON.parse(text) as Graph;
		if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.nodes)) return null;
		return { ...parsed, params: parsed.params ?? [], edges: parsed.edges ?? [] };
	} catch {
		return null;
	}
}

// Why text isn't a graph, or nothing if it is one.
export function graphError(text: string): string {
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === 'object' && parsed !== null && Array.isArray(parsed.nodes)
			? ''
			: 'a graph needs a list of nodes';
	} catch (e) {
		return (e as Error).message;
	}
}

// The library as it is on screen: each patch with its unsaved name and graph.
export function withDrafts<T extends PatchLike>(patches: T[], drafts: Record<string, Draft>): T[] {
	return patches.map((patch) => {
		const draft = drafts[draftKey('patch', patch.id)];
		if (!draft) return patch;
		return { ...patch, name: draft.name, graph: draft.graph ?? patch.graph };
	});
}

// A document with a change, as a draft, or nothing once it is back to what was saved.
export function edited(saved: Omit<Draft, 'graph'>, current: Draft | undefined, change: Partial<Draft>): Draft | null {
	const next = { ...(current ?? saved), ...change };
	return next.name === saved.name && next.text === saved.text ? null : next;
}

export const isInsert = (graph: Graph) => graph.nodes.some((node) => node.type === 'in');

// Where the patch panel's keys play. A patch a track plays is heard there, in the song with its mix and inserts, and the
// selected track wins when several play it. A track the image leaves out, because none of its notes are placed, can't be.
// A voice no track plays is heard on its own. An insert has no notes of its own, so it is only heard on what it's inserted on.
export type Hearing =
	| { kind: 'song'; track: number; slot: number; id: number; name: string }
	| { kind: 'alone'; track: string | null } // The track that plays it, which has no notes yet, if one does
	| { kind: 'none'; why: string };

export function hearing(
	doc: Timeline | null,
	program: ProgramReport | null,
	patch: PatchLike | null,
	selected: number | null,
	canBeAlone: boolean
): Hearing {
	if (!patch) return { kind: 'none', why: 'No patch is open.' };
	const uses = doc ? patchUses(doc, patch.id) : [];
	const voices = uses.flatMap((use) => (use.kind === 'voice' ? [use] : []));
	voices.sort((a, b) => Number(b.track.id === selected) - Number(a.track.id === selected));
	for (const use of voices) {
		const index = program?.tracks.find((t) => t.id === use.track.id)?.index;
		if (index !== undefined) {
			return {
				kind: 'song',
				track: index,
				slot: use.slot,
				id: use.track.id,
				name: use.track.name || `Track ${use.track.id}`
			};
		}
	}
	if (isInsert(patch.graph)) {
		const on = uses.flatMap((use) => (use.kind === 'insert' ? [use.chain] : []));
		return {
			kind: 'none',
			why: on.length
				? `An insert has no keys. It is heard on ${on.join(' and ')} when that plays.`
				: 'An insert has no keys. Add it to a track or bus in the mixer to hear it.'
		};
	}
	if (canBeAlone) {
		const quiet = program ? voices[0]?.track : undefined;
		return { kind: 'alone', track: quiet ? quiet.name || `Track ${quiet.id}` : null };
	}
	return {
		kind: 'none',
		why: voices.length ? 'Its track has no notes yet, so the image leaves it out.' : 'No track plays it.'
	};
}

// A track as the keys play it while the song's image leaves it out, because none of its notes are placed yet: on its own, as
// the Patch view plays a patch no track plays, compiled with `live` so that a track with nothing placed is kept. It keeps what
// makes its sound, its patches, voices, play mode, parameters, level and inserts, and the master's level and inserts, and
// leaves out what reaches the rest of the song, its placements, sends and sidechains, so it compiles on its own. Null for a
// track with no patch to play.
export function trackAlone(doc: Timeline, id: number): Timeline | null {
	const track = doc.tracks.find((candidate) => candidate.id === id);
	if (!track?.slots.length) return null;
	const unkeyed = <T extends { key?: string }>({ key: _, ...insert }: T) => insert;
	return {
		...doc,
		clips: [],
		tracks: [{ ...track, placements: [], output: 'master', sends: [], inserts: track.inserts.map(unkeyed) }],
		buses: [],
		master: { ...doc.master, inserts: doc.master.inserts.map(unkeyed) }
	};
}

// The address with some parameters changed, and null taking one away.
export function withParams(search: string, change: Record<string, string | null>): string {
	const params = new URLSearchParams(search);
	for (const [key, value] of Object.entries(change)) {
		if (value === null) params.delete(key);
		else params.set(key, value);
	}
	const text = params.toString();
	return text ? `?${text}` : '?';
}

// The page shows one of two views at a time, each with all the height: the song, which is the arrangement, its notes and its
// mix, or the patch, which is one patch's graph.
export type View = 'song' | 'patch';

// Which view an address shows. `view` says so, and an address without it shows the patch it names, as links did before
// there were views, and otherwise the song.
export function viewOf(search: string): View {
	const params = new URLSearchParams(search);
	const view = params.get('view');
	if (view === 'song' || view === 'patch') return view;
	return params.has('patch') || params.has('part') ? 'patch' : 'song';
}

// The address showing a view, which leaves out `view` where the rest of it already says the same.
export function withView(search: string, view: View): string {
	const params = new URLSearchParams(search);
	return withParams(search, { view: view === 'song' && !params.has('patch') && !params.has('part') ? null : view });
}

// Where the Song view is: the chosen track, the clip the roll shows, and the tab, Notes, Mixer or another. The address holds it,
// as `track`, `clip` and `pane`, so a reload or a link lands there. Null is a part the address doesn't say. None of it is
// anything the server loads, so the page moves it without a round trip.
export interface SongPlace {
	track: number | null;
	clip: string | null;
	tab: string | null;
}

// The place an address names. A track that isn't a whole number names none.
export function songPlaceOf(search: string): SongPlace {
	const params = new URLSearchParams(search);
	const track = params.get('track')?.trim() || null;
	const id = track === null ? NaN : Number(track);
	return {
		track: Number.isInteger(id) ? id : null,
		clip: params.get('clip') || null,
		tab: params.get('pane') || null
	};
}

// The address's parameters for a place, for `withParams`. A song opens on its notes, so the address doesn't say Notes.
export function placeParams(place: SongPlace): Record<string, string | null> {
	return {
		track: place.track === null ? null : String(place.track),
		clip: place.clip,
		pane: place.tab === null || place.tab === 'notes' ? null : place.tab
	};
}

// The address without a place, for opening another song, whose tracks and clips aren't this one's.
export const withoutPlace = (search: string) => withParams(search, placeParams({ track: null, clip: null, tab: null }));

// Where a link opens a timeline, an example or a patch, from the address now. Another song has its own tracks and clips, so the
// place in this one stays behind, and the song open (`open`) goes back to where it is.
export const timelineHref = (search: string, id: string, open: string | null) =>
	withView(
		withParams(id === open ? search : withoutPlace(search), { timeline: id, recipe: null, patch: null, part: null }),
		'song'
	);
export const recipeHref = (search: string, name: string, open: string | null) =>
	withView(
		withParams(name === open ? search : withoutPlace(search), {
			recipe: name,
			timeline: null,
			patch: null,
			part: null
		}),
		'song'
	);
export const patchHref = (search: string, id: string) =>
	withView(withParams(search, { patch: id, part: null }), 'patch');

// Where the Song view lands when it is asked for a place, as it opens or as Back and Forward move the address under it: the
// track, which of its placements is chosen, the clip the roll shows, and the tab. What the song doesn't have is ignored, and
// the editor's own choice stands in: a clip asked for alone is chosen where it is first placed, a track alone on its first
// placement, and with neither, the first track with a clip, on its notes.
export interface Landing {
	track: number | null;
	placement: number | null;
	clip: string | null;
	tab: string;
}

export function landing(doc: Timeline, asked: SongPlace | null, tabs: readonly string[]): Landing {
	const tab = asked?.tab && tabs.includes(asked.tab) ? asked.tab : 'notes';
	const clip = doc.clips.some((c) => c.id === asked?.clip) ? (asked?.clip ?? null) : null;
	const own = doc.tracks.find((t) => t.placements.length) ?? doc.tracks[0];
	const track =
		doc.tracks.find((t) => t.id === asked?.track) ??
		(clip === null ? undefined : doc.tracks.find((t) => t.placements.some((p) => p.clip === clip))) ??
		own;
	if (!track) return { track: null, placement: null, clip, tab };
	if (clip === null) {
		const first = track.placements[0];
		return { track: track.id, placement: first ? 0 : null, clip: first?.clip ?? null, tab };
	}
	const index = track.placements.findIndex((p) => p.clip === clip);
	return { track: track.id, placement: index >= 0 ? index : null, clip, tab };
}

// A form action on this page, sent from where the page is, so the page stays where it is when it comes back.
export function actionOn(search: string, name: string): string {
	const params = new URLSearchParams(search);
	for (const key of [...params.keys()]) if (key.startsWith('/')) params.delete(key);
	const text = params.toString();
	return `?${text ? `${text}&` : ''}/${name}`;
}

// For a form whose fields should keep what was typed in them after it is sent.
export const stay: SubmitFunction =
	() =>
	({ update }) =>
		update({ reset: false });
