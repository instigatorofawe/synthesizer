import { describe, expect, it } from 'vitest';
import {
	START,
	chordEnd,
	clampVelocity,
	lengthen,
	moveTo,
	press,
	release,
	repitch,
	rest,
	stepBack,
	stepVelocity,
	write,
	type Chord,
	type Cursor
} from '#lib/StepEntry.ts';
import type { Clip, Note } from '#lib/TimelineEdit.ts';

const PPQ = 480;
const BAR = 4 * PPQ;
const EIGHTH = PPQ / 2;
const SIXTEENTH = PPQ / 4;

const clipOf = (notes: Note[] = [], length = BAR): Clip => ({ id: 'c', length, notes, automation: [], play: [] });
const note = (tick: number, pitch: number, dur = EIGHTH, vel = 100): Note => ({ tick, note: pitch, dur, vel });

// Keys pressed together at the cursor, and let go, the chord they make written in.
function chord(clip: Clip, cursor: Cursor, pitches: number[], length = EIGHTH, velocity = 100) {
	let held: Chord | null = null;
	for (const pitch of pitches) held = press(held, cursor, pitch, length, velocity);
	for (const pitch of pitches) held = release(held!, pitch);
	expect(held!.held).toEqual([]);
	return write(clip, cursor, held!, PPQ);
}

describe('writing a step', () => {
	it('writes one note at the cursor, as long as the Draw length, and moves the cursor on by it', () => {
		const written = chord(clipOf(), moveTo(BAR / 2), [60], EIGHTH, 90);
		expect(written.clip.notes).toEqual([note(BAR / 2, 60, EIGHTH, 90)]);
		expect(written.clip.length).toBe(BAR);
		expect(written.cursor.tick).toBe(BAR / 2 + EIGHTH);
		expect(written.cursor.steps).toHaveLength(1);
	});

	it('makes a chord of keys held together, which is written once the last is let go', () => {
		let held = press(null, START, 60, EIGHTH, 100);
		held = press(held, START, 64, EIGHTH, 100);
		held = release(held, 60);
		held = press(held, START, 67, EIGHTH, 100); // Still the same chord: 64 is held
		expect(held.held).toEqual([64, 67]);
		expect(held.notes.map((n) => [n.tick, n.note])).toEqual([
			[0, 60],
			[0, 64],
			[0, 67]
		]);
		held = release(release(held, 64), 67);
		const written = write(clipOf(), START, held, PPQ);
		expect(written.clip.notes).toHaveLength(3);
		expect(written.cursor.tick).toBe(EIGHTH);
	});

	it('holds a key again without writing its note twice', () => {
		let held = press(null, START, 60, EIGHTH, 100);
		held = press(held, START, 64, EIGHTH, 100);
		held = press(release(held, 60), START, 60, EIGHTH, 100);
		expect(held.notes).toHaveLength(2);
		expect(held.held).toEqual([64, 60]);
		expect(press(held, START, 64, EIGHTH, 100)).toBe(held);
	});

	it('makes the held notes, and only those, a Snap step longer for each →, and the cursor follows', () => {
		let held = press(null, START, 60, EIGHTH, 100);
		held = press(held, START, 64, EIGHTH, 100);
		held = lengthen(held, SIXTEENTH);
		held = release(held, 64);
		held = lengthen(held, SIXTEENTH);
		expect(held.notes.map((n) => n.dur)).toEqual([EIGHTH + 2 * SIXTEENTH, EIGHTH + SIXTEENTH]);
		expect(chordEnd(held)).toBe(EIGHTH + 2 * SIXTEENTH);
		const written = write(clipOf(), START, release(held, 60), PPQ);
		expect(written.cursor.tick).toBe(PPQ);
	});

	it('puts a new note in place of one already at the same start and pitch, and leaves other pitches', () => {
		const clip = clipOf([note(0, 60, PPQ, 50), note(0, 64), note(EIGHTH, 60)]);
		const written = chord(clip, START, [60]);
		expect(written.clip.notes).toEqual([note(0, 64), note(EIGHTH, 60), note(0, 60)]);
		expect(written.cursor.steps[0].replaced).toEqual([note(0, 60, PPQ, 50)]);
	});

	it('grows the clip to the bar that holds a step past its end, as a clicked note does', () => {
		const written = chord(clipOf(), moveTo(BAR), [60]);
		expect(written.clip.length).toBe(2 * BAR);
		expect(written.cursor.steps[0].grew).toEqual({ from: BAR, to: 2 * BAR });
		expect(chord(clipOf(), moveTo(BAR - EIGHTH), [60]).clip.length).toBe(BAR); // Its start is inside
	});
});

describe('a rest', () => {
	it('moves the cursor on by the Draw length and changes no note', () => {
		const cursor = rest(moveTo(EIGHTH), PPQ);
		expect(cursor.tick).toBe(EIGHTH + PPQ);
		expect(cursor.steps).toEqual([{ start: EIGHTH, end: EIGHTH + PPQ, notes: [], replaced: [] }]);
	});
});

