// What the timeline editors do to a document, apart from drawing it. Every function returns a new value, which is what makes
// undo a list of old documents. As with graphs, little here decides what is legal: overlapping clips can still be drawn, and
// the compiler says what is wrong and where. What these do take care of is taking references along, because deleting a bus
// shouldn't leave a trail of errors about a name nobody can see any more.
import type { Graph, Param, Timeline } from '#lib/Schema.ts';
import { BEATS_PER_BAR, barOf, snapTick, ticksPerBar } from '#lib/Units.ts';

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

// A gain as a fader reads it, as the Mixer's and a track head's both do.
// Decibels, as every fader, meter and scope on the page writes them: one place, so they read alike everywhere. Silence is
// "silent" in words and "-∞" where only a figure fits, a track head's, until decision 18 settles one word for it.
export const toDecibels = (gain: number) => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);
export const decibels = (gain: number) => (gain > 0 ? `${toDecibels(gain).toFixed(1)} dB` : 'silent');
export const decibelFigure = (gain: number) => (gain > 0 ? toDecibels(gain).toFixed(1) : '-∞');

// A pan as a knob reads it: C in the middle, and L or R with how far, in percent.
export const panText = (pan: number) =>
	Math.round(pan * 100) === 0 ? 'C' : `${pan < 0 ? 'L' : 'R'}${Math.abs(Math.round(pan * 100))}`;

// The song as it sounds while some tracks are soloed: every other track muted, and the buses and the master as they are, so a
// soloed track's sends still reach their reverb, as solo works in most DAWs. Solo belongs to the editor and not the document,
// so this is what is compiled and heard, and never what is saved. A muted track stays muted when it is soloed, and a solo whose
// tracks have all gone solos nothing.
export function soloed<T extends { tracks: { id: number; mute?: boolean }[] }>(doc: T, solo: ReadonlySet<number>): T {
	if (!doc.tracks.some((track) => solo.has(track.id))) return doc;
	return {
		...doc,
		tracks: doc.tracks.map((track) => (solo.has(track.id) || track.mute ? track : { ...track, mute: true }))
	};
}

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

// What Mod+C takes from the arrangement: a placement, and its clip as it was then, which is what reaches another timeline.
export interface CopiedPlacement {
	placement: Placement;
	clip: Clip;
}

// How long a copied placement lasts, every repeat of its window, by its clip as it was copied.
export const copiedSpan = ({ placement, clip }: CopiedPlacement) =>
	placementSpan({ clips: [clip] } as Timeline, placement);

// A copied placement put on a track at a tick, and the index it lands at. It plays the clip it was copied from, as a copy
// dragged off with Mod does, while this timeline has that clip as it was copied. Otherwise it plays a copy of the clip as it
// was, under a name of its own, which is how a clip reaches another timeline or outlives an edit made since.
export function pastePlacement(
	doc: Timeline,
	track: number,
	tick: number,
	copied: CopiedPlacement
): { doc: Timeline; index: number } {
	if (!doc.tracks.some((t) => t.id === track)) return { doc, index: -1 };
	const same = clipOf(doc, copied.clip.id);
	let id = copied.clip.id;
	let next = doc;
	if (!same || JSON.stringify(same) !== JSON.stringify(copied.clip)) {
		id = freshClipId(doc, copied.clip.id);
		next = { ...doc, clips: [...doc.clips, { ...copied.clip, id }] };
	}
	const placed = { ...copied.placement, clip: id, tick };
	next = mapChain(next, trackKey(track), (chain) => ({
		...chain,
		placements: inOrder([...(chain as Track).placements, placed])
	}));
	return { doc: next, index: (next.tracks.find((t) => t.id === track)?.placements ?? []).lastIndexOf(placed) };
}

