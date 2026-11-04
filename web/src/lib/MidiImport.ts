// A Standard MIDI File as a timeline, played on the standard set (GeneralMidi.ts): what MIDI import makes, from the menu or a
// file dropped on the arrangement. The file's ticks stay its own, its tempo map, time signatures and key signatures become the
// song's, and each channel it plays becomes a track, as a General MIDI synthesizer would play it:
// - A track plays its channel's programs, a slot for each instrument they reach, and each note the one in force as it starts.
//   Channel 10 is the drum kit: its track's kit holds the sounds the file plays, and a note in a choke group stops the one
//   before it, as a closed hi-hat stops an open one. The long sound of a group, an open hi-hat, rings on until then.
// - The sustain pedal is folded into the notes' lengths, as the user decided: a note let go of while it is down lasts until
//   it lifts, or until the key is struck again. A song has no pedal of its own to hold them.
// - Volume and pan go to the track's fader and pan, the reverb and chorus sends to buses holding the set's effects, and
//   expression, the mod wheel, channel pressure and the pitch wheel to the parameters every instrument of the set takes. What
//   is in force as a track starts is where its fader, pan, sends and parameters are set, and what changes after that is a lane
//   in its clip.
// What a song can't hold is left out and said: system exclusive messages, controllers nothing here answers, and the notes of a
// key the kit has no sound for.
//
// Each track gets one clip, from the bar its first note is in to the end of the bar its last note ends in, placed where it
// starts, so a part that comes in late is seen coming in, and Split cuts it into sections. Format 1 keeps the file's tracks
// apart: a track there is one file track's notes on one channel, named after that track. The state a channel's messages set
// (its program, its pedal, its controllers) is the channel's, whichever track sent them, as it is for a synthesizer that plays
// every track at once.
import { DRUM_CHANNEL, GM, programPatch, standardKit, type GeneralMidi, type KitKey } from '#lib/GeneralMidi.ts';
import { MidiError, readMidi, type MidiEvent, type MidiFile } from '#lib/Midi.ts';
import { timelineSchema, type Timeline } from '#lib/Schema.ts';
import { MOST_BEATS, UNITS, barsOf, holds } from '#lib/TimeSignature.ts';

export { MidiError };

export interface ImportOptions {
	gm?: GeneralMidi; // The set's tables: GM unless a test gives its own
	// Whether the sustain pedal lengthens notes, as it does unless a test compares with a reader that ignores it.
	pedal?: boolean;
}

export interface Summary {
	tracks: number;
	notes: number;
	left: string[]; // What was left out, each a phrase
	text: string; // All of it in sentences, as the page says it
}

export interface Imported {
	doc: Timeline;
	summary: Summary;
}

type Track = Timeline['tracks'][number];
type Clip = Timeline['clips'][number];
type Automation = Clip['automation'][number];
type Target = NonNullable<Automation['target']>;

const MOST_TICK = 0x7fffffff;
const MOST_PPQ = 65535;
const MOST_VOICES = 64;
// A kit's cymbals ring on for 9 to 14 seconds whatever their notes' lengths, each holding a voice, so a kit track has this many
// rather than as many as its notes sound at once.
const KIT_VOICES = 32;
const RINGS = 1.5; // Seconds a held drum rings when nothing stops it (`ringOn`)
const MOST_BEND = 24; // Semitones either way, the set's bend parameter's range
const NAME_LENGTH = 100;
const DEFAULT_TEMPO = 120; // What a file plays at until it says otherwise
const DEFAULT_RANGE = 2; // Semitones the pitch wheel bends until RPN 0 says otherwise

// MIDI's controllers, by number, that the import answers.
const CC = {
	wheel: 1,
	dataEntry: 6,
	volume: 7,
	pan: 10,
	expression: 11,
	dataEntryFine: 38,
	pedal: 64,
	reverb: 91,
	chorus: 93,
	nrpnFine: 98,
	nrpn: 99,
	rpnFine: 100,
	rpn: 101,
	soundOff: 120,
	reset: 121,
	notesOff: 123
};
const BEND_RANGE_RPN = 0;

