// The song's tempo, in one place: what it is at a tick, the edits to its list of changes, the top bar's field and words, and
// the Tempo lane's model.
//
// The Tempo lane in the song layer, apart from drawing it: what its gestures do to the song's tempo, how far up and down it
// reaches, and where a tempo is drawn. The song's tempo is a list of changes, each holding until the next or, marked `ramp`,
// gliding to it. The lane and the inspector's list are two views of that one list, so every edit here is one of the
// timeline's own, and undoes as any other does.
import type { Tempo } from '#lib/TimelineEdit.ts';
import type { Bars } from '#lib/TimeSignature.ts';
import type { Timeline } from '#lib/Schema.ts';

export const MIN_BPM = 1;
export const MAX_BPM = 1000; // What the schema allows

const byTick = (tempo: Tempo[]) => [...tempo].sort((a, b) => a.tick - b.tick);

// In order, and marked as a ramp only where a later change gives it somewhere to go, which the compiler insists on.
function tidy(tempo: Tempo[]): Tempo[] {
	const sorted = byTick(tempo);
	const last = sorted.at(-1)?.tick;
	return sorted.map(({ ramp, ...change }) => (ramp && change.tick !== last ? { ...change, ramp } : change));
}

// The tempo at a tick, as the compiler plays it: a change holds until the next, and a ramp glides to the next, linearly in
// bpm over ticks. The engine takes the ramp in steps of a 1/32 note, which this doesn't show. Before the first change it is
// the engine's own 120.
export function tempoAt(tempo: Tempo[], tick: number): number {
	const sorted = byTick(tempo);
	const at = sorted.findLastIndex((t) => t.tick <= tick);
	if (at < 0) return 120;
	const from = sorted[at];
	const to = sorted[at + 1];
	if (!from.ramp || !to) return from.bpm;
	return from.bpm + ((to.bpm - from.bpm) * (tick - from.tick)) / (to.tick - from.tick);
}

// A change added inside a ramp carries it on, so at the tempo the ramp had there, it leaves the curve as it was.
export function addTempo(doc: Timeline, tick: number, bpm: number): Timeline {
	if (doc.tempo.some((t) => t.tick === tick)) return doc;
	const before = byTick(doc.tempo).findLast((t) => t.tick < tick);
	const added: Tempo = before?.ramp ? { tick, bpm, ramp: true } : { tick, bpm };
	return { ...doc, tempo: tidy([...doc.tempo, added]) };
}

export function setTempo(doc: Timeline, index: number, change: Partial<Tempo>): Timeline {
	return { ...doc, tempo: tidy(doc.tempo.map((t, i) => (i === index ? { ...t, ...change } : t))) };
}

// The first one sets the tempo the song opens at, so it stays.
export function removeTempo(doc: Timeline, index: number): Timeline {
	return doc.tempo.length > 1 ? { ...doc, tempo: tidy(doc.tempo.filter((_, i) => i !== index)) } : doc;
}

// A tempo typed as a number of beats a minute, within what the schema allows.
export function parseBpm(text: string): number | null {
	const bpm = Number(text.trim());
	return text.trim() && Number.isFinite(bpm) && bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : null;
}

// Which of the song's tempo changes is in effect at a tick: the latest at or before it. Before the first, the engine plays its own
// 120 until the first change, and the first is what a tempo typed there changes, since that is where the song's own tempo starts.
export function tempoIndexAt(tempo: Tempo[], tick: number): number {
	let found = -1;
	tempo.forEach((change, index) => {
		if (change.tick <= tick && (found < 0 || change.tick >= tempo[found].tick)) found = index;
	});
	if (found >= 0) return found;
	return tempo.reduce((first, change, index) => (change.tick < tempo[first].tick ? index : first), 0);
}

// The change a ramp in effect at a tick glides to, if it is gliding there.
function rampTo(tempo: Tempo[], index: number): Tempo | undefined {
	const from = tempo[index];
	if (!from?.ramp) return undefined;
	return tempo.filter((change) => change.tick > from.tick).sort((a, b) => a.tick - b.tick)[0];
}

