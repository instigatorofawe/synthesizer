// What the timeline editors do to a document, apart from drawing it. Every function returns a new value, which is what makes
// undo a list of old documents. As with graphs, little here decides what is legal: overlapping clips can still be drawn, and
// the compiler says what is wrong and where. What these do take care of is taking references along, because deleting a bus
// shouldn't leave a trail of errors about a name nobody can see any more.
import type { Graph, Param, Timeline } from '#lib/Schema.ts';

export type Track = Timeline['tracks'][number];
export type Bus = Timeline['buses'][number];
export type Master = Timeline['master'];
export type Clip = Timeline['clips'][number];
export type Note = Clip['notes'][number];
export type Point = Clip['automation'][number];
export type Placement = Track['placements'][number];
export type PlayChange = Clip['play'][number];
export type LaneTarget = NonNullable<Point['target']>;
export type Insert = Track['inserts'][number];
export type Send = Track['sends'][number];
export type Tempo = Timeline['tempo'][number];

export interface PatchLike {
	id: string;
	name: string;
	graph: Graph;
	builtin?: boolean; // One of the examples' own, which can't be changed
}

// A patch picker's choices: what the library's owner made, and then the built-in ones.
export function byOwner<T extends PatchLike>(patches: T[]): { own: T[]; builtin: T[] } {
	return { own: patches.filter((patch) => !patch.builtin), builtin: patches.filter((patch) => patch.builtin) };
}

// The grid is 4/4 and nothing stores that. A document holds ticks, so a time signature would change how it is drawn and
// nothing about how it plays.
export const BEATS_PER_BAR = 4;
export const ticksPerBar = (doc: Pick<Timeline, 'ppq'>) => doc.ppq * BEATS_PER_BAR;

export function grids(ppq: number) {
	const each = (beats: number) => Math.max(1, Math.round(ppq * beats));
	return [
		{ label: 'Bar', ticks: each(BEATS_PER_BAR) },
		{ label: '1/4', ticks: each(1) },
		{ label: '1/8', ticks: each(1 / 2) },
		{ label: '1/16', ticks: each(1 / 4) },
		{ label: '1/32', ticks: each(1 / 8) },
		{ label: 'Off', ticks: 1 }
	];
}

export const snapTick = (tick: number, grid: number) => Math.max(0, Math.round(tick / grid) * grid);

const clipOf = (doc: Timeline, id: string) => doc.clips.find((clip) => clip.id === id);

// The window of its clip a placement plays, in the clip's ticks: all of it unless it says otherwise.
export function windowOf(doc: Timeline, placed: Placement): { start: number; length: number } {
	const start = placed.start ?? 0;
	return { start, length: placed.length ?? Math.max(0, (clipOf(doc, placed.clip)?.length ?? 0) - start) };
}

// How long a placement lasts, every repeat of its window.
export const placementSpan = (doc: Timeline, placed: Placement) => placed.repeat * windowOf(doc, placed).length;

// Where the last placement ends. The compiler reports this too, but only for a document that compiles.
export function songLength(doc: Timeline): number {
	let end = 0;
	for (const track of doc.tracks) {
		for (const placed of track.placements) end = Math.max(end, placed.tick + placementSpan(doc, placed));
	}
	return end;
}

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
	if (under === 1) return over === 1 ? '1 bar' : `${over} bars`;
	if (under <= 128 && (under & (under - 1)) === 0) return `${over}/${under}`;
	return ticks === 1 ? '1 tick' : `${ticks} ticks`;
}

// What the Draw length offers, a 1/32 note to a bar: those this ppq can hold in whole ticks.
export function drawLengths(ppq: number): { label: string; ticks: number }[] {
	return [32, 16, 8, 4, 2, 1]
		.map((under) => (ppq * BEATS_PER_BAR) / under)
		.filter((ticks) => Number.isInteger(ticks))
		.map((ticks) => ({ label: noteValue(ticks, ppq), ticks }));
}

// The Draw length one step shorter or longer than this one, which needn't be one of them. It stops at either end.
export function stepLength(ticks: number, ppq: number, by: -1 | 1): number {
	const lengths = drawLengths(ppq).map((length) => length.ticks);
	const next = by > 0 ? lengths.find((length) => length > ticks) : lengths.findLast((length) => length < ticks);
	return next ?? ticks;
}

// ---------------------------------------------------------------------------------------------------------------- chains

// The compiler's own names for these, which an insert's `key` and a route's `output` already use.
export type ChainKey = string;
export const trackKey = (id: number): ChainKey => `track:${id}`;
export const busKey = (id: string): ChainKey => `bus:${id}`;
export const MASTER: ChainKey = 'master';

type Chain = Track | Bus | Master;

function mapChain(doc: Timeline, key: ChainKey, change: <T extends Chain>(chain: T) => T): Timeline {
	if (key === MASTER) return { ...doc, master: change(doc.master) };
	if (key.startsWith('bus:')) {
		const id = key.slice(4);
		return { ...doc, buses: doc.buses.map((bus) => (bus.id === id ? change(bus) : bus)) };
	}
	const id = Number(key.slice(6));
	return { ...doc, tracks: doc.tracks.map((track) => (track.id === id ? change(track) : track)) };
}

export function chainOf(doc: Timeline, key: ChainKey): Chain | undefined {
	if (key === MASTER) return doc.master;
	if (key.startsWith('bus:')) return doc.buses.find((bus) => bus.id === key.slice(4));
	return doc.tracks.find((track) => track.id === Number(key.slice(6)));
}

export const setChain = (doc: Timeline, key: ChainKey, change: Partial<Track> | Partial<Bus> | Partial<Master>) =>
	mapChain(doc, key, (chain) => ({ ...chain, ...change }));

const eachChain = (doc: Timeline): Chain[] => [...doc.tracks, ...doc.buses, doc.master];

// What a mix register pair can hold. It holds their product, and a fader holds its chain's mute with it.
export type MixFactor = 'fader' | 'mute' | 'pan' | 'send' | 'master';