// The values a channel's messages move, as the song holds them: a fader's gain, a pan, a send's gain, or a parameter's value.
const LANES = ['volume', 'pan', 'reverb', 'chorus', 'expression', 'wheel', 'pressure', 'bend'] as const;
type Lane = (typeof LANES)[number];

// A value as the song keeps it. Four places is finer than any step a controller makes.
const tidy = (value: number) => Math.round(value * 1e4) / 1e4;

// GM's curve for volume: the fader's gain is the controller's share of full, squared.
const gainOf = (cc: number) => (cc / 127) ** 2;

// What each is before a file says: GM's volume of 100, its reverb send of 40, no chorus, the pan in the middle, and the set's
// parameters as the table says they start.
const defaultsOf = (gm: GeneralMidi): Record<Lane, number> => ({
	volume: tidy(gainOf(100)),
	pan: 0,
	reverb: tidy(40 / 127),
	chorus: 0,
	...gm.defaults
});

interface Change {
	tick: number;
	value: number;
}

interface Channel {
	program: number;
	pedal: boolean;
	rpn: number | null; // The registered parameter selected for data entry, or null for none (or an NRPN)
	range: { semitones: number; cents: number };
	bend: number; // The wheel's position, -8192 to 8191
	lanes: Record<Lane, Change[]>;
	groups: Group[]; // The tracks it plays on
}

interface Played {
	tick: number;
	key: number;
	velocity: number;
	program: number;
	end: number | null; // Null while it sounds
	doubled?: boolean; // Struck again at the tick it started, so the second stands for both
}

// A track to be: one file track's notes on one channel.
interface Group {
	track: number; // The file's track, from 0
	channel: number;
	notes: Played[];
	sounding: Map<number, { note: Played; released: boolean }>; // By key: released means only the pedal holds it
	credits: Map<number, number>; // Note-offs on their way for notes that already ended, by key, which end nothing more
}

// ------------------------------------------------------------------------------------------------------------- time

interface Time {
	ppq: number;
	scale: number; // What the file's ticks are multiplied by to make the song's
	tempo: Timeline['tempo'];
	meter: NonNullable<Timeline['meter']>;
	key: { tick: number; fifths: number; minor?: boolean }[];
	said: string[]; // What the summary says about time
	left: string[];
}

// Changes from every track, in order, the last at a tick standing for it, and none that says what the one before it said.
function changes<T extends { tick: number }>(list: T[], same: (a: T, b: T) => boolean): T[] {
	const sorted = [...list].sort((a, b) => a.tick - b.tick);
	const out: T[] = [];
	for (const change of sorted) {
		if (out.at(-1)?.tick === change.tick) out.pop();
		if (out.length && same(out.at(-1)!, change)) continue;
		out.push(change);
	}
	return out;
}

const plural = (count: number, one: string, many = `${one}s`) =>
	`${count.toLocaleString('en')} ${count === 1 ? one : many}`;