describe('stepping back', () => {
	it('takes away the last step’s notes and puts the cursor where it started', () => {
		const first = chord(clipOf(), START, [60]);
		const second = chord(first.clip, first.cursor, [62, 65]);
		const back = stepBack(second.clip, second.cursor, EIGHTH);
		expect(back.clip.notes).toEqual(first.clip.notes);
		expect(back.cursor).toEqual(first.cursor);
		const again = stepBack(back.clip, back.cursor, EIGHTH);
		expect(again.clip.notes).toEqual([]);
		expect(again.cursor).toEqual(START);
	});

	it('takes a rest back by moving the cursor alone', () => {
		const written = chord(clipOf(), START, [60]);
		const rested = rest(written.cursor, PPQ);
		const back = stepBack(written.clip, rested, PPQ);
		expect(back.clip).toBe(written.clip);
		expect(back.cursor).toEqual(written.cursor);
	});

	it('moves back by the Draw length with no step behind the cursor, and deletes nothing', () => {
		const clip = clipOf([note(0, 60), note(EIGHTH, 62)]);
		const back = stepBack(clip, moveTo(PPQ), EIGHTH);
		expect(back.clip).toBe(clip);
		expect(back.cursor).toEqual(moveTo(EIGHTH));
		expect(stepBack(clip, moveTo(SIXTEENTH), EIGHTH).cursor.tick).toBe(0);
	});

	it('puts back what a step replaced, and leaves a note it wrote that has since been changed', () => {
		const old = note(0, 60, PPQ, 50);
		const written = chord(clipOf([old]), START, [60, 64]);
		expect(stepBack(written.clip, written.cursor, EIGHTH).clip.notes).toEqual([old]);

		// The 64 was moved up an octave by hand meanwhile, so it stays.
		const moved = { ...written.clip, notes: written.clip.notes.map((n) => (n.note === 64 ? { ...n, note: 76 } : n)) };
		expect(stepBack(moved, written.cursor, EIGHTH).clip.notes).toEqual([note(0, 76), old]);
	});

	it('shrinks a clip the step grew, unless something else is in the part it grew by or its length has changed', () => {
		const written = chord(clipOf(), moveTo(BAR), [60]);
		const back = stepBack(written.clip, written.cursor, EIGHTH);
		expect(back.clip.length).toBe(BAR);
		expect(back.clip.notes).toEqual([]);

		const more = { ...written.clip, notes: [...written.clip.notes, note(BAR + PPQ, 62)] };
		expect(stepBack(more, written.cursor, EIGHTH).clip.length).toBe(2 * BAR);
		const longer = { ...written.clip, length: 3 * BAR };
		expect(stepBack(longer, written.cursor, EIGHTH).clip.length).toBe(3 * BAR);
	});

	it('leaves a clip alone when the step’s notes are gone already, as after an undo', () => {
		const written = chord(clipOf(), START, [60]);
		const undone = clipOf();
		const back = stepBack(undone, written.cursor, EIGHTH);
		expect(back.clip).toBe(undone);
		expect(back.cursor).toEqual(START);
	});
});

describe('fixing the last step’s pitch', () => {
	it('moves the notes it wrote, and Backspace still takes them back', () => {
		const first = chord(clipOf([note(0, 40)]), moveTo(EIGHTH), [60, 64]);
		const up = repitch(first.clip, first.cursor, 1);
		expect(up.clip.notes.map((n) => n.note).sort()).toEqual([40, 61, 65]);
		expect(up.cursor.tick).toBe(first.cursor.tick);
		const octave = repitch(up.clip, up.cursor, -12);
		expect(octave.clip.notes.map((n) => n.note).sort()).toEqual([40, 49, 53]);
		const back = stepBack(octave.clip, octave.cursor, EIGHTH);
		expect(back.clip.notes).toEqual([note(0, 40)]);
	});

	it('moves nothing after a rest, past 0 to 127, or once its notes have been changed', () => {
		const written = chord(clipOf(), START, [120]);
		expect(repitch(written.clip, written.cursor, 12).clip).toBe(written.clip);
		const rested = rest(written.cursor, EIGHTH);
		expect(repitch(written.clip, rested, 1).clip).toBe(written.clip);
		const changed = { ...written.clip, notes: [note(0, 120, SIXTEENTH)] };
		expect(repitch(changed, written.cursor, 1).clip).toBe(changed);
	});
});

describe('moving the cursor by hand', () => {
	it('forgets the steps before it and stays at or after the start', () => {
		expect(moveTo(960)).toEqual({ tick: 960, steps: [] });
		expect(moveTo(-5).tick).toBe(0);
	});
});

describe('the velocity of new notes', () => {
	it('steps by tens, from 1 to 127', () => {
		expect(stepVelocity(100, 1)).toBe(110);
		expect(stepVelocity(100, -1)).toBe(90);
		expect(stepVelocity(105, 1)).toBe(110);
		expect(stepVelocity(105, -1)).toBe(100);
		expect(stepVelocity(120, 1)).toBe(127);
		expect(stepVelocity(127, 1)).toBe(127);
		expect(stepVelocity(127, -1)).toBe(120);
		expect(stepVelocity(10, -1)).toBe(1);
		expect(stepVelocity(1, -1)).toBe(1);
		expect(stepVelocity(1, 1)).toBe(10);
	});

	it('keeps a typed one in range', () => {
		expect(clampVelocity(0)).toBe(1);
		expect(clampVelocity(200)).toBe(127);
		expect(clampVelocity(64.4)).toBe(64);
	});
});