export interface ReportedPair {
	left: number;
	right: number;
	of?: MixFactor[];
}

export interface ReportedRoute extends ReportedPair {
	to: string;
	pre?: boolean;
}

interface ReportedChain {
	id: number | string;
	mix: ReportedRoute[];
	stages?: ReportedPair[]; // Factors applied to the whole chain by a step of their own
}

interface ReportedMixer {
	tracks: ReportedChain[];
	buses: ReportedChain[];
	master?: { stages?: ReportedPair[] };
}

// What a route holds when a report doesn't say, which is what every route held before stages.
function routeFactors(chain: Track | Bus, route: ReportedRoute): MixFactor[] {
	if (route.of) return route.of;
	const factors: MixFactor[] = ['fader', 'pan'];
	if (route.to !== chain.output) factors.push('send');
	if (route.to === MASTER) factors.push('master');
	return factors;
}

// The gains a pair holds, which is what the compiler writes for it.
export function pairGains(doc: Timeline, chain: Track | Bus | Master, of: MixFactor[], send = 1) {
	const mute = 'mute' in chain && chain.mute ? 0 : 1;
	let gain = 1;
	if (of.includes('fader')) gain = chain.gain * mute;
	else if (of.includes('mute')) gain = mute;
	if (of.includes('send')) gain *= send;
	if (of.includes('master')) gain *= doc.master.gain;
	if (!of.includes('pan') || !('pan' in chain)) return { left: gain, right: gain };
	return {
		left: gain * Math.sin(((1 - chain.pan) * Math.PI) / 4),
		right: gain * Math.sin(((1 + chain.pan) * Math.PI) / 4)
	};
}

const sendGain = (chain: Track | Bus, to: ChainKey) =>
	to === chain.output ? 1 : (chain.sends.find((s) => busKey(s.bus) === to)?.gain ?? 0);

// What goes into the mix registers for one route, as every route was before stages: a fader, its mute and its pan, a send's
// own gain if this is a send, and the master fader if it lands on master.
export function routeGains(doc: Timeline, chain: Track | Bus, to: ChainKey) {
	return pairGains(doc, chain, routeFactors(chain, { to, left: 0, right: 0 }), sendGain(chain, to));
}

// Every register pair of a Program, with the chain whose controls it holds and what it holds of them.
function eachPair(doc: Timeline, program: ReportedMixer) {
	const pairs: {
		key: ChainKey;
		chain: Track | Bus | Master;
		pair: ReportedPair;
		of: MixFactor[];
		send: number;
		to?: string;
	}[] = [];
	const add = (key: ChainKey, chain: Track | Bus | undefined, reported: ReportedChain) => {
		if (!chain) return;
		for (const route of reported.mix) {
			const send = sendGain(chain, route.to);
			pairs.push({ key, chain, pair: route, of: routeFactors(chain, route), send, to: route.to });
		}
		for (const stage of reported.stages ?? []) pairs.push({ key, chain, pair: stage, of: stage.of ?? [], send: 1 });
	};
	for (const reported of program.tracks) {
		add(
			trackKey(reported.id as number),
			doc.tracks.find((t) => t.id === reported.id),
			reported
		);
	}
	for (const reported of program.buses) {
		add(
			busKey(String(reported.id)),
			doc.buses.find((b) => b.id === reported.id),
			reported
		);
	}
	for (const stage of program.master?.stages ?? []) {
		pairs.push({ key: MASTER, chain: doc.master, pair: stage, of: stage.of ?? ['master'], send: 1 });
	}
	return pairs;
}

// The register writes that make a change to this chain audible before the compile that follows it. The master fader is in
// every route into master, or in a stage of its own, so moving it writes those.
export function mixWrites(doc: Timeline, program: ReportedMixer, key: ChainKey): { register: number; value: number }[] {
	const writes: { register: number; value: number }[] = [];
	for (const { key: owner, chain, pair, of, send } of eachPair(doc, program)) {
		if (key === MASTER ? !of.includes('master') : owner !== key) continue;
		const { left, right } = pairGains(doc, chain, of, send);
		writes.push({ register: pair.left, value: left }, { register: pair.right, value: right });
	}
	return writes;
}

// A fader's travel, from 0 to 1, against its gain. Cubic, so 0 dB sits at 79% with +6 dB at the top, -20 dB at 37% and -40 dB
// at 17%, and a hand moves evenly through what it hears.
const TOP = Math.cbrt(2);
export const faderGain = (position: number) => (position * TOP) ** 3;
export const faderPosition = (gain: number) => Math.cbrt(Math.max(0, gain)) / TOP;

export function addSend(doc: Timeline, key: ChainKey, bus: string): Timeline {
	return mapChain(doc, key, (chain) =>
		'sends' in chain ? { ...chain, sends: [...chain.sends, { bus, gain: 0.5 }] } : chain
	);
}

export function setSend(doc: Timeline, key: ChainKey, index: number, change: Partial<Send>): Timeline {
	const changed = (send: Send) => {
		const next = { ...send, ...change };
		if (!next.pre) delete next.pre;
		return next;
	};
	return mapChain(doc, key, (chain) =>
		'sends' in chain ? { ...chain, sends: chain.sends.map((s, i) => (i === index ? changed(s) : s)) } : chain
	);
}

function dropLanes(doc: Timeline, drops: (target: LaneTarget) => boolean): Timeline {
	return {
		...doc,
		clips: doc.clips.map((clip) => ({
			...clip,
			automation: clip.automation.filter((point) => !point.target || !drops(point.target))
		}))
	};
}

