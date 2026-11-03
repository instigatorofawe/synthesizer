import { describe, expect, it } from 'vitest';
import { newTake, recordNote, snapPlayed, type Played } from '#lib/Recording.ts';
import { EMPTY_TIMELINE, type Timeline } from '#lib/Schema.ts';
import { addClip, addTrack, place, setPlacement, type Clip, type Note } from '#lib/TimelineEdit.ts';

const PPQ = 480;
const BAR = 4 * PPQ;
const SIXTEENTH = PPQ / 4;

const played = (tick: number, length: number, note = 60, vel = 100, elapsed = tick): Played => ({
	note,
	vel,
	on: { tick, elapsed },
	off: { tick: tick + length, elapsed: elapsed + length }
});

// A song with one track and, if asked, a clip of `bars` placed on it at each of `at`.
function song(bars = 0, at: number[] = []): { doc: Timeline; track: number } {
	const track = addTrack(EMPTY_TIMELINE, 'lead');
	let doc = track.doc;
	if (bars) {
		const clip = addClip(doc, bars * BAR);
		doc = clip.doc;
		for (const tick of at) doc = place(doc, track.id, clip.id, tick);
	}
	return { doc, track: track.id };
}

const clip = (doc: Timeline, id = 'clip'): Clip => doc.clips.find((c) => c.id === id)!;
const note = (tick: number, pitch = 60, dur = SIXTEENTH, vel = 100): Note => ({ tick, note: pitch, vel, dur });

describe('snapping what was played', () => {
	it('puts the start on the nearest line of the grid, and the length in whole steps', () => {
		expect(snapPlayed(played(SIXTEENTH * 3 + 50, SIXTEENTH * 2 - 30), SIXTEENTH)).toEqual({
			tick: SIXTEENTH * 3,
			note: 60,
			vel: 100,
			dur: SIXTEENTH * 2
		});
		expect(snapPlayed(played(SIXTEENTH * 3 + 70, SIXTEENTH), SIXTEENTH)?.tick).toBe(SIXTEENTH * 4);
	});

	it('makes no note shorter than a step', () => {
		expect(snapPlayed(played(0, 5), SIXTEENTH)?.dur).toBe(SIXTEENTH);
		expect(snapPlayed(played(0, 0), PPQ)?.dur).toBe(PPQ);
	});

	it('takes the length from how far the song went, so a note held round a loop keeps it', () => {
		// Down a sixteenth before a one-bar loop's end, and up a sixteenth after it came round.
		const round: Played = {
			note: 60,
			vel: 100,
			on: { tick: BAR - SIXTEENTH, elapsed: 3 * BAR - SIXTEENTH },
			off: { tick: SIXTEENTH, elapsed: 3 * BAR + SIXTEENTH }
		};
		expect(snapPlayed(round, SIXTEENTH)).toMatchObject({ tick: BAR - SIXTEENTH, dur: 2 * SIXTEENTH });
	});

	it('leaves a note snapped before the start of the song out, and keeps one that snaps to it', () => {
		expect(snapPlayed(played(-PPQ, PPQ), SIXTEENTH)).toBeNull();
		expect(snapPlayed(played(-20, PPQ), SIXTEENTH)?.tick).toBe(0);
	});

	it("puts a note that snaps to a loop's end at its start, where the take goes on from", () => {
		const loop = { start: BAR, end: 2 * BAR };
		expect(snapPlayed(played(2 * BAR - 30, PPQ), PPQ, loop)?.tick).toBe(BAR);
		expect(snapPlayed(played(2 * BAR - 30, PPQ), PPQ)?.tick).toBe(2 * BAR);
		expect(snapPlayed(played(2 * BAR - 300, PPQ), PPQ, loop)?.tick).toBe(2 * BAR - PPQ);
	});

	it('takes Off as a grid of one tick', () => {
		expect(snapPlayed(played(1001, 333), 1)).toMatchObject({ tick: 1001, dur: 333 });
	});
});