// What the tempo field shows at a tick: the tempo playing there, to a tenth of a bpm, which a ramp needs and a held tempo doesn't
// show. While it is typed into it shows the change being edited instead, which inside a ramp is where the glide starts.
export function shownTempo(tempo: Tempo[], tick: number, editing: boolean): number {
	if (editing) return tempo[tempoIndexAt(tempo, tick)]?.bpm ?? 120;
	return Math.round(tempoAt(tempo, tick) * 10) / 10;
}

// The tempo typed at a tick, as an edit: it changes the change in effect there and no other, so a song with several keeps them.
export function tempoTyped(doc: Timeline, tick: number, bpm: number): Timeline {
	const index = tempoIndexAt(doc.tempo, tick);
	return doc.tempo[index]?.bpm === bpm ? doc : setTempo(doc, index, { bpm });
}

// What the tempo field's tooltip says about the song's tempo at a tick, and what typing into it changes.
export function tempoWords(tempo: Tempo[], tick: number, bars: Bars): string {
	const index = tempoIndexAt(tempo, tick);
	const change = tempo[index];
	if (!change) return 'The tempo';
	const to = rampTo(tempo, index);
	const bar = bars.at(change.tick).number;
	// Each says where the rest is: the Tempo lane, above the tracks, which ▸ Tempo unfolds.
	const lane = 'The Tempo lane above the tracks, which ▸ Tempo unfolds,';
	if (to) {
		return (
			`Gliding from ${change.bpm} BPM at bar ${bar} to ${to.bpm} at bar ${bars.at(to.tick).number}. ` +
			`Typing sets where the glide starts. ${lane} draws the glide.`
		);
	}
	if (tempo.length === 1) {
		return `The song's tempo. Type another to change it. ${lane} takes more tempos and glides between them.`;
	}
	return `The tempo from bar ${bar}, one of the song's ${tempo.length} tempos. Typing changes this one. ${lane} draws them all.`;
}

// Whether the tempo is gliding at a tick, and which way.
export function gliding(tempo: Tempo[], tick: number): 'up' | 'down' | null {
	const index = tempoIndexAt(tempo, tick);
	const to = rampTo(tempo, index);
	if (!to || to.bpm === tempo[index].bpm || tick < tempo[index].tick) return null;
	return to.bpm > tempo[index].bpm ? 'up' : 'down';
}

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
// the tempo the song opens at, so it stays at its tick. The grid starts afresh at each of the song's `bars`, as Snap's does.
export function tempoTick(tempo: Tempo[], index: number, tick: number, grid: number, bars: Bars): number {
	const change = tempo[index];
	const { before, after } = neighbours(tempo, index);
	if (before < 0) return change.tick;
	const low = tempo[before].tick + 1;
	const high = after < 0 ? Infinity : tempo[after].tick - 1;
	const snapped = bars.snap(tick, grid);
	if (snapped >= low && snapped <= high) return snapped;
	const first = bars.ceil(low, grid);
	const last = high === Infinity ? Infinity : bars.floor(high, grid);
	if (first > last) return change.tick;
	return snapped < low ? first : last;
}

// A change dragged: to `bpm`, and sideways to where `tempoTick` says. It keeps whether it glides.
export function moveTempo(doc: Timeline, index: number, tick: number, bpm: number, grid: number, bars: Bars): Timeline {
	const change = doc.tempo[index];
	if (!change) return doc;
	const to = { tick: tempoTick(doc.tempo, index, tick, grid, bars), bpm };
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
export function tempoSummary(tempo: Tempo[], bars: Bars): string {
	const order = [...tempo].sort((a, b) => a.tick - b.tick);
	if (!order.length) return '120 BPM';
	return order
		.map((change, at) => {
			if (at === 0)
				return `${bpmText(change.bpm)} BPM${change.tick > 0 ? ` from bar ${bars.at(change.tick).number}` : ''}`;
			const bar = bars.at(change.tick).number;
			return order[at - 1].ramp
				? `gliding to ${bpmText(change.bpm)} by bar ${bar}`
				: `${bpmText(change.bpm)} from bar ${bar}`;
		})
		.join(', ');
}