export function removeSend(doc: Timeline, key: ChainKey, index: number): Timeline {
	const chain = chainOf(doc, key);
	const gone = chain && 'sends' in chain ? chain.sends[index]?.bus : undefined;
	const next = mapChain(doc, key, (c) => ('sends' in c ? { ...c, sends: c.sends.filter((_, i) => i !== index) } : c));
	if (gone === undefined) return next;
	const named = key.startsWith('bus:') ? { bus: key.slice(4) } : { track: Number(key.slice(6)) };
	return dropLanes(next, (target) => {
		if (!('mix' in target) || target.mix !== 'send' || target.to !== gone) return false;
		return 'bus' in named
			? 'bus' in target && target.bus === named.bus
			: 'track' in target && target.track === named.track;
	});
}

const insertIds = (doc: Timeline) =>
	eachChain(doc).flatMap((c) => c.inserts.flatMap((i) => (i.id === undefined ? [] : [i.id])));

export function addInsert(doc: Timeline, key: ChainKey, patch: string): Timeline {
	const id = Math.max(0, ...insertIds(doc)) + 1;
	return mapChain(doc, key, (chain) => ({ ...chain, inserts: [...chain.inserts, { id, patch }] }));
}

export function setInsert(doc: Timeline, key: ChainKey, index: number, change: Partial<Insert>): Timeline {
	return mapChain(doc, key, (chain) => ({
		...chain,
		inserts: chain.inserts.map((insert, i) => {
			if (i !== index) return insert;
			const next: Insert = { ...insert, ...change };
			if (next.key === undefined) delete next.key;
			return next;
		})
	}));
}

// Another patch has other parameters, so a value set on the old one can't carry over, and a lane moving one would be an error.
export function setInsertPatch(doc: Timeline, key: ChainKey, index: number, patch: string): Timeline {
	const id = chainOf(doc, key)?.inserts[index]?.id;
	const next = mapChain(doc, key, (chain) => ({
		...chain,
		inserts: chain.inserts.map((insert, i) => {
			if (i !== index) return insert;
			const { params: _, ...rest } = insert;
			return { ...rest, patch };
		})
	}));
	return id === undefined ? next : dropLanes(next, (target) => 'insert' in target && target.insert === id);
}

export function removeInsert(doc: Timeline, key: ChainKey, index: number): Timeline {
	const id = chainOf(doc, key)?.inserts[index]?.id;
	const next = mapChain(doc, key, (chain) => ({ ...chain, inserts: chain.inserts.filter((_, i) => i !== index) }));
	return id === undefined ? next : dropLanes(next, (target) => 'insert' in target && target.insert === id);
}

// Inserts run in order, so this is a change of sound and not of layout.
export function moveInsert(doc: Timeline, key: ChainKey, index: number, by: number): Timeline {
	return mapChain(doc, key, (chain) => {
		const to = index + by;
		if (to < 0 || to >= chain.inserts.length) return chain;
		const inserts = [...chain.inserts];
		const [moved] = inserts.splice(index, 1);
		inserts.splice(to, 0, moved);
		return { ...chain, inserts };
	});
}

export function addBus(doc: Timeline, id: string): Timeline {
	if (!id || doc.buses.some((bus) => bus.id === id)) return doc;
	const bus: Bus = { id, gain: 1, pan: 0, mute: false, output: MASTER, sends: [], inserts: [] };
	return { ...doc, buses: [...doc.buses, bus] };
}

// Everything that named it goes too. A sidechain from a chain that has gone leaves the insert without its key, which the
// compiler can explain better than a dangling name.
function forgetChain(doc: Timeline, key: ChainKey): Timeline {
	const clean = <T extends Chain>(chain: T): T => {
		const inserts = chain.inserts.map((insert) => {
			if (insert.key !== key) return insert;
			const { key: _, ...rest } = insert;
			return rest;
		});
		if (!('output' in chain)) return { ...chain, inserts };
		const sends = key.startsWith('bus:') ? chain.sends.filter((send) => busKey(send.bus) !== key) : chain.sends;
		return { ...chain, inserts, sends, output: chain.output === key ? MASTER : chain.output };
	};
	return {
		...doc,
		tracks: doc.tracks.map(clean),
		buses: doc.buses.map(clean),
		master: clean(doc.master)
	};
}

export function removeBus(doc: Timeline, id: string): Timeline {
	const gone = doc.buses.find((bus) => bus.id === id);
	if (!gone) return doc;
	const ids = new Set(gone.inserts.flatMap((insert) => (insert.id === undefined ? [] : [insert.id])));
	const next = forgetChain({ ...doc, buses: doc.buses.filter((bus) => bus.id !== id) }, busKey(id));
	return dropLanes(next, (target) => {
		if ('insert' in target) return ids.has(target.insert);
		return ('bus' in target && target.bus === id) || ('to' in target && target.to === id);
	});
}

// ---------------------------------------------------------------------------------------------------------------- tracks

export function addTrack(doc: Timeline, slot?: string): { doc: Timeline; id: number } {
	const id = Math.max(0, ...doc.tracks.map((track) => track.id)) + 1;
	const track: Track = {
		id,
		name: `Track ${id}`,
		voices: 8,
		slots: slot ? [slot] : [],
		params: {},
		placements: [],
		gain: 1,
		pan: 0,
		mute: false,
		output: MASTER,
		sends: [],
		inserts: [],
		steal: 'fade' // A new track fades a stolen voice. A document from before says nothing, and cuts.
	};
	return { doc: { ...doc, tracks: [...doc.tracks, track] }, id };
}

export function removeTrack(doc: Timeline, id: number): Timeline {
	const gone = doc.tracks.find((track) => track.id === id);
	if (!gone) return doc;
	const ids = new Set(gone.inserts.flatMap((insert) => (insert.id === undefined ? [] : [insert.id])));
	const next = forgetChain({ ...doc, tracks: doc.tracks.filter((track) => track.id !== id) }, trackKey(id));
	return dropLanes(next, (target) => {
		if ('insert' in target) return ids.has(target.insert);
		return 'track' in target && target.track === id;
	});
}

export const setTrack = (doc: Timeline, id: number, change: Partial<Track>) => setChain(doc, trackKey(id), change);

