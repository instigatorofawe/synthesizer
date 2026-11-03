// The Tempo lane in the song layer, apart from drawing it: what its gestures do to the song's tempo, how far up and down it
// reaches, and where a tempo is drawn. The song's tempo is a list of changes, each holding until the next or, marked `ramp`,
// gliding to it. The lane and the inspector's list are two views of that one list, so every edit here is one of the
// timeline's own, and undoes as any other does.
import { MAX_BPM, MIN_BPM } from '#lib/Transport.ts';
import { addTempo, barOf, setTempo, snapTick, tempoAt, type Tempo } from '#lib/TimelineEdit.ts';
import type { Timeline } from '#lib/Schema.ts';

export interface TempoRange {
	low: number; // The BPM at the foot of the lane
	high: number; // And at its top
}

// The lane fits the song's tempos, with room above and below of a sixth of their spread or 10 BPM, whichever is more, out to
// tens of BPM so the scale reads as round numbers, and within what the schema allows.
export function tempoRange(tempo: Tempo[]): TempoRange {
	const bpms = tempo.length ? tempo.map((change) => change.bpm) : [120];
	const slowest = Math.min(...bpms);
	const fastest = Math.max(...bpms);
	const room = Math.max(10, (fastest - slowest) / 6);
	const low = Math.max(0, Math.floor((slowest - room) / 10) * 10);
	const high = Math.min(MAX_BPM, Math.ceil((fastest + room) / 10) * 10);
	return { low, high: Math.max(high, low + 10) };
}

// Where a tempo is drawn in a lane `height` pixels tall, with `pad` pixels kept clear at the top and the foot so a point there
// can still be taken hold of. Both are linear, and go on past the lane's edges, so a drag can take a tempo out of the range
// the lane had when it started.
export function bpmToY(bpm: number, range: TempoRange, height: number, pad: number): number {
	return pad + (1 - (bpm - range.low) / (range.high - range.low)) * (height - 2 * pad);
}

export function yToBpm(y: number, range: TempoRange, height: number, pad: number): number {
	return range.low + (1 - (y - pad) / (height - 2 * pad)) * (range.high - range.low);
}

// A dragged tempo, to a whole BPM, or to a tenth with `fine`, within what the schema allows.
export function roundBpm(bpm: number, fine = false): number {
	const step = fine ? 10 : 1;
	return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm * step) / step));
}

// The changes either side of one, by tick, as indices into the list, which needn't be in order.
function neighbours(tempo: Tempo[], index: number): { before: number; after: number } {
	const at = tempo[index].tick;
	let before = -1;
	let after = -1;
	tempo.forEach((change, i) => {
		if (change.tick < at && (before < 0 || change.tick > tempo[before].tick)) before = i;
		if (change.tick > at && (after < 0 || change.tick < tempo[after].tick)) after = i;
	});
	return { before, after };
}

// Where a change dragged to `tick` goes: the nearest line of the grid, kept between the changes either side of it, since a
// change can't pass another. Where no line of the grid is left between them, it stays where it was. The first change sets
// the tempo the song opens at, so it stays at its tick.
export function tempoTick(tempo: Tempo[], index: number, tick: number, grid: number): number {
	const change = tempo[index];
	const { before, after } = neighbours(tempo, index);
	if (before < 0) return change.tick;
	const low = tempo[before].tick + 1;
	const high = after < 0 ? Infinity : tempo[after].tick - 1;
	const snapped = snapTick(tick, grid);
	if (snapped >= low && snapped <= high) return snapped;
	const first = Math.ceil(low / grid) * grid;
	const last = Math.floor(high / grid) * grid;
	if (first > last) return change.tick;
	return snapped < low ? first : last;
}

// A change dragged: to `bpm`, and sideways to where `tempoTick` says. It keeps whether it glides.
export function moveTempo(doc: Timeline, index: number, tick: number, bpm: number, grid: number): Timeline {
	const change = doc.tempo[index];
	if (!change) return doc;
	const to = { tick: tempoTick(doc.tempo, index, tick, grid), bpm };
	return to.tick === change.tick && to.bpm === change.bpm ? doc : setTempo(doc, index, to);
}

// A change added at a tick, and where it is in the list after: or the change already at that tick, which a click there
// takes hold of instead. Inside a ramp it carries the ramp on, as `addTempo` says.
export function addTempoAt(doc: Timeline, tick: number, bpm: number): { doc: Timeline; index: number } {
	const next = addTempo(doc, tick, bpm);
	return { doc: next, index: next.tempo.findIndex((change) => change.tick === tick) };
}

