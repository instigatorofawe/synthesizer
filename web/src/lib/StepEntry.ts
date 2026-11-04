// Step entry, as most DAWs have it: the piano keys write notes at a cursor in the roll, each as long as the Draw length, so
// every start and length lands on the grid without the song playing or anyone keeping time. Keys held together make a chord,
// which is written once the last of them is let go, and the cursor then moves on past it. → with keys held makes their notes
// a Snap step longer, → on its own leaves a rest, Backspace takes back the last step, and ↑ and ↓ move its notes, to fix a
// wrong key.
//
// These are pure functions over a clip and a cursor, so they can be tested without a page. The roll wires them to keys.
import type { Bars } from '#lib/TimeSignature.ts';
import { growToHold, type Clip, type Note } from '#lib/TimelineEdit.ts';

// A step written: where it started and where it left the cursor, the notes it wrote, none for a rest, and the notes they
// took the place of. `grew` is the clip's length before and after, if the step grew it. All of it is so that taking the step
// back leaves the clip as it was.
export interface Step {
	start: number;
	end: number;
	notes: Note[];
	replaced: Note[];
	grew?: { from: number; to: number };
}

// Where the next step starts, in the clip's ticks, and the steps that brought the cursor there, the latest last.
export interface Cursor {
	tick: number;
	steps: Step[];
}

// A chord whose keys are down, or some of them: its notes, which all start at `start`, and the pitches still held.
export interface Chord {
	start: number;
	notes: Note[];
	held: number[];
}

// Where the cursor starts in a clip it hasn't been in.
export const START: Cursor = { tick: 0, steps: [] };

// The cursor put somewhere by hand. The steps before it are forgotten, so Backspace never takes back one that isn't behind it.
export const moveTo = (tick: number): Cursor => ({ tick: Math.max(0, tick), steps: [] });

// A key pressed: its note joins the chord being held, or starts one at the cursor. A key already in the chord, let go and
// pressed again while others are held, is held again and adds nothing.
export function press(chord: Chord | null, cursor: Cursor, pitch: number, length: number, velocity: number): Chord {
	const start = chord?.start ?? cursor.tick;
	const notes = chord?.notes ?? [];
	const held = chord?.held ?? [];
	if (held.includes(pitch)) return chord!;
	const there = notes.some((note) => note.note === pitch);
	return {
		start,
		notes: there ? notes : [...notes, { tick: start, note: pitch, vel: velocity, dur: length }],
		held: [...held, pitch]
	};
}

// → while keys are held: the notes they hold, and only those, `by` ticks longer.
export function lengthen(chord: Chord, by: number): Chord {
	return {
		...chord,
		notes: chord.notes.map((note) => (chord.held.includes(note.note) ? { ...note, dur: note.dur + by } : note))
	};
}

// A key let go. Once none is held, the chord is done and `write` puts it in the clip.
export function release(chord: Chord, pitch: number): Chord {
	return { ...chord, held: chord.held.filter((held) => held !== pitch) };
}

// Where a chord leaves the cursor: at the end of its longest note, which is the Draw length on unless → made it longer.
export const chordEnd = (chord: Chord) => Math.max(chord.start, ...chord.notes.map((note) => note.tick + note.dur));

const same = (a: Note, b: Note) => a.tick === b.tick && a.note === b.note && a.dur === b.dur && a.vel === b.vel;

// A chord written into the clip at its start, and the cursor moved on past it. A note already there at the same start and
// pitch gives way to the new one, so going over a passage again doesn't double it. The clip grows to the bar that holds the
// chord's start, by `bars` in the clip's ticks, as it does for a clicked note: whether it may is the caller's to ask first,
// with `canGrow`.
export function write(clip: Clip, cursor: Cursor, chord: Chord, bars: Bars): { clip: Clip; cursor: Cursor } {
	const grown = growToHold(clip, chord.start, bars);
	const pitches = new Set(chord.notes.map((note) => note.note));
	const replacing = (note: Note) => note.tick === chord.start && pitches.has(note.note);
	const end = chordEnd(chord);
	const step: Step = {
		start: chord.start,
		end,
		notes: chord.notes,
		replaced: grown.notes.filter(replacing),
		...(grown !== clip && { grew: { from: clip.length, to: grown.length } })
	};
	return {
		clip: { ...grown, notes: [...grown.notes.filter((note) => !replacing(note)), ...chord.notes] },
		cursor: { tick: end, steps: [...cursor.steps, step] }
	};
}

