// Bars and beats as a song's time signatures and its pickup lay them out. A document holds ticks, and these say where its
// bars fall: the ruler numbers them, the grids snap to them, positions read in them and the click counts them. None of it
// reaches the compiler, which ignores `meter` and `pickup` as it ignores where a node is drawn, so a time signature changes
// how a song is drawn and edited and never how it plays.
//
// A change starts a bar where it is. One that falls inside a bar of the meter before it cuts that bar short, as Live and
// Bitwig do, so no tick is ever left out of a bar and moving a change never needs the others to move. A pickup is the end
// of a bar of the first meter, numbered 0, so the first whole bar is bar 1, as a score numbers it. Before tick 0 the first
// meter carries on backwards, which is what a clip played from part way through, at the start of the song, has before it.
//
// `Bars` works in any frame: `origin` is the song's tick at the frame's 0, so the roll can ask in a clip's own ticks.
import type { Timeline } from '#lib/Schema.ts';

export interface Meter {
	beats: number; // How many in a bar, the signature's upper figure
	unit: number; // What a beat is, its lower figure: 4 for a quarter, 8 for an eighth
}
export type MeterChange = Meter & { tick: number };

export const COMMON: Meter = { beats: 4, unit: 4 };
export const UNITS = [1, 2, 4, 8, 16, 32] as const;
export const MOST_BEATS = 64;

export interface Bar {
	number: number; // As the ruler numbers it: 1 is the first whole bar, and a pickup is 0
	start: number; // Where its meter's bar starts, which for a pickup is before the song does
	end: number; // Where the next bar starts, which a change can make sooner than its meter says
	meter: Meter;
	beat: number; // Ticks in one of its beats
}

export const meterText = (meter: Meter) => `${meter.beats}/${meter.unit}`;
export const sameMeter = (a: Meter, b: Meter) => a.beats === b.beats && a.unit === b.unit;
export const beatTicks = (ppq: number, unit: number) => (ppq * 4) / unit;
export const barTicks = (ppq: number, meter: Meter) => meter.beats * beatTicks(ppq, meter.unit);

// Whether a meter is compound, as 6/8, 9/8 and 12/8 are: its beats go in threes, and the click and the count-in follow the
// threes, as a conductor beats 6/8 in two.
export const compound = (meter: Meter) => meter.beats > 3 && meter.beats % 3 === 0 && meter.unit >= 8;

// Ticks between the clicks of the metronome in a meter: a beat, or three of them in a compound meter.
export const pulseTicks = (ppq: number, meter: Meter) => beatTicks(ppq, meter.unit) * (compound(meter) ? 3 : 1);

// Whether a ppq can hold a meter's beat in whole ticks. A song at 480 holds them all.
export const holds = (ppq: number, unit: number) => Number.isInteger(beatTicks(ppq, unit));

interface Segment {
	from: number; // The song's tick the meter starts at, or -Infinity for the first
	to: number; // Where the next one starts
	meter: Meter;
	length: number; // Ticks in a whole bar of it
	beat: number;
	anchor: number; // A tick its bars start on
	first: number; // The number of the bar that starts on `anchor`
}

export class Bars {
	readonly #segments: Segment[];

	readonly #offset: number; // Added to the song's bar numbers, so a clip can count its bars from its own first

	private constructor(
		readonly ppq: number,
		segments: Segment[],
		readonly origin: number,
		offset = 0
	) {
		this.#segments = segments;
		this.#offset = offset;
	}

	// The bars a list of changes and a pickup make. A change that can't be held in whole ticks, or that comes at or before the
	// one before it, is left out, and so 4/4 is what plays until a change says otherwise.
	static of(ppq: number, changes: readonly MeterChange[] = [], pickup = 0, origin = 0): Bars {
		const sorted = [...changes]
			.filter((change) => holds(ppq, change.unit) && change.beats >= 1)
			.sort((a, b) => a.tick - b.tick);
		const head = sorted[0] && sorted[0].tick <= 0 ? sorted.shift()! : { tick: 0, ...COMMON };
		const length = barTicks(ppq, head);
		const lead = Math.max(0, Math.min(Math.round(pickup), length - 1));
		const segments: Segment[] = [
			{
				from: -Infinity,
				to: Infinity,
				meter: pick(head),
				length,
				beat: beatTicks(ppq, head.unit),
				anchor: lead,
				first: 1
			}
		];
		for (const change of sorted) {
			const last = segments.at(-1)!;
			if (change.tick <= Math.max(0, last.from)) continue;
			const bar = barIn(last, change.tick);
			last.to = change.tick;
			segments.push({
				from: change.tick,
				to: Infinity,
				meter: pick(change),
				length: barTicks(ppq, change),
				beat: beatTicks(ppq, change.unit),
				anchor: change.tick,
				first: bar.start === change.tick ? bar.number : bar.number + 1
			});
		}
		return new Bars(ppq, segments, origin);
	}

