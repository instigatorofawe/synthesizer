import type { Timeline } from '#lib/Schema.ts';

// Musical units, in one place: bars and beats, positions, note names and values, Snap's and Draw's choices, and what a
// musician types for each. The fields that hold a time, a pitch or a length read as music, and take what a musician would type. A position reads as
// bar.beat.tick, as the ghost note and the top bar's field do (`position` and Transport's `parsePosition`), a pitch as a name
// (`noteName`) and a length as a note value (`noteValue`). The document still holds ticks and MIDI numbers: these only read and
// write them.

// The grid is 4/4 and nothing stores that. A document holds ticks, so a time signature would change how it is drawn and
// nothing about how it plays.
export const BEATS_PER_BAR = 4;
export const ticksPerBar = (doc: Pick<Timeline, 'ppq'>) => doc.ppq * BEATS_PER_BAR;

// Snap's choices. A triplet, T, puts three in the time of two, so 1/8T is a third of a beat. Those this ppq can't hold in whole
// ticks are left out.
export function grids(ppq: number) {
	const each = (beats: number) => Math.max(1, Math.round(ppq * beats));
	const triplet = (label: string, beats: number) =>
		Number.isInteger(ppq * beats) && ppq * beats >= 1 ? [{ label, ticks: ppq * beats }] : [];
	return [
		{ label: 'Bar', ticks: each(BEATS_PER_BAR) },
		{ label: '1/4', ticks: each(1) },
		...triplet('1/4T', 2 / 3),
		{ label: '1/8', ticks: each(1 / 2) },
		...triplet('1/8T', 1 / 3),
		{ label: '1/16', ticks: each(1 / 4) },
		...triplet('1/16T', 1 / 6),
		{ label: '1/32', ticks: each(1 / 8) },
		{ label: 'Off', ticks: 1 }
	];
}

export const snapTick = (tick: number, grid: number) => Math.max(0, Math.round(tick / grid) * grid);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// With 60 as C4, which is what most tools show and all that a name can do here: the engine only sees the number.
export const noteName = (note: number) => `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
export const isBlackKey = (note: number) => NOTE_NAMES[note % 12].length > 1;

export const barOf = (tick: number, ppq: number) => Math.floor(tick / (ppq * BEATS_PER_BAR)) + 1;

// Where a tick falls as bar.beat.tick, with bars and beats counted from 1 and the tick from 0, as most DAWs show it: 1.4.000 is
// the last beat of the first bar.
export function position(tick: number, ppq: number): string {
	const beat = Math.floor(tick / ppq);
	const bar = Math.floor(beat / BEATS_PER_BAR) + 1;
	return `${bar}.${(beat % BEATS_PER_BAR) + 1}.${String(tick % ppq).padStart(3, '0')}`;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

// A length as a note value: 1/8, 3/16, 1 bar. A bar is a whole note, as 4/4 has it. A length that no note value down to a
// 1/128 can name, a triplet's or one typed in, stays in ticks.
export function noteValue(ticks: number, ppq: number): string {
	const whole = ppq * BEATS_PER_BAR;
	const common = gcd(ticks, whole);
	const [over, under] = [ticks / common, whole / common];
	const twos = (n: number) => n <= 128 && (n & (n - 1)) === 0;
	if (under === 1) return over === 1 ? '1 bar' : `${over} bars`;
	if (twos(under)) return `${over}/${under}`;
	// A triplet's third is in its denominator: a 1/8T, a third of a beat, is 1/12 of a bar. One or two of them read as a
	// triplet, down to a 1/32T, and more read as ticks, which says more than 25/32T would.
	if (under % 3 === 0 && twos(under / 3) && under <= 48 && over <= 2) return `${over}/${(under / 3) * 2}T`;
	return ticks === 1 ? '1 tick' : `${ticks} ticks`;
}

// What the Draw length offers, a 1/32 note to a bar, and the 1/16, 1/8 and 1/4 triplets: those this ppq can hold in whole
// ticks, shortest first.
export function drawLengths(ppq: number, triplets = true): { label: string; ticks: number }[] {
	const straight = [32, 16, 8, 4, 2, 1].map((under) => (ppq * BEATS_PER_BAR) / under);
	const thirds = triplets ? [24, 12, 6].map((under) => (ppq * BEATS_PER_BAR) / under) : [];
	return [...straight, ...thirds]
		.filter((ticks) => Number.isInteger(ticks))
		.sort((a, b) => a - b)
		.map((ticks) => ({ label: noteValue(ticks, ppq), ticks }));
}

// The Draw length one step shorter or longer than this one, which needn't be one of them. It stops at either end. [ and ] step
// through the straight lengths, so a triplet steps to the straight one beside it.
export function stepLength(ticks: number, ppq: number, by: -1 | 1): number {
	const lengths = drawLengths(ppq, false).map((length) => length.ticks);
	const next = by > 0 ? lengths.find((length) => length > ticks) : lengths.findLast((length) => length < ticks);
	return next ?? ticks;
}

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
// 1/8T (an eighth-note triplet), 2 bars, 1.5 bars, 1 bar + 1/4, 240 ticks. A bar is a whole note, as 4/4 has it, and a bare
// number is bars, the unit every length field reads in, as a length typed into Live or Logic is: a note value is a part of a
// bar. Ticks need the word, so a length no note value names can still be had. What isn't a whole number of ticks, or is less
// than `least`, is no length.
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
		const bars = /^(\d+(?:\.\d+)?|\.\d+)\s*(?:bars?)?$/.exec(term);
		const fraction = /^(\d+)\s*\/\s*(\d+)\s*(t?)\s*(\.*)$/.exec(term);
		const plain = /^(\d+)\s*ticks?$/.exec(term);
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
		`${quoted(text)} isn't a length. Type a note value, as 1/8 or 3/16, bars, as 2, or ticks, as 240 ticks.`,
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