export function setTrackParam(doc: Timeline, id: number, param: number, value: number): Timeline {
	return mapChain(doc, trackKey(id), (chain) => ({
		...chain,
		params: { ...(chain as Track).params, [String(param)]: value }
	}));
}

export function setGlobal(doc: Timeline, param: number, value: number): Timeline {
	return { ...doc, globals: { ...doc.globals, [String(param)]: value } };
}

export function setSlot(doc: Timeline, id: number, index: number, patch: string): Timeline {
	return mapChain(doc, trackKey(id), (chain) => ({
		...chain,
		slots: (chain as Track).slots.map((slot, i) => (i === index ? patch : slot))
	}));
}

export function addSlot(doc: Timeline, id: number, patch: string): Timeline {
	return mapChain(doc, trackKey(id), (chain) => ({ ...chain, slots: [...(chain as Track).slots, patch] }));
}

export function removeSlot(doc: Timeline, id: number, index: number): Timeline {
	return mapChain(doc, trackKey(id), (chain) => ({
		...chain,
		slots: (chain as Track).slots.filter((_, i) => i !== index)
	}));
}

// Every slot and insert that plays one patch plays another instead, with its parameters and lanes, as a copy of it does.
export function replacePatch(doc: Timeline, from: string, to: string): Timeline {
	const inserts = <T extends { inserts: Insert[] }>(chain: T): T => ({
		...chain,
		inserts: chain.inserts.map((insert) => (insert.patch === from ? { ...insert, patch: to } : insert))
	});
	return {
		...doc,
		tracks: doc.tracks.map((track) => ({
			...inserts(track),
			slots: track.slots.map((slot) => (slot === from ? to : slot))
		})),
		buses: doc.buses.map(inserts),
		master: inserts(doc.master)
	};
}

// ----------------------------------------------------------------------------------------------- clips and placements

function freshClipId(doc: Timeline, base: string): string {
	const taken = new Set(doc.clips.map((clip) => clip.id));
	if (!taken.has(base)) return base;
	for (let n = 2; ; ++n) {
		if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
	}
}

export function addClip(doc: Timeline, length: number): { doc: Timeline; id: string } {
	const id = freshClipId(doc, 'clip');
	return { doc: { ...doc, clips: [...doc.clips, { id, length, notes: [], automation: [], play: [] }] }, id };
}

export function duplicateClip(doc: Timeline, id: string): { doc: Timeline; id: string } {
	const clip = clipOf(doc, id);
	if (!clip) return { doc, id };
	const copy = freshClipId(doc, clip.id);
	return { doc: { ...doc, clips: [...doc.clips, { ...clip, id: copy }] }, id: copy };
}

export function setClip(doc: Timeline, id: string, clip: Clip): Timeline {
	return { ...doc, clips: doc.clips.map((c) => (c.id === id ? clip : c)) };
}

const mapPlacements = (doc: Timeline, change: (track: Track) => Track['placements']): Timeline => ({
	...doc,
	tracks: doc.tracks.map((track) => ({ ...track, placements: change(track) }))
});

// A name in use is refused by staying as it was, because two clips can't share one.
export function renameClip(doc: Timeline, id: string, name: string): Timeline {
	if (!name || name === id || clipOf(doc, name)) return doc;
	const renamed = { ...doc, clips: doc.clips.map((clip) => (clip.id === id ? { ...clip, id: name } : clip)) };
	return mapPlacements(renamed, (track) => track.placements.map((p) => (p.clip === id ? { ...p, clip: name } : p)));
}

export function removeClip(doc: Timeline, id: string): Timeline {
	const kept = { ...doc, clips: doc.clips.filter((clip) => clip.id !== id) };
	return mapPlacements(kept, (track) => track.placements.filter((p) => p.clip !== id));
}

// The compiler reads placements in order and takes one that goes backwards for an overlap, so edits keep them sorted.
const inOrder = (placements: Track['placements']) => [...placements].sort((a, b) => a.tick - b.tick);

export function place(doc: Timeline, track: number, clip: string, tick: number): Timeline {
	return mapChain(doc, trackKey(track), (chain) => {
		const placements = (chain as Track).placements;
		return { ...chain, placements: inOrder([...placements, { clip, tick, repeat: 1 }]) };
	});
}

export function placementIndex(doc: Timeline, track: number, clip: string, tick: number): number {
	const found = doc.tracks.find((t) => t.id === track);
	return found ? found.placements.findIndex((p) => p.clip === clip && p.tick === tick) : -1;
}

export function movePlacement(doc: Timeline, track: number, index: number, toTrack: number, tick: number): Timeline {
	const from = doc.tracks.find((t) => t.id === track)?.placements[index];
	if (!from) return doc;
	return mapPlacements(doc, (t) => {
		const kept = t.id === track ? t.placements.filter((_, i) => i !== index) : t.placements;
		return t.id === toTrack ? inOrder([...kept, { ...from, tick }]) : kept;
	});
}

// A placement says only what differs from playing its whole clip as it is, so a document stays as it was until someone
// transposes or trims one.
function tidyPlacement(doc: Timeline, placed: Placement): Placement {
	const { transpose, velocity, start, length, ...rest } = placed;
	const tidy: Placement = { ...rest };
	if (transpose) tidy.transpose = transpose;
	if (velocity !== undefined && velocity !== 1) tidy.velocity = velocity;
	if (start) tidy.start = start;
	const whole = (clipOf(doc, placed.clip)?.length ?? 0) - (start ?? 0);
	if (length !== undefined && length !== whole) tidy.length = length;
	return tidy;
}

export function setPlacement(doc: Timeline, track: number, index: number, change: Partial<Placement>) {
	return mapPlacements(doc, (t) =>
		t.id === track
			? inOrder(t.placements.map((p, i) => (i === index ? tidyPlacement(doc, { ...p, ...change }) : p)))
			: t.placements
	);
}

