// A clip's notes as a score writes them: in measures by the song's bars, on a treble staff, a bass staff or both, in voices
// where notes overlap, each note or rest a written value with its dots, tied across bar lines and beats, and spelled in the
// key. The clip holds ticks and MIDI numbers and nothing else, so this is a view of it, as the roll is: nothing here changes
// what plays. These are pure functions, so they can be tested without a page; Score.svelte draws what they give with VexFlow.
//
// A clip's notes have the lengths they were played or drawn with, which a score can't write exactly. A score shows them as
// they read, which is what Display quantize does in Cubase and Logic: each start and end goes to the nearest sixteenth, or the
// nearest eighth-note triplet in a beat whose notes fit triplets better, and a note is at least one of those long.
import type { Key } from '#lib/KeySignature.ts';
import { compound, pulseTicks, type Bar, type Bars, type Meter } from '#lib/TimeSignature.ts';

export type Letter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';

// A pitch as it is written: a letter, raised or lowered by `alter` semitones, in an octave, with C4 as middle C.
export interface Spelling {
	letter: Letter;
	alter: number;
	octave: number;
}

const LETTERS: Letter[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NATURAL = [0, 2, 4, 5, 7, 9, 11];
const SHARPS: Letter[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLATS: Letter[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const pc = (n: number) => ((n % 12) + 12) % 12;

// What a key does to each letter: +1 for a sharp in its signature, -1 for a flat.
export function signatureOf(fifths: number): Record<Letter, number> {
	const alters = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
	for (const letter of SHARPS.slice(0, Math.max(0, fifths))) alters[letter] = 1;
	for (const letter of FLATS.slice(0, Math.max(0, -fifths))) alters[letter] = -1;
	return alters;
}

const spelled = (note: number, letter: Letter, alter: number): Spelling => ({
	letter,
	alter,
	octave: Math.round((note - NATURAL[LETTERS.indexOf(letter)] - alter) / 12) - 1
});

// A MIDI note as a key writes it. A note of the key takes its letter. Any other is the letter below it raised or the letter
// above it lowered, whichever needs the smaller accidental, as a natural is smaller than a double sharp: so in E major a G is
// G natural, not F double sharp. Where both need one, it goes by where it is in the key, as the common chromatic notes are
// written: a major key raises its first, fourth and fifth and lowers its third and seventh, so C major writes C♯, E♭, F♯, G♯
// and B♭, and a minor key raises its third, fourth, sixth and seventh, as its leading notes do, and lowers its second.
export function spell(note: number, key: Key): Spelling {
	const alters = signatureOf(key.fifths);
	const at = pc(note);
	for (const letter of LETTERS) {
		if (pc(NATURAL[LETTERS.indexOf(letter)] + alters[letter]) === at) return spelled(note, letter, alters[letter]);
	}
	// Each letter that can write it with no more than a double sharp or flat, and the fewest such marks win.
	const candidates: Spelling[] = [];
	for (const letter of LETTERS) {
		const away = pc(at - NATURAL[LETTERS.indexOf(letter)]);
		const alter = away > 6 ? away - 12 : away;
		if (Math.abs(alter) <= 2) candidates.push(spelled(note, letter, alter));
	}
	const smallest = Math.min(...candidates.map((c) => Math.abs(c.alter)));
	const best = candidates.filter((c) => Math.abs(c.alter) === smallest);
	if (best.length === 1) return best[0];
	const raise = best.find((c) => c.alter > alters[c.letter]);
	const lower = best.find((c) => c.alter < alters[c.letter]);
	// Where the note is in the key, in semitones above its tonic.
	const tonic = pc(key.fifths * 7 + (key.minor ? 9 : 0));
	const degree = pc(at - tonic);
	const raised = key.minor ? [4, 6, 9, 11] : [1, 6, 8];
	return (raised.includes(degree) ? raise : lower) ?? best[0];
}

export const spellingText = (s: Spelling) =>
	`${s.letter}${s.alter > 0 ? '♯'.repeat(s.alter) : '♭'.repeat(-s.alter)}${s.octave}`;

// ---------------------------------------------------------------------------------------------------------- the model

export type Clef = 'treble' | 'bass';

// A written value: a whole note's 1, a half's 2, down to a sixty-fourth's 64, with dots, and in a triplet or not.
export interface Value {
	base: number;
	dots: number;
	triplet: boolean;
}

export interface Pitch {
	note: number; // The MIDI note
	index: number; // Its place in the clip's notes, so a click on it can choose it
	spelling: Spelling;
}

// A note, a chord or a rest in a voice: where it starts and how long it lasts as written, in the clip's ticks.
export interface Event {
	start: number;
	length: number;
	value: Value;
	pitches: Pitch[]; // None for a rest
	tieIn: boolean; // Held from the event before it
	tieOut: boolean; // Held into the event after it
	hidden?: boolean; // A rest in a voice other than the first, where it has nothing to say
	whole?: boolean; // A rest that fills its measure, which a score writes as a whole rest whatever the meter
}

export interface Measure {
	number: number;
	start: number; // Where it starts in the clip, its own ticks, or 0 for a bar the clip starts part way through
	end: number; // Where it ends, or the clip's end
	meter: Meter;
	key: Key;
	partial: boolean; // Shorter than its bar: a pickup, a bar a change cut short, or the clip starting or ending inside it
	meterShown: boolean; // The first, or the meter changed
	keyShown: boolean;
	voices: Event[][][]; // For each staff, each voice's events
	triplets: number[]; // The starts of its beats written as triplets
}

export interface Score {
	clefs: Clef[]; // One staff or two: treble over bass
	measures: Measure[];
}

// ------------------------------------------------------------------------------------------------------- quantizing

interface Placed {
	index: number;
	note: number;
	start: number;
	end: number;
}

const beatOf = (bar: Bar, tick: number) => bar.start + Math.floor((tick - bar.start) / bar.beat) * bar.beat;
const tripletsFit = (ppq: number, bar: Bar) => bar.beat === ppq && ppq % 3 === 0;

// Which beats are written as triplets: those whose starts and ends sit nearer an eighth-note triplet than a sixteenth.
function tripletBeats(notes: readonly { tick: number; dur: number }[], bars: Bars, ppq: number): Set<number> {
	const errors = new Map<number, { straight: number; triplet: number; count: number }>();
	const sixteenth = ppq / 4;
	const third = ppq / 3;
	for (const n of notes) {
		for (const tick of [n.tick, n.tick + n.dur]) {
			const bar = bars.at(tick);
			if (!tripletsFit(ppq, bar)) continue;
			const beat = beatOf(bar, tick);
			const into = tick - beat;
			if (into === 0) continue;
			const was = errors.get(beat) ?? { straight: 0, triplet: 0, count: 0 };
			was.straight += Math.abs(into - Math.round(into / sixteenth) * sixteenth);
			was.triplet += Math.abs(into - Math.round(into / third) * third);
			++was.count;
			errors.set(beat, was);
		}
	}
	const triplets = new Set<number>();
	for (const [beat, error] of errors) if (error.triplet + 1 < error.straight) triplets.add(beat);
	return triplets;
}

function snapIn(tick: number, bars: Bars, ppq: number, triplets: Set<number>): number {
	const bar = bars.at(tick);
	const beat = beatOf(bar, tick);
	const grid = triplets.has(beat) ? ppq / 3 : Math.min(bar.beat, Math.max(1, Math.round(ppq / 4)));
	return beat + Math.round((tick - beat) / grid) * grid;
}

function gridAt(tick: number, bars: Bars, ppq: number, triplets: Set<number>): number {
	const bar = bars.at(tick);
	return triplets.has(beatOf(bar, tick)) ? ppq / 3 : Math.min(bar.beat, Math.max(1, Math.round(ppq / 4)));
}

// ------------------------------------------------------------------------------------------------------- written values

function valuesOf(ppq: number): { ticks: number; value: Value }[] {
	const whole = ppq * 4;
	const out: { ticks: number; value: Value }[] = [];
	for (const base of [1, 2, 4, 8, 16, 32, 64]) {
		const ticks = whole / base;
		if (!Number.isInteger(ticks) || ticks < 1) continue;
		out.push({ ticks, value: { base, dots: 0, triplet: false } });
		if (base < 64 && Number.isInteger(ticks * 1.5))
			out.push({ ticks: ticks * 1.5, value: { base, dots: 1, triplet: false } });
	}
	return out.sort((a, b) => b.ticks - a.ticks);
}

// Whether a value can start at `offset` into a bar, as a score would write it there: one a beat long or longer starts on a
// beat, and one that lasts longer than that starts where it would divide the bar or ends with it; one shorter stays inside its
// beat. In a compound meter a beat is three of the meter's, and what is longer than one is whole beats of it. A rest keeps to
// the beats more strictly, as engravers have it: it starts where it divides the bar, and is dotted only in a compound meter,
// so beat 2 of a bar of 4/4 rests a quarter and then a half, not a dotted half.
function fits(offset: number, ticks: number, value: Value, bar: Bar, ppq: number, rest: boolean): boolean {
	const pulse = pulseTicks(ppq, bar.meter);
	const length = bar.beat * bar.meter.beats;
	const base = (ppq * 4) / value.base;
	const threes = compound(bar.meter);
	if (rest && value.dots && !(threes && ticks % pulse === 0)) return false;
	if (ticks >= pulse) {
		if (offset % pulse !== 0) return false;
		if (threes && ticks % pulse !== 0) return false;
		if (rest) return offset % ticks === 0 || (threes && offset % pulse === 0);
		if (value.dots) return offset % base === 0 || offset + ticks === length;
		return offset % ticks === 0 || offset + ticks === length;
	}
	if (Math.floor(offset / pulse) !== Math.floor((offset + ticks - 1) / pulse)) return false;
	return offset % Math.max(1, rest ? ticks : base / 2) === 0;
}

// The written values from `from` to `to`, inside one measure: the longest that fits at each place, then the next.
function written(
	from: number,
	to: number,
	bar: Bar,
	ppq: number,
	triplets: Set<number>,
	rest = false
): { start: number; length: number; value: Value }[] {
	const out: { start: number; length: number; value: Value }[] = [];
	const values = valuesOf(ppq);
	let at = from;
	while (at < to) {
		const beat = beatOf(bar, at);
		if (triplets.has(beat)) {
			const unit = ppq / 3;
			const end = Math.min(to, beat + bar.beat);
			if (at === beat && end === beat + bar.beat) {
				out.push({ start: at, length: bar.beat, value: { base: 4, dots: 0, triplet: false } });
			} else {
				const units = Math.max(1, Math.round((end - at) / unit));
				const length = Math.min(units, 2) * unit;
				out.push({ start: at, length, value: { base: length === 2 * unit ? 4 : 8, dots: 0, triplet: true } });
			}
			at += out.at(-1)!.length;
			continue;
		}
		// A straight beat ends where a triplet one starts, so a value never runs into one.
		let limit = to;
		for (let next = beat + bar.beat; next < to; next += bar.beat) {
			if (triplets.has(next)) {
				limit = next;
				break;
			}
		}
		const offset = at - bar.start;
		const choice =
			values.find((v) => at + v.ticks <= limit && fits(offset, v.ticks, v.value, bar, ppq, rest)) ??
			values.find((v) => at + v.ticks <= limit) ??
			values.at(-1)!;
		const length = Math.min(choice.ticks, limit - at);
		out.push({ start: at, length, value: choice.value });
		at += length;
	}
	return out;
}

// ------------------------------------------------------------------------------------------------------------ the score

// Which staff a note goes on, and in which clef: both staves, split at middle C, when the notes reach well above and below it,
// as a piano's do, and otherwise the one staff their middle sits in.
function clefsFor(notes: readonly number[]): { clefs: Clef[]; staffOf: (note: number) => number } {
	if (!notes.length) return { clefs: ['treble'], staffOf: () => 0 };
	const low = Math.min(...notes);
	const high = Math.max(...notes);
	if (low < 55 && high > 64) return { clefs: ['treble', 'bass'], staffOf: (note) => (note >= 60 ? 0 : 1) };
	const middle = [...notes].sort((a, b) => a - b)[Math.floor(notes.length / 2)];
	return { clefs: [middle >= 57 ? 'treble' : 'bass'], staffOf: () => 0 };
}

interface Chord {
	start: number;
	end: number;
	pitches: { index: number; note: number }[];
}

// Notes that start and end together make a chord, and chords that overlap go in voices of their own, the first free.
function voicesOf(placed: Placed[], most = 4): Chord[][] {
	const chords = new Map<string, Chord>();
	for (const p of placed) {
		const key = `${p.start}:${p.end}`;
		const chord = chords.get(key) ?? { start: p.start, end: p.end, pitches: [] };
		chord.pitches.push({ index: p.index, note: p.note });
		chords.set(key, chord);
	}
	const sorted = [...chords.values()].sort(
		(a, b) => a.start - b.start || Math.max(...b.pitches.map((p) => p.note)) - Math.max(...a.pitches.map((p) => p.note))
	);
	const voices: Chord[][] = [];
	for (const chord of sorted) {
		const free = voices.find((voice) => voice.at(-1)!.end <= chord.start);
		if (free) free.push(chord);
		else if (voices.length < most) voices.push([chord]);
		else {
			// No voice is free: the chord joins the one that ends first, from where it does, as it can be written.
			const voice = voices.reduce((a, b) => (a.at(-1)!.end <= b.at(-1)!.end ? a : b));
			const from = voice.at(-1)!.end;
			if (from < chord.end) voice.push({ ...chord, start: from });
		}
	}
	for (const voice of voices) for (const chord of voice) chord.pitches.sort((a, b) => a.note - b.note);
	return voices;
}

export interface Options {
	keyAt: (tick: number) => Key; // The key at a tick of the clip
}

// A clip's notes as a score: its measures by `bars`, in the clip's own ticks, from its start to its end.
export function transcribe(
	clip: { length: number; notes: readonly { tick: number; note: number; dur: number }[] },
	bars: Bars,
	options: Options
): Score {
	const ppq = bars.ppq;
	const shown = clip.notes.map((n, index) => ({ ...n, index })).filter((n) => n.tick >= 0 && n.tick < clip.length);
	const triplets = tripletBeats(shown, bars, ppq);
	const placed: Placed[] = shown.map((n) => {
		const start = Math.min(snapIn(n.tick, bars, ppq, triplets), clip.length - 1);
		const end = Math.min(
			clip.length,
			Math.max(snapIn(n.tick + n.dur, bars, ppq, triplets), start + gridAt(start, bars, ppq, triplets))
		);
		return { index: n.index, note: n.note, start, end: Math.max(end, start + 1) };
	});
	const { clefs, staffOf } = clefsFor(placed.map((p) => p.note));
	const staves = clefs.map((_, staff) => voicesOf(placed.filter((p) => staffOf(p.note) === staff)));

	const measures: Measure[] = [];
	let last: { meter: Meter; key: Key } | null = null;
	for (const bar of bars.between(0, clip.length)) {
		const start = Math.max(0, bar.start);
		const end = Math.min(bar.end, clip.length);
		if (end <= start) continue;
		const key = options.keyAt(start);
		const measure: Measure = {
			number: bar.number,
			start,
			end,
			meter: bar.meter,
			key,
			partial: start !== bar.start || end !== bar.start + bar.beat * bar.meter.beats,
			meterShown: !last || last.meter.beats !== bar.meter.beats || last.meter.unit !== bar.meter.unit,
			keyShown: !last || last.key.fifths !== key.fifths,
			voices: staves.map((voices) => {
				const lines = voices.length ? voices : [[]];
				return lines.map((voice, number) => eventsIn(voice, bar, start, end, number, ppq, triplets, key));
			}),
			triplets: [...triplets].filter((beat) => beat >= start && beat < end).sort((a, b) => a - b)
		};
		measures.push(measure);
		last = { meter: bar.meter, key };
	}
	return { clefs, measures };
}

function eventsIn(
	voice: Chord[],
	bar: Bar,
	start: number,
	end: number,
	number: number,
	ppq: number,
	triplets: Set<number>,
	key: Key
): Event[] {
	const events: Event[] = [];
	const rest = (from: number, to: number) => {
		const whole = from === start && to === end && !number;
		if (whole && from === bar.start && to === bar.end) {
			events.push({
				start: from,
				length: to - from,
				value: { base: 1, dots: 0, triplet: false },
				pitches: [],
				tieIn: false,
				tieOut: false,
				whole: true
			});
			return;
		}
		for (const piece of written(from, to, bar, ppq, triplets, true)) {
			events.push({ ...piece, pitches: [], tieIn: false, tieOut: false, ...(number > 0 && { hidden: true }) });
		}
	};
	let at = start;
	for (const chord of voice) {
		if (chord.end <= start || chord.start >= end) continue;
		const from = Math.max(chord.start, start);
		const to = Math.min(chord.end, end);
		if (from > at) rest(at, from);
		const pieces = written(from, to, bar, ppq, triplets);
		pieces.forEach((piece, i) => {
			events.push({
				...piece,
				pitches: chord.pitches.map((p) => ({ ...p, spelling: spell(p.note, key) })),
				tieIn: i > 0 || chord.start < from,
				tieOut: i < pieces.length - 1 || chord.end > to
			});
		});
		at = to;
	}
	if (at < end) rest(at, end);
	return events;
}
