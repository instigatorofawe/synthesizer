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
export type PlayChange = Clip['play'][number];
export type LaneTarget = NonNullable<Point['target']>;
export type Insert = Track['inserts'][number];
export type Send = Track['sends'][number];
export type Tempo = Timeline['tempo'][number];

export interface PatchLike {
	id: string;
	name: string;
	graph: Graph;
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

// Where the last placement ends. The compiler reports this too, but only for a document that compiles.
export function songLength(doc: Timeline): number {
	let end = 0;
	for (const track of doc.tracks) {
		for (const placed of track.placements) {
			end = Math.max(end, placed.tick + placed.repeat * (clipOf(doc, placed.clip)?.length ?? 0));
		}
	}
	return end;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// With 60 as C4, which is what most tools show and all that a name can do here: the engine only sees the number.
export const noteName = (note: number) => `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
export const isBlackKey = (note: number) => NOTE_NAMES[note % 12].length > 1;

export const barOf = (tick: number, ppq: number) => Math.floor(tick / (ppq * BEATS_PER_BAR)) + 1;

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

// What goes into the mix registers for one route, which is what the compiler writes for them: a fader, its mute and its pan,
// a send's own gain if this is a send, and the master fader if it lands on master.
export function routeGains(doc: Timeline, chain: Track | Bus, to: ChainKey) {
	const send = to === chain.output ? 1 : (chain.sends.find((s) => busKey(s.bus) === to)?.gain ?? 0);
	const gain = chain.gain * (chain.mute ? 0 : 1) * send * (to === MASTER ? doc.master.gain : 1);
	return {
		left: gain * Math.sin(((1 - chain.pan) * Math.PI) / 4),
		right: gain * Math.sin(((1 + chain.pan) * Math.PI) / 4)
	};
}

interface ReportedChain {
	id: number | string;
	mix: { to: string; left: number; right: number }[];
}

// The register writes that make a change to this chain audible before the compile that follows it. The master fader is in
// every route into master, so moving it writes all of those.
export function mixWrites(
	doc: Timeline,
	program: { tracks: ReportedChain[]; buses: ReportedChain[] },
	key: ChainKey
): { register: number; value: number }[] {
	const writes: { register: number; value: number }[] = [];
	const add = (chain: Track | Bus | undefined, routes: ReportedChain['mix'], only: ChainKey | null) => {
		if (!chain) return;
		for (const route of routes) {
			if (only !== null && route.to !== only) continue;
			const { left, right } = routeGains(doc, chain, route.to);
			writes.push({ register: route.left, value: left }, { register: route.right, value: right });
		}
	};
	const onMaster = key === MASTER;
	for (const reported of program.tracks) {
		if (onMaster || trackKey(reported.id as number) === key) {
			add(doc.tracks.find((t) => t.id === reported.id), reported.mix, onMaster ? MASTER : null);
		}
	}
	for (const reported of program.buses) {
		if (onMaster || busKey(String(reported.id)) === key) {
			add(doc.buses.find((b) => b.id === reported.id), reported.mix, onMaster ? MASTER : null);
		}
	}
	return writes;
}

export function addSend(doc: Timeline, key: ChainKey, bus: string): Timeline {
	return mapChain(doc, key, (chain) => ('sends' in chain ? { ...chain, sends: [...chain.sends, { bus, gain: 0.5 }] } : chain));
}

export function setSend(doc: Timeline, key: ChainKey, index: number, change: Partial<Send>): Timeline {
	return mapChain(doc, key, (chain) =>
		'sends' in chain ? { ...chain, sends: chain.sends.map((s, i) => (i === index ? { ...s, ...change } : s)) } : chain
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
		return 'bus' in named ? 'bus' in target && target.bus === named.bus : 'track' in target && target.track === named.track;
	});
}

const insertIds = (doc: Timeline) => eachChain(doc).flatMap((c) => c.inserts.flatMap((i) => (i.id === undefined ? [] : [i.id])));

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
		inserts: []
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

export function setPlacement(doc: Timeline, track: number, index: number, change: Partial<Track['placements'][number]>) {
	return mapPlacements(doc, (t) =>
		t.id === track ? inOrder(t.placements.map((p, i) => (i === index ? { ...p, ...change } : p))) : t.placements
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

// The polyline a lane traces. A value holds until the next point's tick, and a ramp then runs from there to that point's value.
export function laneCurve(lane: Lane, length: number): { tick: number; value: number }[] {
	const curve: { tick: number; value: number }[] = [];
	for (const { point } of lane.points) {
		const last = curve.at(-1);
		if (last) curve.push({ tick: point.tick, value: last.value });
		if (point.ramp) {
			if (last) curve.push({ tick: point.tick + point.ramp, value: point.value });
			else curve.push({ tick: point.tick, value: point.value });
		} else {
			curve.push({ tick: point.tick, value: point.value });
		}
	}
	const last = curve.at(-1);
	if (last && last.tick < length) curve.push({ tick: length, value: last.value });
	return curve;
}

// --------------------------------------------------------------------------------------------------------------- tempo

const byTick = (tempo: Tempo[]) => [...tempo].sort((a, b) => a.tick - b.tick);

export function addTempo(doc: Timeline, tick: number, bpm: number): Timeline {
	if (doc.tempo.some((t) => t.tick === tick)) return doc;
	return { ...doc, tempo: byTick([...doc.tempo, { tick, bpm }]) };
}

export function setTempo(doc: Timeline, index: number, change: Partial<Tempo>): Timeline {
	return { ...doc, tempo: byTick(doc.tempo.map((t, i) => (i === index ? { ...t, ...change } : t))) };
}

// The first one sets the tempo the song opens at, so it stays.
export function removeTempo(doc: Timeline, index: number): Timeline {
	return doc.tempo.length > 1 ? { ...doc, tempo: doc.tempo.filter((_, i) => i !== index) } : doc;
}

// ------------------------------------------------------------------------------------------------------------ the rest

// Where a patch is used in a timeline, for telling someone what they are looking at and where a probe can reach it.
export type PatchUse =
	| { kind: 'voice'; track: Track; slot: number }
	| { kind: 'insert'; chain: string };

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
