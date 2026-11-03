import { BEATS_PER_BAR, barOf, setTempo, songLength, tempoAt, ticksPerBar, type Tempo } from '#lib/TimelineEdit.ts';
import type { Timeline } from '#lib/Schema.ts';

// The top bar's position and tempo, typed into as fields. The position reads as the ghost note does, and the tempo is the one in
// effect at the playhead, so a song with several reads as each part of it plays.

// The loop until one is drawn: the whole song, and a bar of an empty one. It follows the song as it grows.
export function wholeSong(doc: Timeline): { start: number; end: number } {
	return { start: 0, end: Math.max(songLength(doc), ticksPerBar(doc)) };
}

export const MIN_BPM = 1;
export const MAX_BPM = 1000; // What the schema allows

// A position typed as bar.beat.tick, bars and beats counted from 1 and the tick from 0, as the ghost note and the field read it.
// A bar alone, or a bar and a beat, will do, and a space, a colon or a comma can stand for a dot. A beat past the bar's last or a
// tick past the beat's last is no position, rather than a guess at what was meant.
export function parsePosition(text: string, ppq: number): number | null {
	const parts = text.trim().split(/\s*[.:,]\s*|\s+/);
	if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
	const [bar, beat = 1, tick = 0] = parts.map(Number);
	if (bar < 1 || beat < 1 || beat > BEATS_PER_BAR || tick >= ppq) return null;
	return ((bar - 1) * BEATS_PER_BAR + beat - 1) * ppq + tick;
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
export function tempoWords(tempo: Tempo[], tick: number, ppq: number): string {
	const index = tempoIndexAt(tempo, tick);
	const change = tempo[index];
	if (!change) return 'The tempo';
	const to = rampTo(tempo, index);
	const bar = barOf(change.tick, ppq);
	if (to) {
		return (
			`Gliding from ${change.bpm} BPM at bar ${bar} to ${to.bpm} at bar ${barOf(to.tick, ppq)}. ` +
			'Typing sets where the glide starts.'
		);
	}
	if (tempo.length === 1) return "The song's tempo. Type another to change it.";
	return (
		`The tempo from bar ${bar}, one of the song's ${tempo.length} tempos. Typing changes this one, and the inspector ` +
		'lists them all.'
	);
}

// Whether the tempo is gliding at a tick, and which way.
export function gliding(tempo: Tempo[], tick: number): 'up' | 'down' | null {
	const index = tempoIndexAt(tempo, tick);
	const to = rampTo(tempo, index);
	if (!to || to.bpm === tempo[index].bpm || tick < tempo[index].tick) return null;
	return to.bpm > tempo[index].bpm ? 'up' : 'down';
}