	// The same bars, asked about and answered in a frame whose 0 is the song's tick `origin`. A clip's own frame also counts
	// its bars from its own, `renumber`: the bar its tick 0 is in is bar 1, as the roll numbers them.
	shifted(origin: number, renumber = false): Bars {
		const offset = renumber ? 1 - barIn(this.#segmentAt(origin), origin).number : 0;
		return new Bars(this.ppq, this.#segments, origin, offset);
	}

	#segmentAt(song: number): Segment {
		const segments = this.#segments;
		for (let i = segments.length - 1; i > 0; --i) if (song >= segments[i].from) return segments[i];
		return segments[0];
	}

	#segment(song: number): Segment {
		return this.#segmentAt(song);
	}

	#local(bar: Bar): Bar {
		if (!this.origin && !this.#offset) return bar;
		return { ...bar, number: bar.number + this.#offset, start: bar.start - this.origin, end: bar.end - this.origin };
	}

	// The bar a tick is in.
	at(tick: number): Bar {
		return this.#local(barIn(this.#segment(tick + this.origin), tick + this.origin));
	}

	// The bar with this number, or null for one the song doesn't have.
	numbered(shown: number): Bar | null {
		const number = shown - this.#offset;
		const segments = this.#segments;
		let segment = segments[0];
		for (const next of segments.slice(1)) if (number >= next.first) segment = next;
		const start = segment.anchor + (number - segment.first) * segment.length;
		if (start >= segment.to) return null;
		const bar = barIn(segment, start);
		return bar.number === number ? this.#local(bar) : null;
	}

	// The bars that have any of the ticks from `from` up to `to`, at most `most` of them.
	between(from: number, to: number, most = 2000): Bar[] {
		const bars: Bar[] = [];
		let bar = this.at(from);
		while (bar.start < to && bars.length < most) {
			bars.push(bar);
			bar = this.at(bar.end);
		}
		return bars;
	}

	// The meter playing at a tick.
	meterAt(tick: number): Meter {
		return this.#segment(tick + this.origin).meter;
	}

	// The tick nearest `tick` on a grid of `grid` ticks that starts afresh at every bar, and never before 0. So a grid as long as a
	// bar or longer snaps to bar lines in any meter, and a beat grid keeps to the beats a bar has, past a pickup or a bar a
	// change cut short. In 4/4 from tick 0 it is every multiple of the grid, as it always was.
	snap(tick: number, grid: number): number {
		const bar = this.at(tick);
		const step = Math.max(1, grid);
		// A pickup's bar starts before the song does, and the song's start is a line of its own.
		const open = -this.origin;
		let below = bar.start + Math.floor((tick - bar.start) / step) * step;
		if (bar.start < open && open <= tick) below = Math.max(below, open);
		const above = Math.min(bar.start + (Math.floor((tick - bar.start) / step) + 1) * step, bar.end);
		return Math.max(0, tick - below < above - tick ? below : above);
	}

	// The line at or before `tick` on that grid.
	floor(tick: number, grid: number): number {
		const bar = this.at(tick);
		const step = Math.max(1, grid);
		const line = bar.start + Math.floor((tick - bar.start) / step) * step;
		return Math.max(0, bar.start < -this.origin && -this.origin <= tick ? Math.max(line, -this.origin) : line);
	}

	// The line at or after `tick` on that grid.
	ceil(tick: number, grid: number): number {
		const line = this.floor(tick, grid);
		if (line >= tick) return line;
		const bar = this.at(tick);
		const step = Math.max(1, grid);
		return Math.min(bar.start + (Math.floor((tick - bar.start) / step) + 1) * step, bar.end);
	}

	// A grid step at a tick, as a length: the grid, or its bar if the grid is longer.
	step(tick: number, grid: number): number {
		const bar = this.at(tick);
		return Math.min(Math.max(1, grid), bar.end - bar.start);
	}

	// Where the bar `count` bars after the one `tick` is in starts.
	after(tick: number, count: number): number {
		let bar = this.at(tick);
		for (let n = 0; n < count; ++n) bar = this.at(bar.end);
		return bar.start;
	}

	// The whole bars from the start of the one `from` is in to the end of the one `to` is in, either way round, and never
	// before 0.
	whole(from: number, to: number): { start: number; end: number } {
		const [a, b] = from <= to ? [from, to] : [to, from];
		return { start: Math.max(0, this.at(a).start), end: this.at(b).end };
	}

	// Where a tick falls as bar.beat.tick, bars and beats counted from 1 and the tick from 0, as most DAWs show it: 1.4.000 is
	// the last beat of a bar of 4/4, and in 3/8 after an eighth's pickup the song starts at 0.3.000.
	position(tick: number): string {
		const bar = this.at(tick);
		const into = tick - bar.start;
		const beat = Math.floor(into / bar.beat);
		return `${bar.number}.${beat + 1}.${String(Math.round(into - beat * bar.beat)).padStart(3, '0')}`;
	}

	// A position typed as bar.beat.tick, as `position` writes it. A bar alone, or a bar and a beat, will do, and a space, a
	// colon or a comma can stand for a dot. A beat past the bar's last, a tick past the beat's last, or a place the song
	// doesn't have, before its start or past where a change cut a bar short, is no position rather than a guess at what was
	// meant.
	parse(text: string): number | null {
		const parts = text.trim().split(/\s*[.:,]\s*|\s+/);
		if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
		const [number, beat = 1, tick = 0] = parts.map(Number);
		const bar = this.numbered(number);
		if (!bar || beat < 1 || beat > bar.meter.beats || tick >= bar.beat) return null;
		const at = bar.start + (beat - 1) * bar.beat + tick;
		return at < -this.origin || at >= bar.end ? null : at;
	}

	// The clicks from `from` up to `to`, each a tick and whether it starts a bar.
	clicks(from: number, to: number): { tick: number; accent: boolean }[] {
		const clicks: { tick: number; accent: boolean }[] = [];
		for (const bar of this.between(from, to)) {
			const pulse = pulseTicks(this.ppq, bar.meter);
			for (let at = bar.start; at < bar.end; at += pulse) {
				if (at >= from && at < to) clicks.push({ tick: at, accent: at === bar.start });
			}
		}
		return clicks;
	}

	// The meters as the worklet's click takes them, in the song's ticks: where each starts, a whole bar's length, a pulse's,
	// and a tick its bars start on.
	segments(): { from: number; bar: number; pulse: number; anchor: number }[] {
		return this.#segments.map((segment) => ({
			from: Number.isFinite(segment.from) ? segment.from : -1e15,
			bar: segment.length,
			pulse: pulseTicks(this.ppq, segment.meter),
			anchor: segment.anchor
		}));
	}
}

