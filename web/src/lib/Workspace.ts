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
	| { kind: 'alone' }
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
	if (canBeAlone) return { kind: 'alone' };
	return {
		kind: 'none',
		why: voices.length ? 'Its track has no notes yet, so the image leaves it out.' : 'No track plays it.'
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

// What the top bar's Undo and Redo act on: the history of whatever the view on screen edits.
export interface Undoable {
	readonly canUndo: boolean;
	readonly canRedo: boolean;
	undo(): void;
	redo(): void;
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
