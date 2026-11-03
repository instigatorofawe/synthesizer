// What New timeline makes, as a DAW's template does: one track playing a built-in instrument, and an empty four-bar clip at
// bar 1, which the editor opens in the roll. So the keys play something at once, and a click in the roll adds a note that is
// heard. It is an ordinary timeline, which saves, undoes and compiles as any other, so nothing about it is special after that.
import { EMPTY_TIMELINE, type Timeline } from '#lib/Schema.ts';
import { addClip, addTrack, place } from '#lib/TimelineEdit.ts';
import { ticksPerBar } from '#lib/Units.ts';

// The tine electric piano Für Elise is played on. An electric piano is what Logic and GarageBand open a new song with: it
// sounds right on its own, with no insert or bus behind it, and it answers velocity. It has no recordings to fetch, so the
// first key plays as soon as the page has compiled it. A four-note chord at velocity 100 peaks near -5 dBFS, so nothing
// played on it reaches the limiter.
export const TEMPLATE_PATCH = 'builtin-FurElise-piano';
export const TEMPLATE_BARS = 4;

function template(): Timeline {
	const track = addTrack(EMPTY_TIMELINE, TEMPLATE_PATCH);
	const clip = addClip(track.doc, TEMPLATE_BARS * ticksPerBar(EMPTY_TIMELINE));
	return place(clip.doc, track.id, clip.id, 0);
}

export const NEW_TIMELINE: Timeline = template();
