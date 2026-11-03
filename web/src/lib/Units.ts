import { BEATS_PER_BAR, noteValue, position } from '#lib/TimelineEdit.ts';
import { parsePosition } from '#lib/Transport.ts';

// The fields that hold a time, a pitch or a length read as music, and take what a musician would type. A position reads as
// bar.beat.tick, as the ghost note and the top bar's field do (`position` and Transport's `parsePosition`), a pitch as a name
// (`noteName`) and a length as a note value (`noteValue`). The document still holds ticks and MIDI numbers: these only read and
// write them.

const LETTERS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// A pitch typed as a name, with sharps or flats, or as a MIDI number: E4, F#3, Bb2, D♭5 or 64. C4 is 60, as `noteName` has it,
// and what is past 0 to 127 is no pitch.
export function parsePitch(text: string): number | null {
	const typed = text.trim();
	const named = /^([a-g])\s*([#♯b♭]*)\s*(-?\d+)$/i.exec(typed);
	let note: number;
	if (/^\d+$/.test(typed)) note = Number(typed);
	else if (named) {
		const [, letter, accidentals, octave] = named;
		const by = [...accidentals].reduce((sum, mark) => sum + (mark === '#' || mark === '♯' ? 1 : -1), 0);
		note = (Number(octave) + 1) * 12 + LETTERS[letter.toLowerCase()] + by;
	} else return null;
	return note >= 0 && note <= 127 ? note : null;
}

// A length typed as a note value, as bars or as ticks, or as several of those added together: 1/8, 3/16, 1/8. (a dotted 1/8),
// 1/8T (an eighth-note triplet),
// 2 bars, 1.5 bars, 1 bar + 1/4, 240 ticks. A bare number is ticks, so a length no note value names can still be had. A bar is a
// whole note, as 4/4 has it. What isn't a whole number of ticks, or is less than `least`, is no length.
export function parseLength(text: string, ppq: number, least = 1): number | null {
	const whole = ppq * BEATS_PER_BAR;
	const terms = text
		.trim()
		.toLowerCase()
		.replace(/(bars?|ticks?)\s+(?=\d)/g, '$1 + ')
		.split('+')
		.map((term) => term.trim());
	let ticks = 0;
	for (const term of terms) {
		const bars = /^(\d+(?:\.\d+)?|\.\d+)\s*bars?$/.exec(term);
		const fraction = /^(\d+)\s*\/\s*(\d+)\s*(t?)\s*(\.*)$/.exec(term);
		const plain = /^(\d+)(?:\s*ticks?)?$/.exec(term);
		if (bars) ticks += Number(bars[1]) * whole;
		else if (fraction && Number(fraction[2]) > 0) {
			const third = fraction[3] ? 2 / 3 : 1; // A triplet, 1/8T, is three in the time of two
			const dots = fraction[4].length; // Each dot adds half of what came before it
			ticks += ((Number(fraction[1]) * whole) / Number(fraction[2])) * third * (2 - 2 ** -dots);
		} else if (plain) ticks += Number(plain[1]);
		else return null;
	}
	const rounded = Math.round(ticks);
	return Math.abs(ticks - rounded) < 1e-9 && rounded >= least ? rounded : null;
}

// A clip's length or a window's, which reads in bars: whole bars, and past a bar, the bars and what is left as a note value. Less
// than a bar is a note value, and what no note value names is ticks.
export function barLength(ticks: number, ppq: number): string {
	const bar = ppq * BEATS_PER_BAR;
	const bars = Math.floor(ticks / bar);
	const left = ticks - bars * bar;
	return bars && left ? `${noteValue(bars * bar, ppq)} + ${noteValue(left, ppq)}` : noteValue(ticks, ppq);
}

// The note values a note's length or a ramp is chosen from: a 1/32 to two bars, dotted ones and triplets too, as far as this ppq
// holds them.
export function noteLengths(ppq: number): string[] {
	const values = [1 / 32, 1 / 24, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 3 / 16, 1 / 4, 3 / 8, 1 / 2, 3 / 4, 1, 2];
	return lengthsOf(values, ppq);
}

// The lengths a clip or a window is chosen from, in bars.
export function barLengths(ppq: number): string[] {
	return lengthsOf([1 / 4, 1 / 2, 1, 2, 3, 4, 8, 16], ppq);
}

function lengthsOf(bars: number[], ppq: number): string[] {
	return bars
		.map((fraction) => fraction * ppq * BEATS_PER_BAR)
		.filter((ticks) => Number.isInteger(ticks))
		.map((ticks) => noteValue(ticks, ppq));
}

// What a field says when what was typed into it isn't what it holds, and what to type instead.
const quoted = (text: string) => `“${text.trim()}”`;
export const refusals = {
	position: (text: string) => `${quoted(text)} isn't a position. Type bar.beat.tick, as 3.2.000, or a bar.`,
	pitch: (text: string) =>
		`${quoted(text)} isn't a pitch. Type a note, as E4, F#3 or Bb2, or a MIDI number from 0 to 127.`,
	length: (text: string) =>
		`${quoted(text)} isn't a length. Type a note value, as 1/8 or 3/16, bars, as 2 bars, or ticks, as 240.`,
	// A position in a clip that is past its end, which is where nothing in the clip can start.
	pastEnd: (text: string, length: number, ppq: number) =>
		`${quoted(text)} is past the clip's end, at ${position(length, ppq)}. Type a position before it.`
};

// How a field reads what was typed into it: as the value it holds, or as what to say about it. A position in a clip comes
// before `end`, the clip's length, where one is given.
export const readPosition =
	(ppq: number, end?: number) =>
	(text: string): number | string => {
		const at = parsePosition(text, ppq);
		if (at === null) return refusals.position(text);
		return end !== undefined && at >= end ? refusals.pastEnd(text, end, ppq) : at;
	};

export const readPitch = (text: string): number | string => parsePitch(text) ?? refusals.pitch(text);

export const readLength =
	(ppq: number, least = 1) =>
	(text: string): number | string =>
		parseLength(text, ppq, least) ?? refusals.length(text);
