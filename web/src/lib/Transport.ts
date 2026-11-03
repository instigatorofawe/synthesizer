import { songLength } from '#lib/TimelineEdit.ts';
import { ticksPerBar } from '#lib/Units.ts';
import type { Timeline } from '#lib/Schema.ts';

// The transport's own: where the song loops until a loop is drawn. The position and tempo fields read and write through Units.ts
// and Tempo.ts.

// The loop until one is drawn: the whole song, and a bar of an empty one. It follows the song as it grows.
export function wholeSong(doc: Timeline): { start: number; end: number } {
	return { start: 0, end: Math.max(songLength(doc), ticksPerBar(doc)) };
}