// Where a paste lands. In the clip or on the track it was copied from, straight after what was copied, and after a paste the
// next one straight after that one, so pasting again and again lays copies end to end, as Mod+D does. Anywhere else, at the
// place it was copied from, and from there end to end. `at` is where the copy starts and `span` how long it lasts.
export function pasteAt<K>(copied: { from: K; at: number; span: number }, last: { to: K; at: number } | null, here: K) {
	if (last && last.to === here) return last.at + copied.span;
	return here === copied.from ? copied.at + copied.span : copied.at;
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

// From the first of some notes' starts to the last of their ends, which is how far apart a duplicate or a paste puts copies.
export function noteSpan(notes: Note[]): number {
	if (!notes.length) return 0;
	return Math.max(...notes.map((n) => n.tick + n.dur)) - Math.min(...notes.map((n) => n.tick));
}

// Copied notes put into a clip with the first of them at `tick` and the rest as far from it as they were. They come back
// chosen, as a duplicate's do.
export function pasteNotes(clip: Clip, notes: Note[], tick: number): { clip: Clip; chosen: Set<number> } {
	if (!notes.length) return { clip, chosen: new Set() };
	const first = Math.min(...notes.map((n) => n.tick));
	const copies = notes.map((n) => ({ ...n, tick: n.tick - first + tick }));
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
	label: string; // What the lane is called where it is drawn, on its own
	group: string; // What it belongs to, which the list of choices groups them under: a patch, an insert, or the mix
	name: string; // What it is called within its group
	param?: number;
	target?: LaneTarget;
	min: number;
	max: number;
	start: number; // Where a new lane's first point goes
	// It moves more than its own track: the mix, an insert or a global. A track with no notes never plays, and the compiler
	// refuses such a lane on one, as it would be lost without a sound.
	reaches?: true;
}

const paramsOf = (patch: PatchLike | undefined): Param[] => patch?.graph.params ?? [];

function mixChoices(doc: Timeline, track: Track | undefined): LaneChoice[] {
	const choices: LaneChoice[] = [];
	const add = (label: string, target: LaneTarget, min: number, max: number, start: number) =>
		choices.push({
			key: laneKey(undefined, target),
			label,
			group: 'Mix',
			name: label,
			target,
			min,
			max,
			start,
			reaches: true
		});
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
		const patch = patches.find((p) => p.id === slot);
		for (const param of paramsOf(patch)) {
			if (seen.has(param.id)) continue;
			seen.add(param.id);
			const name = param.name || `Param ${param.id}`;
			choices.push({
				key: laneKey(param.id, undefined),
				label: name,
				group: patch?.name ?? slot,
				name,
				param: param.id,
				min: param.min,
				max: param.max,
				start: track?.params[String(param.id)] ?? param.default,
				...(param.scope === 'global' ? { reaches: true as const } : {})
			});
		}
	}
	for (const chain of eachChain(doc)) {
		const on = 'slots' in chain ? chain.name || `Track ${chain.id}` : 'id' in chain ? `bus ${chain.id}` : 'the master';
		for (const insert of chain.inserts) {
			if (insert.id === undefined) continue;
			const patch = patches.find((p) => p.id === insert.patch);
			for (const param of paramsOf(patch)) {
				const target = { insert: insert.id };
				const name = param.name || `Param ${param.id}`;
				choices.push({
					key: laneKey(param.id, target),
					label: `${patch?.name ?? insert.patch} ${name}`,
					group: `${patch?.name ?? insert.patch} on ${on}`,
					name,
					param: param.id,
					target,
					min: param.min,
					max: param.max,
					start: insert.params?.[String(param.id)] ?? param.default,
					reaches: true
				});
			}
		}
	}
	return [...choices, ...mixChoices(doc, track)];
}