export function removePlacement(doc: Timeline, track: number, index: number): Timeline {
	return mapPlacements(doc, (t) => (t.id === track ? t.placements.filter((_, i) => i !== index) : t.placements));
}

// A copy of the clip behind one placement, so an edit stops reaching the others.
export function makeUnique(doc: Timeline, track: number, index: number): { doc: Timeline; id: string } {
	const placed = doc.tracks.find((t) => t.id === track)?.placements[index];
	if (!placed) return { doc, id: '' };
	const copy = duplicateClip(doc, placed.clip);
	return { doc: setPlacement(copy.doc, track, index, { clip: copy.id }), id: copy.id };
}

// The same placement again where this one ends, repeats, window and all, so a pattern grows by one more of it. It plays the same
// clip, as a copy dragged off it does, and the index it lands at comes back with it.
export function duplicatePlacement(doc: Timeline, track: number, index: number): { doc: Timeline; index: number } {
	const placed = doc.tracks.find((t) => t.id === track)?.placements[index];
	if (!placed) return { doc, index };
	const copy = { ...placed, tick: placed.tick + placementSpan(doc, placed) };
	const next = mapChain(doc, trackKey(track), (chain) => ({
		...chain,
		placements: inOrder([...(chain as Track).placements, copy])
	}));
	return { doc: next, index: (next.tracks.find((t) => t.id === track)?.placements ?? []).lastIndexOf(copy) };
}

// The clip a drag across an empty row draws, from the tick it was pressed at to the one it reached, either way: whole bars, from
// the start of the first to the end of the last. It stays in the gap it was pressed in, between the placements either side, so
// drawing one never makes an overlap. Null if there is no room.
export function drawnClip(
	doc: Timeline,
	track: number,
	from: number,
	to: number
): { tick: number; length: number } | null {
	const bar = ticksPerBar(doc);
	let tick = Math.floor(Math.min(from, to) / bar) * bar;
	let end = (Math.floor(Math.max(from, to) / bar) + 1) * bar;
	for (const placed of doc.tracks.find((t) => t.id === track)?.placements ?? []) {
		if (placed.tick <= from) tick = Math.max(tick, placed.tick + placementSpan(doc, placed));
		else end = Math.min(end, placed.tick);
	}
	return end > tick ? { tick, length: end - tick } : null;
}

// A clip long enough to hold a note that starts at `tick`:to the end of the bar it falls in, or as it was if it holds it already.
export function growToHold(clip: Clip, tick: number, ppq: number): Clip {
	if (tick < clip.length) return clip;
	return { ...clip, length: barOf(tick, ppq) * ppq * BEATS_PER_BAR };
}

// Whether a clip can be `length` long without any of its placements running into the one after it on its track. A placement
// that plays a window of its own length doesn't grow, and one that plays to the end of the clip grows each of its repeats. The
// compiler refuses a placement that starts before the last one has ended, so this is what keeps growing a clip from breaking
// a song that uses it somewhere out of sight.
export function canGrow(doc: Timeline, id: string, length: number): boolean {
	const clip = clipOf(doc, id);
	if (!clip) return false;
	const grown = setClip(doc, id, { ...clip, length });
	return grown.tracks.every((track) => {
		const placements = inOrder(track.placements);
		return placements.every((placed, at) => {
			const after = placements[at + 1];
			return placed.clip !== id || !after || placed.tick + placementSpan(grown, placed) <= after.tick;
		});
	});
}

// --------------------------------------------------------------------------------------------------------------- notes

export const addNote = (clip: Clip, note: Note): Clip => ({ ...clip, notes: [...clip.notes, note] });

export function removeNotes(clip: Clip, indices: Set<number>): Clip {
	return { ...clip, notes: clip.notes.filter((_, i) => !indices.has(i)) };
}

// The whole selection stops together at an edge, so that a chord keeps its shape.
export function moveNotes(clip: Clip, indices: Set<number>, ticks: number, notes: number): Clip {
	const chosen = clip.notes.filter((_, i) => indices.has(i));
	if (!chosen.length) return clip;
	const dt = Math.max(ticks, -Math.min(...chosen.map((n) => n.tick)));
	const low = -Math.min(...chosen.map((n) => n.note));
	const high = 127 - Math.max(...chosen.map((n) => n.note));
	const dn = Math.min(high, Math.max(low, notes));
	return {
		...clip,
		notes: clip.notes.map((n, i) => (indices.has(i) ? { ...n, tick: n.tick + dt, note: n.note + dn } : n))
	};
}

export function resizeNotes(clip: Clip, indices: Set<number>, ticks: number, shortest = 1): Clip {
	return {
		...clip,
		notes: clip.notes.map((n, i) => (indices.has(i) ? { ...n, dur: Math.max(shortest, n.dur + ticks) } : n))
	};
}

export function setNotes(clip: Clip, indices: Set<number>, change: Partial<Note>): Clip {
	return { ...clip, notes: clip.notes.map((n, i) => (indices.has(i) ? { ...n, ...change } : n)) };
}

const velocityOf = (value: number) => Math.min(127, Math.max(1, Math.round(value)));

// Velocities on a straight line from the earliest chosen note to the latest, as a crescendo or a diminuendo is written.
export function rampVelocities(clip: Clip, indices: Set<number>, from: number, to: number): Clip {
	const ticks = clip.notes.filter((_, i) => indices.has(i)).map((n) => n.tick);
	if (!ticks.length) return clip;
	const first = Math.min(...ticks);
	const last = Math.max(...ticks);
	return {
		...clip,
		notes: clip.notes.map((n, i) => {
			if (!indices.has(i)) return n;
			const t = last > first ? (n.tick - first) / (last - first) : 0;
			return { ...n, vel: velocityOf(from + (to - from) * t) };
		})
	};
}

