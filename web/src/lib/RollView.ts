// How much of a clip the piano roll shows: how wide a beat is, how tall a row, and where it is scrolled to. Each clip keeps
// its own, so coming back to a clip finds it as it was left, and the wheel and Fit change it.

import { modHeld } from '#lib/Shortcuts.ts';
import { BEATS_PER_BAR, type Clip } from '#lib/TimelineEdit.ts';

export interface RollZoom {
	beat: number; // Pixels across a beat
	row: number; // Pixels down a row, one semitone
}

export interface RollView extends RollZoom {
	left?: number; // How far the roll is scrolled, in pixels, if it has been: a zoom kept across a reload has no scroll
	top?: number;
}

export const ROW = 12; // A row's height until someone changes it
export const BEAT = { least: 8, most: 400 };
// Below 6 a note is too thin to grab, and above 32 an octave no longer fits a laptop's roll.
export const ROWS = { least: 6, most: 32 };

const clamp = (value: number, { least, most }: { least: number; most: number }) =>
	Math.min(most, Math.max(least, value));

export const clampBeat = (beat: number) => clamp(beat, BEAT);
export const clampRow = (row: number) => Math.round(clamp(row, ROWS));

// What a wheel over the roll does. A wheel or two fingers scroll, as they scroll a page, and Shift with a wheel scrolls
// sideways. Mod with the wheel zooms across, and so does a pinch, which a browser sends as a wheel with ctrlKey set. Mod and
// Shift with the wheel make the rows taller or shorter. A zoom is a factor: a notch of a wheel is clamped, so that it zooms
// about as far as a short pinch does, as the graph's does.
export type WheelAction =
	| { kind: 'scroll' } // Left to the browser
	| { kind: 'sideways'; by: number } // Pixels
	| { kind: 'zoom'; by: number }
	| { kind: 'rows'; by: number };

export type Wheel = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'shiftKey' | 'ctrlKey' | 'metaKey'>;

const LINE = 16; // Pixels in a line, for a wheel that counts in lines, as Firefox's does

export function wheelAction(event: Wheel, mod: 'Meta' | 'Control', page: number): WheelAction {
	const unit = event.deltaMode === 1 ? LINE : event.deltaMode === 2 ? page : 1;
	// With Shift held, macOS sends a mouse wheel's turn as a sideways one, so the larger of the two is the turn.
	const turn = (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX) * unit;
	if (event.ctrlKey || modHeld(event, mod)) {
		const by = 2 ** (-Math.max(-50, Math.min(50, turn)) / 150);
		return { kind: event.shiftKey ? 'rows' : 'zoom', by };
	}
	if (event.shiftKey) return { kind: 'sideways', by: turn };
	return { kind: 'scroll' };
}

// Where to scroll to after a zoom by `ratio`, so that what was under the pointer stays under it. `scroll` is how far the view
// was scrolled, `at` how far the pointer is from the view's edge, and `margin` how much of the content comes before what
// zooms, as the keys do at the roll's left.
export function anchored(scroll: number, at: number, ratio: number, margin = 0): number {
	return Math.max(0, (scroll + at - margin) * ratio + margin - at);
}

// The view that fits the clip's notes into the roll's `width` and `height`: across, from the start of the bar the first note
// is in to the end of the bar the last one ends in, and down, the notes' pitches with two rows to spare above and below. A
// clip with no notes fits its length, and the two octaves around middle C.
export function fitRoll(
	clip: Pick<Clip, 'notes' | 'length'>,
	ppq: number,
	size: { width: number; height: number }
): Required<RollView> {
	const bar = ppq * BEATS_PER_BAR;
	const notes = clip.notes;
	const first = notes.length ? Math.floor(Math.min(...notes.map((n) => n.tick)) / bar) * bar : 0;
	const last = notes.length ? Math.ceil(Math.max(...notes.map((n) => n.tick + n.dur)) / bar) * bar : clip.length;
	const span = Math.max(last - first, bar);
	const beat = clampBeat(size.width / (span / ppq));

	const low = notes.length ? Math.min(...notes.map((n) => n.note)) - 2 : 48;
	const high = notes.length ? Math.max(...notes.map((n) => n.note)) + 2 : 72;
	const row = Math.max(ROWS.least, Math.min(ROWS.most, Math.floor(size.height / (high - low + 1))));
	const middle = (127 - (low + high) / 2) * row + row / 2;
	return { beat, row, left: (first / ppq) * beat, top: Math.max(0, middle - size.height / 2) };
}

// Each clip's zoom, kept across a reload in one entry of localStorage, keyed by timeline and clip. The newest come last, and
// the oldest go past `KEPT`, so the entry stays small however many clips are visited.
export const ZOOM_KEY = 'modsynth.zoom';
const KEPT = 200;

export const zoomKey = (timeline: string, clip: string) => JSON.stringify([timeline, clip]);

export function keptZoom(text: string | null, key: string): RollZoom | null {
	const kept = parseZooms(text)[key];
	return kept ? { beat: clampBeat(kept[0]), row: clampRow(kept[1]) } : null;
}

export function keepZoom(text: string | null, key: string, zoom: RollZoom, most = KEPT): string {
	const zooms = parseZooms(text);
	delete zooms[key];
	zooms[key] = [Math.round(zoom.beat * 100) / 100, zoom.row];
	const keys = Object.keys(zooms);
	for (const old of keys.slice(0, Math.max(0, keys.length - most))) delete zooms[old];
	return JSON.stringify(zooms);
}

// Whatever is there, as an object of pairs of numbers. Anything else, from another version or another hand, is dropped.
function parseZooms(text: string | null): Record<string, [number, number]> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text ?? '{}');
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
	const zooms: Record<string, [number, number]> = {};
	for (const [key, value] of Object.entries(parsed)) {
		const fine = Array.isArray(value) && value.length === 2 && value.every((n) => Number.isFinite(n) && n > 0);
		if (fine) zooms[key] = value as [number, number];
	}
	return zooms;
}

// Each clip's view while the page is open, scroll and all. The roll is made again for each clip it shows, and the editor for
// each timeline, so this outlasts both.
export const rollViews = new Map<string, RollView>();