// A lane's range and name come from what it moves. One that moves nothing the page knows of still has to draw, so its range
// comes from its own points. `start` is where what it moves stands before the lane moves it, if the page knows.
export function describeLane(
	lane: Lane,
	choices: LaneChoice[]
): { label: string; min: number; max: number; start?: number } {
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

// These change the document's points as they are, each holding its value from its tick or ramping from there for its own
// ticks. What a lane's own gestures do, which keeps points joined by lines, is further down: `addLanePoint` and the rest.
export function addPoint(clip: Clip, lane: Pick<LaneChoice, 'param' | 'target'>, tick: number, value: number): Clip {
	return { ...clip, automation: [...clip.automation, { ...fromChoice(lane), tick, value }] };
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

// What one point of a lane does as the compiler plays it (Compiler.hpp, `compile_clip`): from `begin`, its tick, the lane goes
// from where it is then, `from`, to the point's value, at once or by `due` in a line or along its curve. A point that comes
// before that cuts it short, so it stops at `end` where it had got to.
interface Run {
	index: number;
	point: Point;
	begin: number;
	due: number;
	end: number;
	from: number;
	exp: boolean;
}

function runValue(run: Run, tick: number): number {
	if (tick >= run.due) return run.point.value;
	if (tick <= run.begin) return run.from;
	const t = (tick - run.begin) / (run.due - run.begin);
	return run.exp ? curveAt(run.from, run.point.value, t) : run.from + (run.point.value - run.from) * t;
}

// A lane's points in the order the compiler takes them, which is by tick and then as the clip lists them, and what each does.
// Before the first, the lane's target is wherever it stood, which is `start` if the page knows it and the first point's own
// value if it doesn't.
function runsOf(lane: Lane, start?: number): Run[] {
	const runs: Run[] = [];
	for (const { index, point } of lane.points) {
		const last = runs.at(-1);
		if (last && last.end > point.tick) last.end = Math.max(last.begin, point.tick);
		const from = last ? runValue(last, point.tick) : (start ?? point.value);
		const due = point.tick + (point.ramp ?? 0);
		runs.push({ index, point, begin: point.tick, due, end: due, from, exp: point.curve === 'exp' && due > point.tick });
	}
	return runs;
}

// The polyline a lane traces, which is what the compiler plays. A value holds until the next point's tick, and a ramp then
// runs from there to that point's value, in a straight line or along its curve. A ramp the next point interrupts stops where
// it had got to. Before its first point a lane draws nothing, unless that point ramps, from `start`.
export function laneCurve(lane: Lane, length: number, start?: number): { tick: number; value: number }[] {
	const curve: { tick: number; value: number }[] = [];
	for (const run of runsOf(lane, start)) {
		const last = curve.at(-1);
		if (last && last.tick < run.begin) curve.push({ tick: run.begin, value: last.value });
		if (run.due === run.begin) {
			curve.push({ tick: run.begin, value: run.point.value });
			continue;
		}
		if (!last) curve.push({ tick: run.begin, value: run.from });
		const steps = run.exp ? 32 : 1;
		for (let k = 1; k <= steps; ++k) {
			const tick = run.begin + ((run.due - run.begin) * k) / steps;
			if (tick >= run.end) {
				curve.push({ tick: run.end, value: runValue(run, run.end) });
				break;
			}
			curve.push({ tick, value: runValue(run, tick) });
		}
	}
	const last = curve.at(-1);
	if (last && last.tick < length) curve.push({ tick: length, value: last.value });
	return curve;
}

// ---------------------------------------------------------------------------------------------------------- lane points

// How a lane gets to a point from the one before: at once, or over the point's ramp, in a straight line or along an exp curve.
export type Shape = 'step' | 'line' | 'exp';
export const SHAPES: Shape[] = ['step', 'line', 'exp'];

// A point as a lane shows it: where the lane gets to its value, and how. The document keeps a ramp at the tick it starts, which
// is where the compiler starts it, so a point that ramps shows `ramp` ticks after its own tick, where the ramp ends. A line
// from the point before is then a ramp that starts at that point, which is how a lane's points stay joined.
export interface LanePoint {
	index: number; // Its place in `clip.automation`
	tick: number; // Where the lane gets to `value`
	value: number;
	ramp: number; // How long it takes to get there from where it starts, which is 0 for a step
	shape: Shape;
}

// A lane's points as it shows them, in the order it gets to them. A ramp that the next point cuts short shows where it had got
// to, which is what plays.
export function lanePoints(lane: Lane, start?: number): LanePoint[] {
	const points = runsOf(lane, start).map((run) => {
		const ramp = run.end - run.begin;
		const shape: Shape = !ramp ? 'step' : run.exp ? 'exp' : 'line';
		return { index: run.index, tick: run.end, value: runValue(run, run.end), ramp, shape };
	});
	return points.sort((a, b) => a.tick - b.tick);
}

// Where the line into the point at `k` would start: the point before, or for the first, the start of the clip.
const before = (points: { tick: number }[], k: number) => (k > 0 ? points[k - 1].tick : 0);

// A point joined to the one before by a line or a curve, which ramps over all of the gap between them.
const isJoined = (points: LanePoint[], k: number) =>
	points[k].shape !== 'step' && points[k].tick - points[k].ramp === before(points, k);

interface Laid extends LanePoint {
	joined: boolean; // Whether it stays joined to whatever point comes before it
	mine?: true; // The point the edit was for, whose place comes back with it
}

// The document's point for a lane point: its ramp where it starts, and nothing it doesn't need.
function written(base: Point, point: Pick<LanePoint, 'tick' | 'value' | 'ramp' | 'shape'>): Point {
	const { ramp: _, curve: __, ...rest } = base;
	const next: Point = { ...rest, tick: point.tick - point.ramp, value: point.value };
	if (point.ramp > 0 && point.shape !== 'step') {
		next.ramp = point.ramp;
		if (point.shape === 'exp') next.curve = 'exp';
	}
	return next;
}

const samePoint = (a: Point, b: Point) =>
	a.tick === b.tick &&
	a.value === b.value &&
	(a.ramp ?? 0) === (b.ramp ?? 0) &&
	(a.curve ?? 'linear') === (b.curve ?? 'linear');

// Lays out one lane again after an edit to its points. Each point that was joined to the one before it stays joined to
// whatever point comes before it now, or the clip's start if none does. Any other ramp keeps its length, short enough not to
// start before the point before it. Each point stays at its place in `clip.automation`, and one the edit adds goes on the end.
// Points that start at one tick play in the order the clip lists them, so a step and the line that starts from it are put in
// the order the lane gets to them: the step first.
function relay(
	clip: Clip,
	lane: Pick<Lane, 'key' | 'param' | 'target'>,
	start: number | undefined,
	edit: (points: Laid[]) => Laid[]
): { clip: Clip; index: number } {
	const found = lanesOf(clip).find((l) => l.key === lane.key);
	const shown = found ? lanePoints(found, start) : [];
	const laid = edit(shown.map((point, k) => ({ ...point, joined: isJoined(shown, k) })));
	laid.sort((a, b) => a.tick - b.tick);
	laid.forEach((point, k) => {
		const gap = point.tick - before(laid, k);
		point.ramp = point.joined ? gap : Math.min(point.ramp, gap);
		if (!point.ramp) point.shape = 'step';
	});

	// What each place in `clip.automation` holds now. A point that comes out as it was stays as it was, keys and all.
	const template = { ...fromChoice(lane), tick: 0, value: 0 };
	type Entry = { point: Point; rank?: number; mine?: true };
	const rewritten = new Map<number, Entry>();
	const added: Entry[] = [];
	laid.forEach((point, rank) => {
		const old = point.index >= 0 ? clip.automation[point.index] : undefined;
		const next = written(old ?? template, point);
		const entry: Entry = { point: old && samePoint(old, next) ? old : next, rank, ...(point.mine && { mine: true }) };
		if (old) rewritten.set(point.index, entry);
		else added.push(entry);
	});
	const own = new Set(found?.points.map(({ index }) => index) ?? []);
	const entries: Entry[] = clip.automation.flatMap((point, i) => {
		if (!own.has(i)) return [{ point }];
		const entry = rewritten.get(i);
		return entry ? [entry] : [];
	});
	const ordered = inPlayOrder([...entries, ...added]);
	const index = ordered.findIndex((entry) => entry.mine);
	const same = ordered.length === clip.automation.length && ordered.every((e, i) => e.point === clip.automation[i]);
	return { clip: same ? clip : { ...clip, automation: ordered.map((entry) => entry.point) }, index };
}

// The compiler takes points that start at one tick in the order the clip lists them, so a lane's points that do are put in
// the order the lane gets to them, `rank`, in the places they already have. Points that start at different ticks stay where
// they are, wherever the clip lists them.
function inPlayOrder<T extends { point: Point; rank?: number }>(entries: T[]): T[] {
	const groups = new Map<string, number[]>();
	entries.forEach((entry, i) => {
		if (entry.rank === undefined) return;
		const key = JSON.stringify([laneKey(entry.point.param, entry.point.target), entry.point.tick]);
		groups.set(key, [...(groups.get(key) ?? []), i]);
	});
	const ordered = [...entries];
	for (const places of groups.values()) {
		const byRank = places.map((i) => entries[i]).sort((a, b) => a.rank! - b.rank!);
		places.forEach((place, k) => (ordered[place] = byRank[k]));
	}
	return ordered;
}

// A point added where a click puts it. After another it is joined to that one by a line, or by a curve if it lands on one, and
// the point after it, if that was joined to the one before, is joined to it instead. A lane's first point is a step. Its
// place in `clip.automation` comes back with it.
export function addLanePoint(
	clip: Clip,
	lane: Pick<LaneChoice, 'key' | 'param' | 'target'>,
	tick: number,
	value: number,
	start?: number
): { clip: Clip; index: number } {
	return relay(clip, lane, start, (points) => {
		const next = points.find((point) => point.tick > tick);
		const shape: Shape = !points.some((point) => point.tick < tick)
			? 'step'
			: next?.joined && next.shape === 'exp'
				? 'exp'
				: 'line';
		return [...points, { index: -1, tick, value, ramp: 0, shape, joined: shape !== 'step', mine: true }];
	});
}

// A point moved, or its value, ramp or shape changed. A point moved keeps its line from the point before it, whichever that is
// now, and the lines into the points either side stay joined. A line or a curve given to a step ramps from the point before,
// and a ramp is never longer than the gap it fills. The point's place in `clip.automation` comes back with it.
export function setLanePoint(
	clip: Clip,
	index: number,
	change: Partial<Pick<LanePoint, 'tick' | 'value' | 'ramp' | 'shape'>>,
	start?: number
): { clip: Clip; index: number } {
	const point = clip.automation[index];
	if (!point) return { clip, index };
	const lane = { key: laneKey(point.param, point.target), param: point.param, target: point.target };
	return relay(clip, lane, start, (points) =>
		points.map((old) => {
			if (old.index !== index) return old;
			const next: Laid = { ...old, mine: true };
			if (change.tick !== undefined) next.tick = Math.max(0, change.tick);
			if (change.value !== undefined) next.value = change.value;
			if (change.shape) {
				next.shape = change.shape;
				if (change.shape === 'step') next.ramp = 0;
				if (change.shape === 'step' || old.shape === 'step') next.joined = change.shape !== 'step';
			}
			if (change.ramp !== undefined) {
				next.ramp = Math.max(0, change.ramp);
				next.joined = false; // A ramp as long as the gap or longer fills it, and so joins them
				if (!next.ramp) next.shape = 'step';
				else if (next.shape === 'step') next.shape = 'line';
			}
			return next;
		})
	);
}

// A point taken out. The point after it, if it was joined to it, is joined to the one before it instead, or to the clip's
// start if there is none, and the point before it holds if there is none after.
export function removeLanePoint(clip: Clip, index: number, start?: number): Clip {
	const point = clip.automation[index];
	if (!point) return clip;
	const lane = { key: laneKey(point.param, point.target), param: point.param, target: point.target };
	return relay(clip, lane, start, (points) => points.filter((p) => p.index !== index)).clip;
}

// --------------------------------------------------------------------------------------------------------------- tempo

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