// Each chosen velocity times `factor`, so their shape stays and the whole of it gets louder or softer.
export function scaleVelocities(clip: Clip, indices: Set<number>, factor: number): Clip {
	return {
		...clip,
		notes: clip.notes.map((n, i) => (indices.has(i) ? { ...n, vel: velocityOf(n.vel * factor) } : n))
	};
}

// Small, even nudges of up to `ticks` and `velocity` either way. They come from `seed`, so the same nudge of the same notes
// gives the same result.
export function humanize(clip: Clip, indices: Set<number>, ticks: number, velocity: number, seed = 1): Clip {
	let state = seed >>> 0 || 1;
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
	return {
		...clip,
		notes: clip.notes.map((n, i) => {
			const dt = Math.round((next() * 2 - 1) * ticks);
			const dv = Math.round((next() * 2 - 1) * velocity);
			if (!indices.has(i)) return n;
			return { ...n, tick: Math.min(clip.length - 1, Math.max(0, n.tick + dt)), vel: velocityOf(n.vel + dv) };
		})
	};
}

// Each chosen note's start moved `strength` of the way to the nearest line of the grid.
export function quantize(clip: Clip, indices: Set<number>, grid: number, strength = 1): Clip {
	return {
		...clip,
		notes: clip.notes.map((n, i) => {
			if (!indices.has(i)) return n;
			const tick = Math.round(n.tick + (snapTick(n.tick, grid) - n.tick) * strength);
			return { ...n, tick: Math.min(clip.length - 1, tick) };
		})
	};
}

// The copies follow straight after the selection and come back chosen, so that repeating this builds a pattern.
export function duplicateNotes(clip: Clip, indices: Set<number>): { clip: Clip; chosen: Set<number> } {
	const notes = clip.notes.filter((_, i) => indices.has(i));
	if (!notes.length) return { clip, chosen: indices };
	const first = Math.min(...notes.map((n) => n.tick));
	const last = Math.max(...notes.map((n) => n.tick + n.dur));
	const copies = notes.map((n) => ({ ...n, tick: n.tick + last - first }));
	const start = clip.notes.length;
	return {
		clip: { ...clip, notes: [...clip.notes, ...copies] },
		chosen: new Set(copies.map((_, i) => start + i))
	};
}

// --------------------------------------------------------------------------------------------------------------- lanes

export interface Lane {
	key: string;
	param?: number;
	target?: LaneTarget;
	points: { index: number; point: Point }[]; // By tick, and `index` is the place in `clip.automation`
}

export const laneKey = (param: number | undefined, target: LaneTarget | undefined) =>
	JSON.stringify([param ?? null, target ?? null]);

export function lanesOf(clip: Clip): Lane[] {
	const lanes = new Map<string, Lane>();
	clip.automation.forEach((point, index) => {
		const key = laneKey(point.param, point.target);
		const lane = lanes.get(key) ?? { key, param: point.param, target: point.target, points: [] };
		lane.points.push({ index, point });
		lanes.set(key, lane);
	});
	for (const lane of lanes.values()) lane.points.sort((a, b) => a.point.tick - b.point.tick);
	return [...lanes.values()];
}

export interface LaneChoice {
	key: string;
	label: string;
	param?: number;
	target?: LaneTarget;
	min: number;
	max: number;
	start: number; // Where a new lane's first point goes
}

const paramsOf = (patch: PatchLike | undefined): Param[] => patch?.graph.params ?? [];

function mixChoices(doc: Timeline, track: Track | undefined): LaneChoice[] {
	const choices: LaneChoice[] = [];
	const add = (label: string, target: LaneTarget, min: number, max: number, start: number) =>
		choices.push({ key: laneKey(undefined, target), label, target, min, max, start });
	if (track) {
		add('Fader', { mix: 'fader', track: track.id }, 0, 2, track.gain);
		add('Pan', { mix: 'pan', track: track.id }, -1, 1, track.pan);
		for (const send of track.sends) {
			add(`Send to ${send.bus}`, { mix: 'send', track: track.id, to: send.bus }, 0, 2, send.gain);
		}
	}
	for (const bus of doc.buses) {
		add(`${bus.id} fader`, { mix: 'fader', bus: bus.id }, 0, 2, bus.gain);
		add(`${bus.id} pan`, { mix: 'pan', bus: bus.id }, -1, 1, bus.pan);
	}
	add('Master fader', { mix: 'fader', master: true }, 0, 2, doc.master.gain);
	return choices;
}

// Everything a clip on this track can move. An insert with no id can't be named by a lane, so it isn't offered, and the mixer
// gives one to each insert it adds.
export function laneChoices(doc: Timeline, trackId: number | null, patches: PatchLike[]): LaneChoice[] {
	const track = doc.tracks.find((t) => t.id === trackId);
	const seen = new Set<number>();
	const choices: LaneChoice[] = [];
	for (const slot of track?.slots ?? []) {
		for (const param of paramsOf(patches.find((p) => p.id === slot))) {
			if (seen.has(param.id)) continue;
			seen.add(param.id);
			choices.push({
				key: laneKey(param.id, undefined),
				label: param.name || `Param ${param.id}`,
				param: param.id,
				min: param.min,
				max: param.max,
				start: track?.params[String(param.id)] ?? param.default
			});
		}
	}
	for (const chain of eachChain(doc)) {
		for (const insert of chain.inserts) {
			if (insert.id === undefined) continue;
			const patch = patches.find((p) => p.id === insert.patch);
			for (const param of paramsOf(patch)) {
				const target = { insert: insert.id };
				choices.push({
					key: laneKey(param.id, target),
					label: `${patch?.name ?? insert.patch} ${param.name || param.id}`,
					param: param.id,
					target,
					min: param.min,
					max: param.max,
					start: insert.params?.[String(param.id)] ?? param.default
				});
			}
		}
	}
	return [...choices, ...mixChoices(doc, track)];
}