// The tempo playing at a tick, as a click there adds it: to a hundredth, as the inspector's "Add a change" does, so a change
// added inside a ramp leaves its curve as it was.
export const tempoThere = (tempo: Tempo[], tick: number) => Math.round(tempoAt(tempo, tick) * 100) / 100;

// Whether a change can glide: only to a later one.
export const canGlide = (tempo: Tempo[], index: number) =>
	!!tempo[index] && tempo.some((change) => change.tick > tempo[index].tick);

// A change switched between holding until the next and gliding to it. The last has nowhere to glide to.
export function toggleGlide(doc: Timeline, index: number): Timeline {
	if (!canGlide(doc.tempo, index)) return doc;
	return setTempo(doc, index, { ramp: !doc.tempo[index].ramp });
}

// ↑ and ↓ on a chosen change, by `by` BPM, within what the schema allows. A hundredth keeps the sum clear of float noise.
export function nudgeTempo(doc: Timeline, index: number, by: number): Timeline {
	const change = doc.tempo[index];
	if (!change) return doc;
	const bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round((change.bpm + by) * 100) / 100));
	return bpm === change.bpm ? doc : setTempo(doc, index, { bpm });
}

// Whether a change is the first, which sets the tempo the song opens at and so can't be deleted or moved sideways.
export const isFirstTempo = (tempo: Tempo[], index: number) =>
	!!tempo[index] && !tempo.some((change) => change.tick < tempo[index].tick);

// What the lane draws: from each change to the next, or to `end` after the last, as a hold at its tempo or a glide to the
// next one's. Before a first change past tick 0 the engine plays its own 120, which `index` null stands for. In tick order.
export interface TempoSegment {
	index: number | null; // The change it starts at, as an index into the list
	next: number | null; // The change it ends at, or null after the last
	from: { tick: number; bpm: number };
	to: { tick: number; bpm: number };
	glide: 'up' | 'down' | 'level' | null; // Null for a hold
}

export function tempoSegments(tempo: Tempo[], end: number): TempoSegment[] {
	const order = tempo.map((_, index) => index).sort((a, b) => tempo[a].tick - tempo[b].tick);
	const segments: TempoSegment[] = [];
	const first = order.length ? tempo[order[0]] : null;
	if (!first || first.tick > 0) {
		const to = first ? first.tick : Math.max(end, 0);
		segments.push({
			index: null,
			next: order[0] ?? null,
			from: { tick: 0, bpm: 120 },
			to: { tick: to, bpm: 120 },
			glide: null
		});
	}
	order.forEach((index, at) => {
		const change = tempo[index];
		const next = order[at + 1] ?? null;
		const after = next === null ? null : tempo[next];
		const gliding = !!change.ramp && after !== null;
		const bpm = gliding ? after.bpm : change.bpm;
		segments.push({
			index,
			next,
			from: { tick: change.tick, bpm: change.bpm },
			to: { tick: after ? after.tick : Math.max(end, change.tick), bpm },
			glide: !gliding ? null : bpm > change.bpm ? 'up' : bpm < change.bpm ? 'down' : 'level'
		});
	});
	return segments;
}

// Which of a row of labels to show, left to right, so that none overlaps the one before it: `at` is where each starts and
// `width` how wide it is, in pixels. A label left out is still in its flag's tooltip.
export function labelsShown(at: number[], width: number[], gap = 4): boolean[] {
	let clear = -Infinity;
	return at.map((x, i) => {
		if (x < clear) return false;
		clear = x + width[i] + gap;
		return true;
	});
}

// A tempo as the lane writes it: whole, or to a tenth, which is as fine as a drag goes.
export const bpmText = (bpm: number) => String(Math.round(bpm * 100) / 100);

// The song's tempo in words, for the lane's label and a screen reader: "140 BPM, gliding to 100 by bar 3, 120 from bar 5".
export function tempoSummary(tempo: Tempo[], ppq: number): string {
	const order = [...tempo].sort((a, b) => a.tick - b.tick);
	if (!order.length) return '120 BPM';
	return order
		.map((change, at) => {
			if (at === 0) return `${bpmText(change.bpm)} BPM${change.tick > 0 ? ` from bar ${barOf(change.tick, ppq)}` : ''}`;
			const bar = barOf(change.tick, ppq);
			return order[at - 1].ramp
				? `gliding to ${bpmText(change.bpm)} by bar ${bar}`
				: `${bpmText(change.bpm)} from bar ${bar}`;
		})
		.join(', ');
}