// → with no key held: a rest as long as the Draw length. It changes nothing in the clip.
export function rest(cursor: Cursor, length: number): Cursor {
	const end = cursor.tick + length;
	return { tick: end, steps: [...cursor.steps, { start: cursor.tick, end, notes: [], replaced: [] }] };
}

// Backspace: the last step taken back, and the cursor back where it started. The notes it wrote go, those of them still as
// it wrote them, the notes they replaced come back, and a clip it grew shrinks back if nothing else has been put in the part
// it grew by and nothing else has changed its length. With no step behind the cursor, the cursor goes back by the Draw length
// and nothing is deleted, so step entry never takes away a note it didn't write.
export function stepBack(clip: Clip, cursor: Cursor, length: number): { clip: Clip; cursor: Cursor } {
	const last = cursor.steps.at(-1);
	if (!last) return { clip, cursor: moveTo(cursor.tick - length) };
	const back = { tick: last.start, steps: cursor.steps.slice(0, -1) };
	const notes = [...clip.notes];
	for (const written of last.notes) {
		const at = notes.findIndex((note) => same(note, written));
		if (at >= 0) notes.splice(at, 1);
	}
	if (notes.length === clip.notes.length) return { clip, cursor: back };
	const restored = last.replaced.filter((note) => !notes.some((there) => same(there, note)));
	const kept = [...notes, ...restored];
	const shrinks = last.grew && clip.length === last.grew.to && kept.every((note) => note.tick < last.grew!.from);
	return {
		clip: { ...clip, notes: kept, length: shrinks ? last.grew!.from : clip.length },
		cursor: back
	};
}

// ↑ or ↓ after a step, to fix a wrong key: the notes it wrote, those still as it wrote them, `by` semitones up or down. The step
// keeps them as moved, so Backspace still takes them back. A move that would take one past 0 to 127 moves nothing, and neither
// does one after a rest.
export function repitch(clip: Clip, cursor: Cursor, by: number): { clip: Clip; cursor: Cursor } {
	const last = cursor.steps.at(-1);
	if (!last?.notes.length || last.notes.some((note) => note.note + by < 0 || note.note + by > 127)) {
		return { clip, cursor };
	}
	const notes = [...clip.notes];
	const moved: Note[] = [];
	for (const written of last.notes) {
		const at = notes.findIndex((note) => same(note, written));
		if (at < 0) continue; // Changed since, so no longer the step's to fix
		notes[at] = { ...notes[at], note: written.note + by }; // As the clip has it, with the slot a kit gave it (Kit.ts)
		moved.push(notes[at]);
	}
	if (!moved.length) return { clip, cursor };
	const step = { ...last, notes: moved };
	return { clip: { ...clip, notes }, cursor: { ...cursor, steps: [...cursor.steps.slice(0, -1), step] } };
}

// The velocity of new notes, which C and V step through 1, 10, 20 and so on to 120 and 127: a step is big enough to hear,
// and a dozen of them cover the range.
export const VELOCITY_STEP = 10;

export const clampVelocity = (velocity: number) => Math.min(127, Math.max(1, Math.round(velocity)));

export function stepVelocity(velocity: number, by: -1 | 1): number {
	const next =
		by > 0
			? (Math.floor(velocity / VELOCITY_STEP) + 1) * VELOCITY_STEP
			: (Math.ceil(velocity / VELOCITY_STEP) - 1) * VELOCITY_STEP;
	return clampVelocity(next);
}