// A lane's range and name come from what it moves. One that moves nothing the page knows of still has to draw, so its range
// comes from its own points.
export function describeLane(lane: Lane, choices: LaneChoice[]): { label: string; min: number; max: number } {
	const choice = choices.find((c) => c.key === lane.key);
	if (choice) return choice;
	const values = lane.points.map(({ point }) => point.value);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const label = lane.target ? JSON.stringify(lane.target) : `Param ${lane.param}`;
	return { label, min, max: max > min ? max : min + 1 };
}

const fromChoice = (choice: Pick<LaneChoice, 'param' | 'target'>) => ({
	...(choice.param === undefined ? {} : { param: choice.param }),
	...(choice.target === undefined ? {} : { target: choice.target })
});

export function addPoint(clip: Clip, lane: Pick<LaneChoice, 'param' | 'target'>, tick: number, value: number): Clip {
	return { ...clip, automation: [...clip.automation, { ...fromChoice(lane), tick, value }] };
}

export function setPoint(clip: Clip, index: number, change: Partial<Point>): Clip {
	return {
		...clip,
		automation: clip.automation.map((point, i) => {
			if (i !== index) return point;
			const next: Point = { ...point, ...change };
			if (next.ramp === 0 || next.ramp === undefined) delete next.ramp;
			if (next.curve === 'linear' || next.curve === undefined || next.ramp === undefined) delete next.curve;
			return next;
		})
	};
}

export function removePoint(clip: Clip, index: number): Clip {
	return { ...clip, automation: clip.automation.filter((_, i) => i !== index) };
}

export function removeLane(clip: Clip, key: string): Clip {
	return { ...clip, automation: clip.automation.filter((p) => laneKey(p.param, p.target) !== key) };
}

// Where an exp ramp stands a fraction of the way along it, as the compiler works it out: by equal ratios, and to or from 0
// by way of 60 dB below the other end.
export function curveAt(from: number, to: number, t: number): number {
	if (t >= 1) return to;
	if (t <= 0) return from;
	const a = from > 0 ? from : to * 0.001;
	const b = to > 0 ? to : from * 0.001;
	if (!(a > 0 && b > 0)) return from + (to - from) * t;
	return a * (b / a) ** t;
}

// The polyline a lane traces. A value holds until the next point's tick, and a ramp then runs from there to that point's value,
// in a straight line or along its curve. A ramp the next point interrupts stops where it had got to.
export function laneCurve(lane: Lane, length: number): { tick: number; value: number }[] {
	const curve: { tick: number; value: number }[] = [];
	const points = lane.points.map(({ point }) => point);
	points.forEach((point, i) => {
		const last = curve.at(-1);
		if (last && last.tick < point.tick) curve.push({ tick: point.tick, value: last.value });
		if (!point.ramp || !last) {
			curve.push({ tick: point.tick, value: point.value });
			return;
		}
		const from = last.value;
		const stop = Math.min(point.tick + point.ramp, points[i + 1]?.tick ?? Infinity);
		const at = (tick: number) => {
			const t = (tick - point.tick) / point.ramp!;
			return point.curve === 'exp' ? curveAt(from, point.value, t) : from + (point.value - from) * t;
		};
		const steps = point.curve === 'exp' ? 32 : 1;
		for (let k = 1; k <= steps; ++k) {
			const tick = point.tick + (point.ramp * k) / steps;
			if (tick >= stop) {
				curve.push({ tick: stop, value: at(stop) });
				break;
			}
			curve.push({ tick, value: at(tick) });
		}
	});
	const last = curve.at(-1);
	if (last && last.tick < length) curve.push({ tick: length, value: last.value });
	return curve;
}

// --------------------------------------------------------------------------------------------------------------- tempo

const byTick = (tempo: Tempo[]) => [...tempo].sort((a, b) => a.tick - b.tick);

// In order, and marked as a ramp only where a later change gives it somewhere to go, which the compiler insists on.
function tidy(tempo: Tempo[]): Tempo[] {
	const sorted = byTick(tempo);
	const last = sorted.at(-1)?.tick;
	return sorted.map(({ ramp, ...change }) => (ramp && change.tick !== last ? { ...change, ramp } : change));
}

// The tempo at a tick, as the compiler plays it: a change holds until the next, and a ramp glides to the next, linearly in
// bpm over ticks. The engine takes the ramp in steps of a 1/32 note, which this doesn't show. Before the first change it is
// the engine's own 120.
export function tempoAt(tempo: Tempo[], tick: number): number {
	const sorted = byTick(tempo);
	const at = sorted.findLastIndex((t) => t.tick <= tick);
	if (at < 0) return 120;
	const from = sorted[at];
	const to = sorted[at + 1];
	if (!from.ramp || !to) return from.bpm;
	return from.bpm + ((to.bpm - from.bpm) * (tick - from.tick)) / (to.tick - from.tick);
}

// A change added inside a ramp carries it on, so at the tempo the ramp had there, it leaves the curve as it was.
export function addTempo(doc: Timeline, tick: number, bpm: number): Timeline {
	if (doc.tempo.some((t) => t.tick === tick)) return doc;
	const before = byTick(doc.tempo).findLast((t) => t.tick < tick);
	const added: Tempo = before?.ramp ? { tick, bpm, ramp: true } : { tick, bpm };
	return { ...doc, tempo: tidy([...doc.tempo, added]) };
}

export function setTempo(doc: Timeline, index: number, change: Partial<Tempo>): Timeline {
	return { ...doc, tempo: tidy(doc.tempo.map((t, i) => (i === index ? { ...t, ...change } : t))) };
}

// The first one sets the tempo the song opens at, so it stays.
export function removeTempo(doc: Timeline, index: number): Timeline {
	return doc.tempo.length > 1 ? { ...doc, tempo: tidy(doc.tempo.filter((_, i) => i !== index)) } : doc;
}

export interface Settling {
	mix: { register: number; value: number }[];
	params: { track: number; param: number; value: number }[]; // `track` is its place in the image
	inserts: { insert: number; param: number; value: number }[];
}

