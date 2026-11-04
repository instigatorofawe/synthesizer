// Recording with snap, as Live and Logic have it: the song plays, and what the piano keys play is written into the chosen
// track as it is played. Each note's start goes to the nearest line of the grid, so a phrase played in lands on the grid as step
// entry's notes do, and it keeps the length it was played for, as theirs do, so a short note stays short whatever Snap is.
//
// The worklet says when each key went down and came up, as the tick of the song that was being heard then, so the output's
// latency and the time a key takes to reach it don't move a note. These are pure functions from those stamps and a document
// to a document, so they can be tested without a page.
import { withKitSlots } from '#lib/Kit.ts';
import { barsOf, type Bars } from '#lib/TimeSignature.ts';
import type { Timeline } from '#lib/Schema.ts';
import {
	addClip,
	canGrow,
	drawnClip,
	growToHold,
	place,
	placementSpan,
	setClip,
	windowOf,
	type Clip,
	type Note,
	type Placement
} from '#lib/TimelineEdit.ts';

// When a key went down or came up: the song's tick that was being heard then, and how many ticks the song had played since
// the take began. `elapsed` keeps counting through a loop's wrap, so a note held across it has its length.
export interface Stamp {
	tick: number;
	elapsed: number;
}

// A note as it was played, before it was snapped.
export interface Played {
	note: number;
	vel: number;
	on: Stamp;
	off: Stamp;
}

// A note snapped to the grid, at a tick of the song. Null if it starts before the song does, which only a key pressed early in
// the count-in can. Round a loop, a note played just before it comes round that snaps to its end goes at its start, since that
// is where the take goes on from. The grid starts afresh at each bar of `bars`, the song's, as Snap's does.
export function snapPlayed(
	played: Played,
	grid: number,
	loop: { start: number; end: number } | null = null,
	bars: Bars = barsOf({ ppq: 480 })
): { tick: number; note: number; vel: number; dur: number } | null {
	const step = bars.step(0, grid);
	let tick =
		played.on.tick < 0
			? Math.round(played.on.tick / step) * step + 0 // + 0 so a key just before the start writes 0, not -0
			: bars.snap(played.on.tick, grid);
	if (loop && loop.end > loop.start && played.on.tick < loop.end && tick >= loop.end) tick -= loop.end - loop.start;
	if (tick < 0) return null;
	const dur = Math.max(1, Math.round(played.off.elapsed - played.on.elapsed));
	return { tick, note: played.note, vel: played.vel, dur };
}

// A take: the track it writes into, and the placement it wrote into last, which a note played past the end of grows.
export interface Take {
	track: number;
	last: { clip: string; tick: number } | null;
}

export const newTake = (track: number): Take => ({ track, last: null });

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

// The note a placement plays as `played`: back through its transpose and its velocity's scale, so that it sounds as it was
// played.
function inClip(placed: Placement, played: { note: number; vel: number; dur: number }, tick: number): Note {
	const scale = placed.velocity ?? 1;
	return {
		tick,
		note: clamp(played.note - (placed.transpose ?? 0), 0, 127),
		vel: clamp(Math.round(scale > 0 ? played.vel / scale : played.vel), 1, 127),
		dur: played.dur
	};
}

// A note added to a clip. One already there at the same start and pitch gives way to it, as in step entry, so playing a
// passage again round a loop doesn't double it.
function withNote(clip: Clip, note: Note): Clip {
	const kept = clip.notes.filter((there) => there.tick !== note.tick || there.note !== note.note);
	return { ...clip, notes: [...kept, note] };
}

// A note written where the take is, at a tick of the song: into the clip placed there on the take's track, at the tick of that
// clip it plays there, so a note in a repeat or round a loop goes into the clip once. Played past the end of the placement the
// take wrote into last, it grows that clip to the bar that holds it, if nothing else plays it and growing runs into nothing,
// as a clicked note does. Anywhere else it starts a clip of its own, of whole bars in the gap it was played in, which later
// notes grow. Null if it has nowhere to go. On a kit track the note plays its key's slot, as every edit's notes do (Kit.ts).
export function recordNote(
	doc: Timeline,
	take: Take,
	note: { tick: number; note: number; vel: number; dur: number }
): { doc: Timeline; take: Take; clip: string } | null {
	const written = writeNote(doc, take, note);
	return written && { ...written, doc: withKitSlots(written.doc) };
}

function writeNote(
	doc: Timeline,
	take: Take,
	note: { tick: number; note: number; vel: number; dur: number }
): { doc: Timeline; take: Take; clip: string } | null {
	const track = doc.tracks.find((t) => t.id === take.track);
	if (!track) return null;
	const clipOf = (id: string) => doc.clips.find((clip) => clip.id === id);
	const write = (placed: Placement, at: number) => {
		const clip = clipOf(placed.clip);
		if (!clip) return null;
		const grown = growToHold(clip, at, barsOf(doc).shifted(placed.tick, true));
		if (grown !== clip && !canGrow(doc, clip.id, grown.length)) return null;
		return {
			doc: setClip(doc, clip.id, withNote(grown, inClip(placed, note, at))),
			take: { ...take, last: { clip: clip.id, tick: placed.tick } },
			clip: clip.id
		};
	};

	const under = track.placements.find(
		(placed) => placed.tick <= note.tick && note.tick < placed.tick + placementSpan(doc, placed)
	);
	if (under) {
		const { start, length } = windowOf(doc, under);
		return length > 0 ? write(under, start + ((note.tick - under.tick) % length)) : null;
	}

	const last = take.last && track.placements.find((p) => p.clip === take.last!.clip && p.tick === take.last!.tick);
	const whole = last && last.repeat === 1 && !last.start && last.length === undefined;
	if (last && whole && note.tick >= last.tick) {
		const grown = write(last, note.tick - last.tick);
		if (grown) return grown;
	}

	const room = drawnClip(doc, take.track, note.tick, note.tick);
	if (!room) return null;
	const made = addClip(doc, room.length);
	const placed = place(made.doc, take.track, made.id, room.tick);
	const clip = placed.clips.find((c) => c.id === made.id)!;
	const written = inClip({ clip: made.id, tick: room.tick, repeat: 1 }, note, note.tick - room.tick);
	return {
		doc: setClip(placed, made.id, withNote(clip, written)),
		take: { ...take, last: { clip: made.id, tick: room.tick } },
		clip: made.id
	};
}