describe('writing a note into the track', () => {
	it('goes into the clip placed where it was played, at that tick of the clip', () => {
		const { doc, track } = song(2, [BAR]);
		const done = recordNote(doc, newTake(track), { tick: BAR + PPQ, note: 64, vel: 90, dur: SIXTEENTH })!;
		expect(done.clip).toBe('clip');
		expect(clip(done.doc).notes).toEqual([note(PPQ, 64, SIXTEENTH, 90)]);
		expect(done.doc.clips).toHaveLength(1);
		expect(done.take.last).toEqual({ clip: 'clip', tick: BAR });
	});

	it('goes into the clip once from any repeat of it, and from the window a placement plays', () => {
		const { doc, track } = song(1, [0]);
		const repeated = setPlacement(doc, track, 0, { repeat: 4 });
		const done = recordNote(repeated, newTake(track), { tick: 2 * BAR + PPQ, note: 60, vel: 100, dur: SIXTEENTH })!;
		expect(clip(done.doc).notes).toEqual([note(PPQ)]);

		const windowed = setPlacement(doc, track, 0, { start: PPQ, length: 2 * PPQ, repeat: 2 });
		const there = recordNote(windowed, newTake(track), { tick: 3 * PPQ, note: 60, vel: 100, dur: SIXTEENTH })!;
		expect(clip(there.doc).notes).toEqual([note(2 * PPQ)]);
	});

	it('undoes a placement transpose and velocity, so it sounds as it was played', () => {
		const { doc, track } = song(1, [0]);
		const shifted = setPlacement(doc, track, 0, { transpose: 12, velocity: 0.5 });
		const done = recordNote(shifted, newTake(track), { tick: 0, note: 72, vel: 40, dur: SIXTEENTH })!;
		expect(clip(done.doc).notes).toEqual([note(0, 60, SIXTEENTH, 80)]);
	});

	it('replaces a note at the same start and pitch, and keeps any other', () => {
		const { doc, track } = song(1, [0]);
		const first = recordNote(doc, newTake(track), { tick: 0, note: 60, vel: 100, dur: SIXTEENTH })!;
		const other = recordNote(first.doc, first.take, { tick: 0, note: 64, vel: 100, dur: SIXTEENTH })!;
		const again = recordNote(other.doc, other.take, { tick: 0, note: 60, vel: 70, dur: PPQ })!;
		expect(clip(again.doc).notes).toEqual([note(0, 64), note(0, 60, PPQ, 70)]);
	});

	it('grows the clip it was writing into when played on past its end', () => {
		const { doc, track } = song(1, [0]);
		const inside = recordNote(doc, newTake(track), { tick: PPQ, note: 60, vel: 100, dur: SIXTEENTH })!;
		const past = recordNote(inside.doc, inside.take, { tick: BAR + PPQ, note: 62, vel: 100, dur: SIXTEENTH })!;
		expect(past.clip).toBe('clip');
		expect(clip(past.doc).length).toBe(2 * BAR);
		expect(clip(past.doc).notes).toEqual([note(PPQ), note(BAR + PPQ, 62)]);
	});

	it("doesn't grow a clip that repeats or would run into the next placement, and starts a clip instead", () => {
		const { doc, track } = song(1, [0, BAR]);
		const inside = recordNote(doc, newTake(track), { tick: BAR + PPQ, note: 60, vel: 100, dur: SIXTEENTH })!;
		const past = recordNote(inside.doc, inside.take, { tick: 2 * BAR + PPQ, note: 62, vel: 100, dur: SIXTEENTH })!;
		expect(clip(past.doc).length).toBe(BAR);
		expect(past.clip).not.toBe('clip');
		expect(clip(past.doc, past.clip)).toMatchObject({ length: BAR, notes: [note(PPQ, 62)] });

		const repeated = setPlacement(song(1, [0]).doc, track, 0, { repeat: 2 });
		const first = recordNote(repeated, newTake(track), { tick: PPQ, note: 60, vel: 100, dur: SIXTEENTH })!;
		const after = recordNote(first.doc, first.take, { tick: 2 * BAR, note: 62, vel: 100, dur: SIXTEENTH })!;
		expect(clip(after.doc).length).toBe(BAR);
		expect(after.clip).not.toBe('clip');
	});

	it('starts a clip of whole bars where nothing is placed, in the gap, which later notes grow', () => {
		const { doc, track } = song();
		const first = recordNote(doc, newTake(track), { tick: 2 * BAR + PPQ, note: 60, vel: 100, dur: SIXTEENTH })!;
		expect(first.doc.tracks[0].placements).toEqual([{ clip: first.clip, tick: 2 * BAR, repeat: 1 }]);
		expect(clip(first.doc, first.clip)).toMatchObject({ length: BAR, notes: [note(PPQ)] });
		const next = recordNote(first.doc, first.take, { tick: 3 * BAR + 2 * PPQ, note: 62, vel: 100, dur: SIXTEENTH })!;
		expect(next.clip).toBe(first.clip);
		expect(clip(next.doc, first.clip)).toMatchObject({ length: 2 * BAR, notes: [note(PPQ), note(BAR + 2 * PPQ, 62)] });
	});

	it('starts its clip after a placement that ends inside the bar, and ends it where the next one starts', () => {
		const { doc, track } = song();
		const short = addClip(doc, PPQ);
		let placed = place(short.doc, track, short.id, 0);
		const later = addClip(placed, BAR);
		placed = place(later.doc, track, later.id, 3 * PPQ);
		const done = recordNote(placed, newTake(track), { tick: 2 * PPQ, note: 60, vel: 100, dur: SIXTEENTH })!;
		const made = done.doc.tracks[0].placements.find((p) => p.clip === done.clip)!;
		expect(made.tick).toBe(PPQ);
		expect(clip(done.doc, done.clip)).toMatchObject({ length: 2 * PPQ, notes: [note(PPQ)] });
	});

	it('writes nothing for a track that has gone', () => {
		const { doc } = song(1, [0]);
		expect(recordNote(doc, newTake(99), { tick: 0, note: 60, vel: 100, dur: SIXTEENTH })).toBeNull();
	});
});