interface ReportedProgram extends ReportedMixer {
	tracks: (ReportedChain & { index?: number })[];
	buses: ReportedChain[];
	inserts: { id: number; index: number }[];
}

// What to write after a swap so that the sound is the document. A swap carries live values across, because a fader moved by
// hand should survive an edit somewhere else, and the engine can't tell a value moved by hand from one left by a lane. So
// without this, a deleted lane's last value stays for as long as the page does, and a value changed in the document is ignored
// because the old one carried over it. A lane still in the document owns what it moves, so a pair holding that is left alone.
export function settlingWrites(doc: Timeline, program: ReportedProgram, patches: PatchLike[]): Settling {
	const placed = (track: Track) => track.placements.flatMap((p) => clipOf(doc, p.clip)?.automation ?? []);
	const lanes = doc.tracks.flatMap(placed);
	const moved = (key: ChainKey, of: MixFactor[], to: string | undefined) =>
		lanes.some(({ target: t }) => {
			if (!t || !('mix' in t)) return false;
			if ('master' in t) return of.includes('master');
			if (('track' in t ? trackKey(t.track) : busKey(t.bus)) !== key) return false;
			if (t.mix === 'send') return of.includes('send') && 'to' in t && to === busKey(t.to);
			return of.includes(t.mix);
		});

	const settling: Settling = { mix: [], params: [], inserts: [] };
	for (const { key, chain, pair, of, send, to } of eachPair(doc, program)) {
		if (moved(key, of, to)) continue;
		const gains = pairGains(doc, chain, of, send);
		settling.mix.push({ register: pair.left, value: gains.left }, { register: pair.right, value: gains.right });
	}

	const globalsDone = new Set<number>();
	for (const reported of program.tracks) {
		const track = doc.tracks.find((t) => t.id === reported.id);
		if (!track || reported.index === undefined) continue;
		const own = placed(track);
		const done = new Set<number>();
		for (const param of track.slots.flatMap((slot) => paramsOf(patches.find((p) => p.id === slot)))) {
			if (done.has(param.id)) continue;
			done.add(param.id);
			const global = param.scope === 'global';
			if (global && globalsDone.has(param.id)) continue;
			if ((global ? lanes : own).some((p) => p.param === param.id && !p.target)) continue;
			if (global) globalsDone.add(param.id);
			const value = (global ? doc.globals : track.params)[String(param.id)] ?? param.default;
			settling.params.push({ track: reported.index, param: param.id, value });
		}
	}

	for (const insert of eachChain(doc).flatMap((chain) => chain.inserts)) {
		const index = program.inserts.find((known) => known.id === insert.id)?.index;
		if (index === undefined) continue;
		for (const param of paramsOf(patches.find((p) => p.id === insert.patch))) {
			if (lanes.some((p) => p.param === param.id && p.target && 'insert' in p.target && p.target.insert === insert.id))
				continue;
			settling.inserts.push({
				insert: index,
				param: param.id,
				value: insert.params?.[String(param.id)] ?? param.default
			});
		}
	}
	return settling;
}

// ---------------------------------------------------------------------------------------------------------- play modes

// Poly plays every held note, so it has no priority to choose, and the compiler refuses one. A track with nothing to say
// about its mode says nothing, which keeps the Program from setting aside room for play modes it doesn't use.
export function setPlay(doc: Timeline, id: number, change: Partial<NonNullable<Track['play']>>): Timeline {
	const tracks = doc.tracks.map((track) => {
		if (track.id !== id) return track;
		const play = { mode: 'poly' as const, priority: 'last' as const, glide: 0, ...track.play, ...change };
		if (play.mode === 'poly') play.priority = 'last';
		if (play.mode !== 'legato' || !play.slur_velocity) delete play.slur_velocity;
		if (play.mode !== 'poly' || play.glide !== 0) return { ...track, play };
		const { play: _, ...rest } = track;
		return rest;
	});
	return { ...doc, tracks };
}

export function addPlayChange(clip: Clip, tick: number): Clip {
	return { ...clip, play: [...clip.play, { tick, mode: 'mono', priority: 'last', glide: 0 }] };
}

export function setPlayChange(clip: Clip, index: number, change: Partial<PlayChange>): Clip {
	return {
		...clip,
		play: clip.play.map((item, i) => {
			if (i !== index) return item;
			const next = { ...item, ...change };
			return next.mode === 'poly' ? { ...next, priority: 'last' as const } : next;
		})
	};
}

export function removePlayChange(clip: Clip, index: number): Clip {
	return { ...clip, play: clip.play.filter((_, i) => i !== index) };
}

// ------------------------------------------------------------------------------------------------------------ the rest

// Where a patch is used in a timeline, for telling someone what they are looking at and where a probe can reach it.
export type PatchUse = { kind: 'voice'; track: Track; slot: number } | { kind: 'insert'; chain: string };

export function patchUses(doc: Timeline, patch: string): PatchUse[] {
	const uses: PatchUse[] = [];
	for (const track of doc.tracks) {
		track.slots.forEach((slot, index) => {
			if (slot === patch) uses.push({ kind: 'voice', track, slot: index });
		});
		if (track.inserts.some((i) => i.patch === patch)) {
			uses.push({ kind: 'insert', chain: track.name || `Track ${track.id}` });
		}
	}
	for (const bus of doc.buses) {
		if (bus.inserts.some((i) => i.patch === patch)) uses.push({ kind: 'insert', chain: bus.id });
	}
	if (doc.master.inserts.some((i) => i.patch === patch)) uses.push({ kind: 'insert', chain: 'Master' });
	return uses;
}

// What a compile error says about the document, in the shape `timeline:"id"/track:1/clip:lead`.
export function placeOfError(where: string): { track: number | null; clip: string | null } {
	const track = /\/track:(\d+)/.exec(where);
	const clip = /\/clip:(.+)$/.exec(where);
	return { track: track ? Number(track[1]) : null, clip: clip ? clip[1] : null };
}