const pick = (meter: Meter): Meter => ({ beats: meter.beats, unit: meter.unit });

function barIn(segment: Segment, tick: number): Bar {
	const k = Math.floor((tick - segment.anchor) / segment.length);
	const start = segment.anchor + k * segment.length;
	return {
		number: segment.first + k,
		start,
		end: Math.min(start + segment.length, segment.to),
		meter: segment.meter,
		beat: segment.beat
	};
}

// A song's bars, from what its document says: 4/4 from tick 0 if it says nothing.
export const barsOf = (doc: Pick<Timeline, 'ppq' | 'meter' | 'pickup'>, origin = 0) =>
	Bars.of(doc.ppq, doc.meter ?? [], doc.pickup ?? 0, origin);

// ------------------------------------------------------------------------------------------------------------------ edits

// A song's time signatures in order, the first at tick 0, as the inspector lists them.
export function metersOf(doc: Pick<Timeline, 'meter'>): MeterChange[] {
	const sorted: MeterChange[] = [...(doc.meter ?? [])].sort((a, b) => a.tick - b.tick);
	if (!sorted.length || sorted[0].tick > 0) sorted.unshift({ tick: 0, ...COMMON });
	return sorted;
}

// A document says only what differs from 4/4 from tick 0 with no pickup, so a song stays as it was until someone changes one.
// A pickup as long as the first bar, or longer, is no pickup.
function tidy(doc: Timeline, meter: MeterChange[], pickup: number): Timeline {
	const { meter: _meter, pickup: _pickup, ...rest } = doc;
	const sorted = [...meter].sort((a, b) => a.tick - b.tick);
	const plain = sorted.length === 1 && sameMeter(sorted[0], COMMON);
	const first = sorted[0] ?? { tick: 0, ...COMMON };
	const lead = pickup > 0 && pickup < barTicks(doc.ppq, first) ? Math.round(pickup) : 0;
	return {
		...rest,
		...(plain
			? {}
			: { meter: sorted.map((change) => ({ tick: change.tick, beats: change.beats, unit: change.unit })) }),
		...(lead ? { pickup: lead } : {})
	} as Timeline;
}

// A time signature from a tick on. One there already is changed instead, and the first is at tick 0. The caller says where:
// a change starts a bar, so it goes where a bar starts.
export function addMeter(doc: Timeline, tick: number, meter: Meter): Timeline {
	const at = Math.max(0, tick);
	const meters = metersOf(doc).filter((change) => change.tick !== at);
	return tidy(doc, [...meters, { tick: at, ...pick(meter) }], doc.pickup ?? 0);
}

// The time signature at `index` of `metersOf`, changed. Nothing else moves: the changes after it stay at their ticks, with
// the notes they go with.
export function setMeter(doc: Timeline, index: number, meter: Partial<Meter>): Timeline {
	const meters = metersOf(doc).map((change, i) => (i === index ? { ...change, ...meter } : change));
	if (!holds(doc.ppq, meters[index]?.unit ?? 4)) return doc;
	return tidy(doc, meters, doc.pickup ?? 0);
}

// The first one says what the song opens in, so it stays.
export function removeMeter(doc: Timeline, index: number): Timeline {
	if (index <= 0) return doc;
	return tidy(
		doc,
		metersOf(doc).filter((_, i) => i !== index),
		doc.pickup ?? 0
	);
}

// How long the pickup is, in ticks: 0 for none, and less than a bar of the first meter.
export const setPickup = (doc: Timeline, ticks: number) => tidy(doc, metersOf(doc), ticks);