function listed(items: string[]): string {
	if (items.length < 2) return items.join('');
	return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function time(file: MidiFile): Time {
	const all = file.tracks.flatMap((track) => track.events);
	const said: string[] = [];
	const left: string[] = [];

	// SMPTE time code counts frames, not beats, so its ticks are a fixed time apart. A song counts beats, so it plays at a
	// tempo that makes a tick the time a file's tick is: a quarter is half a second, or a second if half a second isn't a whole
	// number of ticks. The file's tempo changes, if it has any, change nothing in it.
	let ppq: number;
	let tempo: Timeline['tempo'];
	if (file.timing.kind === 'smpte') {
		const { fps, perFrame } = file.timing;
		const nominal = Math.round(fps);
		const perSecond = nominal * perFrame;
		const half = perSecond % 2 === 0;
		ppq = half ? perSecond / 2 : perSecond;
		const bpm = tidy(((half ? 120 : 60) * fps) / nominal);
		tempo = [{ tick: 0, bpm }];
		said.push(`Its time is SMPTE time code at ${fps} frames a second, which plays here at ${bpm} bpm.`);
	} else {
		ppq = file.timing.ppq;
		// To a thousandth of a beat a minute, which is what a tempo a file holds in whole microseconds a beat was meant to be:
		// 90 is 666,667 of them, which is 89.99996.
		const bpm = (perQuarter: number) => Math.min(1000, Math.max(1, Math.round((60e6 / perQuarter) * 1e3) / 1e3));
		const events = all.flatMap((e) => (e.kind === 'tempo' ? [{ tick: e.tick, bpm: bpm(e.perQuarter) }] : []));
		tempo = changes(events, (a, b) => a.bpm === b.bpm);
		if (!tempo.length || tempo[0].tick > 0) tempo.unshift({ tick: 0, bpm: DEFAULT_TEMPO });
	}

	// A time signature the song can hold has a lower figure it draws, and no more beats than a bar can have. The song's ticks
	// are the file's, unless one of its signatures has a beat that isn't a whole number of them: then each is split in two,
	// four or eight, as few as will hold every beat.
	const meters = changes(
		all.flatMap((e) => (e.kind === 'meter' ? [{ tick: e.tick, beats: e.beats, unit: e.unit }] : [])),
		(a, b) => a.beats === b.beats && a.unit === b.unit
	);
	const drawable = meters.filter(
		(m) => (UNITS as readonly number[]).includes(m.unit) && m.beats >= 1 && m.beats <= MOST_BEATS
	);
	const scale =
		[1, 2, 4, 8].find((k) => ppq * k <= MOST_PPQ && drawable.every((m) => holds(ppq * k, m.unit))) ??
		[1, 2, 4, 8].findLast((k) => ppq * k <= MOST_PPQ)!;
	const kept = drawable.filter((m) => holds(ppq * scale, m.unit));
	const refused = meters.filter((m) => !kept.includes(m));
	if (refused.length)
		left.push(
			`${refused.length === 1 ? 'a time signature' : `${refused.length} time signatures`} the song can't hold (${listed([...new Set(refused.map((m) => `${m.beats}/${m.unit}`))])})`
		);
	// One a later change repeats is no change at all once the ones between it have gone.
	const meter = changes(
		kept.map((m) => ({ ...m, tick: m.tick * scale, unit: m.unit as (typeof UNITS)[number] })),
		(a, b) => a.beats === b.beats && a.unit === b.unit
	);

	const keys = changes(
		all.flatMap((e) =>
			e.kind === 'key' && Math.abs(e.fifths) <= 7
				? [{ tick: e.tick * scale, fifths: e.fifths, ...(e.minor ? { minor: true } : {}) }]
				: []
		),
		(a, b) => a.fifths === b.fifths && !!a.minor === !!b.minor
	);

	return {
		ppq: ppq * scale,
		scale,
		tempo: tempo.map((t) => ({ ...t, tick: t.tick * scale })),
		meter,
		key: keys,
		said,
		left
	};
}

// ------------------------------------------------------------------------------------------------------------- playing

// What a song can't hold, counted as the file is played.
interface Left {
	controllers: Map<number, number>; // Changes, by controller
	keyPressure: number;
	programs: Map<number, number>; // Notes left out, by program
	drums: Map<number, number>; // And by key on the drum channel
}

function play(
	file: MidiFile,
	scale: number,
	pedalFolds: boolean,
	gm: GeneralMidi,
	defaults: Record<Lane, number>,
	left: Left
) {
	const channels: Channel[] = Array.from({ length: 16 }, () => ({
		program: 0,
		pedal: false,
		rpn: null,
		range: { semitones: DEFAULT_RANGE, cents: 0 },
		bend: 0,
		lanes: Object.fromEntries(LANES.map((lane) => [lane, []])) as unknown as Record<Lane, Change[]>,
		groups: []
	}));
	const groups = new Map<string, Group>();
	const groupOf = (track: number, channel: number) => {
		const id = `${file.format === 0 ? 0 : track}:${channel}`;
		let group = groups.get(id);
		if (!group) {
			group = { track, channel, notes: [], sounding: new Map(), credits: new Map() };
			groups.set(id, group);
			channels[channel].groups.push(group);
		}
		return group;
	};
	const chokes = new Map<number, number[]>();
	for (const keys of Object.values(gm.chokes)) for (const key of keys) chokes.set(key, keys);

	const end = (group: Group, key: number, tick: number) => {
		const held = group.sounding.get(key);
		if (!held) return;
		held.note.end = tick;
		group.sounding.delete(key);
	};
	// A note that ends before its own note-off, struck again or choked, leaves that note-off still to come, and it must not end
	// the note that took its place.
	const cut = (group: Group, key: number, tick: number) => {
		const held = group.sounding.get(key);
		if (!held) return;
		if (!held.released) group.credits.set(key, (group.credits.get(key) ?? 0) + 1);
		if (held.note.tick === tick) held.note.doubled = true;
		end(group, key, tick);
	};
	const release = (group: Group, key: number, tick: number) => {
		const credit = group.credits.get(key) ?? 0;
		if (credit) {
			group.credits.set(key, credit - 1);
			return;
		}
		const held = group.sounding.get(key);
		if (!held || held.released) return;
		// The drum kit has no pedal: GM's percussion ignores it.
		if (pedalFolds && channels[group.channel].pedal && group.channel !== DRUM_CHANNEL) held.released = true;
		else end(group, key, tick);
	};
	const lift = (channel: Channel, tick: number) => {
		for (const group of channel.groups)
			for (const [key, held] of [...group.sounding]) if (held.released) end(group, key, tick);
	};
	// All notes off, or all sound off, which leaves no note-off to come for anything.
	const silence = (channel: Channel, tick: number, now: boolean) => {
		for (const group of channel.groups) {
			group.credits.clear();
			for (const key of [...group.sounding.keys()]) {
				if (now) end(group, key, tick);
				else release(group, key, tick);
			}
		}
	};
	const set = (channel: Channel, lane: Lane, tick: number, value: number) =>
		channel.lanes[lane].push({ tick, value: tidy(value) });
	const bendOf = (channel: Channel) => {
		const range = channel.range.semitones + channel.range.cents / 100;
		const share = channel.bend >= 0 ? channel.bend / 8191 : channel.bend / 8192;
		return Math.max(-MOST_BEND, Math.min(MOST_BEND, share * range));
	};

	const controller = (c: Channel, tick: number, number: number, value: number) => {
		switch (number) {
			case CC.wheel:
				return set(c, 'wheel', tick, value / 127);
			case CC.volume:
				return set(c, 'volume', tick, gainOf(value));
			case CC.pan:
				return set(c, 'pan', tick, Math.max(-1, Math.min(1, (value - 64) / 63)));
			case CC.expression:
				return set(c, 'expression', tick, value / 127);
			case CC.reverb:
				return set(c, 'reverb', tick, value / 127);
			case CC.chorus:
				return set(c, 'chorus', tick, value / 127);
			case CC.pedal: {
				const down = value >= 64;
				if (c.pedal && !down) lift(c, tick);
				c.pedal = down;
				return;
			}
			case CC.rpn:
				c.rpn = ((c.rpn ?? 0x3fff) & 0x7f) | (value << 7);
				return;
			case CC.rpnFine:
				c.rpn = ((c.rpn ?? 0x3fff) & 0x3f80) | value;
				return;
			case CC.nrpn:
			case CC.nrpnFine:
				c.rpn = null; // Data entry goes to a non-registered parameter now, which nothing here knows
				return;
			case CC.dataEntry:
			case CC.dataEntryFine:
				if (c.rpn !== BEND_RANGE_RPN) return;
				if (number === CC.dataEntry) c.range = { semitones: value, cents: 0 };
				else c.range = { ...c.range, cents: value };
				return set(c, 'bend', tick, bendOf(c));
			case CC.soundOff:
				return silence(c, tick, true);
			case CC.reset:
				// GM's Reset All Controllers leaves volume, pan, the sends and the program as they are.
				for (const lane of ['expression', 'wheel', 'pressure'] as const) set(c, lane, tick, defaults[lane]);
				c.bend = 0;
				set(c, 'bend', tick, 0);
				if (c.pedal) lift(c, tick);
				c.pedal = false;
				c.rpn = null;
				return;
			case CC.notesOff:
			case 124: // Omni off, omni on, mono and poly each end every note too
			case 125:
			case 126:
			case 127:
				return silence(c, tick, false);
			default:
				left.controllers.set(number, (left.controllers.get(number) ?? 0) + 1);
		}
	};

	// Every track's events in one stream, as a synthesizer hears them: by tick, and at one tick in the order of the tracks.
	const stream: (MidiEvent & { track: number })[] = file.tracks
		.flatMap((track, index) => track.events.map((event) => ({ ...event, track: index, tick: event.tick * scale })))
		.sort((a, b) => a.tick - b.tick || a.track - b.track);

	for (const event of stream) {
		if (!('channel' in event)) continue;
		const channel = channels[event.channel];
		const { tick } = event;
		switch (event.kind) {
			case 'on': {
				const group = groupOf(event.track, event.channel);
				cut(group, event.key, tick);
				if (event.channel === DRUM_CHANNEL)
					for (const other of chokes.get(event.key) ?? []) if (other !== event.key) cut(group, other, tick);
				const note: Played = { tick, key: event.key, velocity: event.velocity, program: channel.program, end: null };
				group.notes.push(note);
				group.sounding.set(event.key, { note, released: false });
				break;
			}
			case 'off':
				release(groupOf(event.track, event.channel), event.key, tick);
				break;
			case 'controller':
				controller(channel, tick, event.controller, event.value);
				break;
			case 'program':
				channel.program = event.program;
				break;
			case 'pressure':
				set(channel, 'pressure', tick, event.value / 127);
				break;
			case 'bend':
				channel.bend = event.value;
				set(channel, 'bend', tick, bendOf(channel));
				break;
			case 'keyPressure':
				left.keyPressure += 1;
				break;
		}
	}

	// A note still sounding at the end of its track ends there.
	for (const group of groups.values()) {
		const last = file.tracks[group.track].end * scale;
		for (const { note } of group.sounding.values()) note.end = Math.max(last, note.tick + 1);
		group.sounding.clear();
	}
	return { channels, groups: [...groups.values()].sort((a, b) => a.track - b.track || a.channel - b.channel) };
}

// Ticks from `from` that last `seconds` at a song's tempo, which a file holds without ramps.
function ticksLasting(tempo: Timeline['tempo'], ppq: number, from: number, seconds: number): number {
	let at = from;
	let left = seconds;
	let index = Math.max(
		0,
		tempo.findLastIndex((change) => change.tick <= from)
	);
	for (;;) {
		const perSecond = (ppq * tempo[index].bpm) / 60;
		const next = tempo[index + 1]?.tick ?? Infinity;
		if (at + left * perSecond <= next) return Math.round(at + left * perSecond - from);
		left -= (next - at) / perSecond;
		at = next;
		index += 1;
	}
}

// The longer sound of each choke group, an open hi-hat, a long whistle and so on, lasts only as long as its note, as every
// other drum of the kit, which rings out whatever its length, doesn't. A file gives a drum a note of a few ticks, so each of
// these rings on to the next note of its group, as a closed hi-hat stops an open one, or for as long as one rings out when
// nothing stops it, unless its own note is longer than that.
function ringOn(group: Group, gm: GeneralMidi, rings: (tick: number) => number) {
	const held = new Set(gm.held);
	const chokes = new Map<number, Set<number>>();
	for (const keys of Object.values(gm.chokes)) for (const key of keys) chokes.set(key, new Set(keys));
	const notes = group.notes.filter((note) => !note.doubled).sort((a, b) => a.tick - b.tick);
	notes.forEach((note, index) => {
		if (!held.has(note.key)) return;
		const stoppers = chokes.get(note.key) ?? new Set([note.key]);
		let next: Played | undefined;
		for (let i = index + 1; i < notes.length && !next; ++i)
			if (notes[i].tick > note.tick && stoppers.has(notes[i].key)) next = notes[i];
		note.end = next ? next.tick : Math.max(note.end ?? note.tick, note.tick + rings(note.tick));
	});
}

// ------------------------------------------------------------------------------------------------------------- the song

// What a lane holds over a clip from `start` to `end`: its value as the clip starts, and each change after that, in the
// clip's ticks, leaving out any that says what the one before it said.
function window(changes: Change[], fallback: number, start: number, end: number) {
	let initial = fallback;
	const points: Change[] = [];
	for (const change of changes) {
		if (change.tick <= start) initial = change.value;
		else if (change.tick < end) {
			const at = change.tick - start;
			if (points.at(-1)?.tick === at) points.pop();
			if ((points.at(-1)?.value ?? initial) !== change.value) points.push({ tick: at, value: change.value });
		}
	}
	return { initial, points };
}

// The most notes sounding at once. One that ends where another starts has made way for it.
function polyphony(notes: { tick: number; dur: number }[]): number {
	const edges = notes.flatMap((n) => [
		[n.tick, 1],
		[n.tick + n.dur, -1]
	]);
	edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let now = 0;
	let most = 0;
	for (const [, step] of edges) most = Math.max(most, (now += step));
	return most;
}

function freeId(taken: Set<string>, base: string): string {
	let id = base || 'clip';
	for (let n = 2; taken.has(id); ++n) id = `${base || 'clip'}-${n}`;
	taken.add(id);
	return id;
}

// Makes the timeline a file plays. A file that can't be read throws a MidiError, which says why.
export function midiTimeline(file: MidiFile, options: ImportOptions = {}): Imported {
	const gm = options.gm ?? GM;
	const clock = time(file);
	const left: Left = { controllers: new Map(), keyPressure: 0, programs: new Map(), drums: new Map() };
	const defaults = defaultsOf(gm);
	const { channels, groups } = play(file, clock.scale, options.pedal ?? true, gm, defaults, left);
	const rings = (tick: number) => ticksLasting(clock.tempo, clock.ppq, tick, RINGS);
	for (const group of groups) if (group.channel === DRUM_CHANNEL) ringOn(group, gm, rings);
	const bars = barsOf({ ppq: clock.ppq, meter: clock.meter.length ? clock.meter : undefined });
	// In format 0 the one track's name is the song's, and says nothing about any one channel.
	const names = file.tracks.map((track) =>
		file.format === 1 ? (track.events.flatMap((e) => (e.kind === 'name' && e.text ? [e.text] : []))[0] ?? '') : ''
	);
	const perTrack = new Map<number, number>();
	for (const group of groups) perTrack.set(group.track, (perTrack.get(group.track) ?? 0) + 1);

	const tracks: Track[] = [];
	const clips: Clip[] = [];
	const clipIds = new Set<string>();
	let imported = 0;

	for (const group of groups) {
		const drums = group.channel === DRUM_CHANNEL;
		const played = group.notes.filter((note) => !note.doubled);
		let slots: string[];
		let slotOf: (note: Played) => number | null;
		let kit: KitKey[] | undefined;
		if (drums) {
			({ slots, kit } = standardKit(
				played.map((note) => note.key),
				gm
			));
			const byKey = new Map(kit.map((key) => [key.note, key.slot]));
			slotOf = (note) => byKey.get(note.key) ?? null;
		} else {
			slots = [];
			slotOf = (note) => {
				const patch = programPatch(note.program, gm);
				if (!patch) return null;
				const slot = slots.indexOf(patch);
				return slot < 0 ? slots.push(patch) - 1 : slot;
			};
		}
		const kept: (Played & { slot: number; end: number })[] = [];
		for (const note of played) {
			const slot = slotOf(note);
			if (slot !== null) kept.push({ ...note, slot, end: note.end ?? note.tick + 1 });
			else if (drums) left.drums.set(note.key, (left.drums.get(note.key) ?? 0) + 1);
			else left.programs.set(note.program, (left.programs.get(note.program) ?? 0) + 1);
		}
		if (!kept.length) continue;

		// A large file's track has more notes than a call can take arguments, so these go one by one.
		const first = kept.reduce((most, note) => Math.min(most, note.tick), Infinity);
		const last = kept.reduce((most, note) => Math.max(most, note.end, note.tick + 1), 0);
		const start = Math.max(0, bars.at(first).start);
		const finish = bars.whole(start, last - 1).end;
		if (finish > MOST_TICK) throw new MidiError('It is longer than a song can be.');

		const id = tracks.length + 1;
		const instrument = drums ? 'Drums' : (gm.programs[kept[0].program]?.name ?? `Program ${kept[0].program + 1}`);
		const named = names[group.track];
		const name = (named ? (perTrack.get(group.track)! > 1 ? `${named} (${instrument})` : named) : instrument).slice(
			0,
			NAME_LENGTH
		);
		const notes = kept
			.map((note) => ({
				tick: note.tick - start,
				note: note.key,
				vel: note.velocity,
				dur: Math.max(1, note.end - note.tick),
				...(drums || slots.length > 1 ? { slot: note.slot } : {})
			}))
			.sort((a, b) => a.tick - b.tick || a.note - b.note);
		imported += notes.length;

		const channel = channels[group.channel];
		const lanes = Object.fromEntries(
			LANES.map((lane) => [lane, window(channel.lanes[lane], defaults[lane], start, finish)])
		) as Record<Lane, ReturnType<typeof window>>;
		const automation: Automation[] = [];
		const lane = (values: ReturnType<typeof window>, at: { param: number } | { target: Target }) => {
			if (!values.points.length) return;
			for (const point of [{ tick: 0, value: values.initial }, ...values.points]) automation.push({ ...at, ...point });
		};
		lane(lanes.volume, { target: { mix: 'fader', track: id } });
		lane(lanes.pan, { target: { mix: 'pan', track: id } });
		const params: Record<string, number> = {};
		for (const [which, param] of [
			['expression', gm.params.expression],
			['wheel', gm.params.wheel],
			['pressure', gm.params.pressure],
			['bend', gm.params.bend]
		] as const) {
			if (lanes[which].initial !== defaults[which]) params[String(param)] = lanes[which].initial;
			lane(lanes[which], { param });
		}
		const trackSends: Track['sends'] = [];
		for (const bus of ['reverb', 'chorus'] as const) {
			const values = lanes[bus];
			// A table without the effect has nowhere to send to, as a test's may not.
			if ((values.initial === 0 && !values.points.length) || !gm.effects[bus]) continue;
			trackSends.push({ bus, gain: values.initial });
			lane(values, { target: { mix: 'send', track: id, to: bus } });
		}

		const clip = freeId(clipIds, name);
		clips.push({ id: clip, length: finish - start, notes, automation, play: [] });
		tracks.push({
			id,
			name,
			voices: drums ? KIT_VOICES : Math.max(1, Math.min(MOST_VOICES, polyphony(notes))),
			slots,
			params,
			placements: [{ clip, tick: start, repeat: 1 }],
			...(kit ? { kit } : {}),
			gain: lanes.volume.initial,
			pan: lanes.pan.initial,
			mute: false,
			output: 'master',
			sends: trackSends,
			inserts: [],
			steal: 'fade'
		});
	}

	// A bus for each effect a track sends to, which holds the set's effect, wet only, at full level.
	const buses: Timeline['buses'] = [];
	for (const bus of ['reverb', 'chorus'] as const) {
		const effect = gm.effects[bus];
		if (!effect || !tracks.some((track) => track.sends.some((send) => send.bus === bus))) continue;
		buses.push({
			id: bus,
			gain: 1,
			pan: 0,
			mute: false,
			output: 'master',
			sends: [],
			inserts: [{ id: buses.length + 1, patch: `${gm.prefix}${effect}` }]
		});
	}

	const doc = timelineSchema.parse({
		ppq: clock.ppq,
		tempo: clock.tempo,
		...(clock.meter.length && !(clock.meter.length === 1 && isCommon(clock.meter[0])) ? { meter: clock.meter } : {}),
		...(clock.key.length && !(clock.key.length === 1 && clock.key[0].fifths === 0 && !clock.key[0].minor)
			? { key: clock.key }
			: {}),
		clips,
		tracks,
		buses,
		master: { gain: masterGain(tracks.length), inserts: [] },
		globals: {}
	});

	const summary = summarise(file, gm, left, clock, tracks.length, imported);
	return { doc, summary };
}

const isCommon = (m: { tick: number; beats: number; unit: number }) => m.tick === 0 && m.beats === 4 && m.unit === 4;

// Every instrument of the set plays a note at the same loudness, and a file's tracks at GM's volume of 100 sound about as loud
// as a piece does: the Mutopia scores on a piano peak at a quarter of full scale or so, and three tracks of chords and drums at
// a third. Tracks that play at once add as their power does, so past four the master comes down to keep many as loud as four,
// and what still goes over meets the browser's limiter.
const masterGain = (tracks: number) => tidy(Math.min(1, 2 / Math.sqrt(Math.max(1, tracks))));

function summarise(file: MidiFile, gm: GeneralMidi, left: Left, clock: Time, tracks: number, notes: number): Summary {
	const out: string[] = [];
	for (const [program, count] of [...left.programs].sort((a, b) => a[0] - b[0])) {
		const name = gm.programs[program]?.name ?? `program ${program + 1}`;
		out.push(`${plural(count, 'note')} for ${name}, which the set has no instrument for`);
	}
	if (left.drums.size) {
		const count = [...left.drums.values()].reduce((a, b) => a + b, 0);
		const keys = [...left.drums.keys()]
			.sort((a, b) => a - b)
			.map((key) => gm.drums.find((drum) => drum.note === key)?.name ?? `key ${key}`);
		out.push(`${plural(count, 'drum note')} on ${listed(keys)}, which the kit has no sound for`);
	}
	if (file.skipped.sysex) out.push(plural(file.skipped.sysex, 'system exclusive message'));
	if (left.controllers.size) {
		const count = [...left.controllers.values()].reduce((a, b) => a + b, 0);
		const numbers = [...left.controllers.keys()].sort((a, b) => a - b).map(String);
		out.push(
			`${plural(count, 'change')} to ${numbers.length === 1 ? 'controller' : 'controllers'} ${listed(numbers)}, which nothing here answers`
		);
	}
	if (left.keyPressure) out.push(plural(left.keyPressure, 'polyphonic key pressure message'));
	out.push(...clock.left);

	const said = [`Imported ${plural(tracks, 'track')} with ${plural(notes, 'note')}.`, ...clock.said];
	// Each thing left out may have a list of its own, so they are kept apart by semicolons.
	if (out.length) said.push(`Left out ${out.join('; ')}.`);
	return { tracks, notes, left: out, text: said.join(' ') };
}

// A file's bytes as a timeline. A file that can't be read throws a MidiError, which says why.
export const importMidi = (bytes: Uint8Array, options: ImportOptions = {}) => midiTimeline(readMidi(bytes), options);
