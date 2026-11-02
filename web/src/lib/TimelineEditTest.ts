import { describe, expect, it } from 'vitest';
import { timelineSchema, type Timeline } from '#lib/Schema.ts';
import {
	addBus,
	addClip,
	addInsert,
	addNote,
	addPoint,
	addSend,
	addTempo,
	addTrack,
	barOf,
	busKey,
	describeLane,
	duplicateClip,
	duplicateNotes,
	grids,
	laneChoices,
	laneCurve,
	laneKey,
	lanesOf,
	makeUnique,
	MASTER,
	mixWrites,
	moveInsert,
	moveNotes,
	movePlacement,
	noteName,
	patchUses,
	place,
	placeOfError,
	removeBus,
	removeClip,
	removeInsert,
	removeLane,
	removeNotes,
	removePlacement,
	removePoint,
	removeSend,
	removeTempo,
	removeTrack,
	renameClip,
	resizeNotes,
	routeGains,
	setInsertPatch,
	setPlacement,
	setPoint,
	setTempo,
	snapTick,
	songLength,
	trackKey,
	type Clip,
	type LaneTarget,
	type PatchLike
} from '#lib/TimelineEdit.ts';

const clipNamed = (id: string, length = 1920, notes: Partial<Clip['notes'][number]>[] = []): Clip => ({
	id,
	length,
	notes: notes.map((n) => ({ tick: 0, note: 60, vel: 100, dur: 240, ...n })),
	automation: [],
	play: []
});

const song = (): Timeline =>
	timelineSchema.parse({
		clips: [clipNamed('a'), clipNamed('b', 960)],
		tracks: [
			{
				id: 1,
				slots: ['lead'],
				placements: [
					{ clip: 'a', tick: 0, repeat: 2 },
					{ clip: 'b', tick: 3840 }
				],
				sends: [{ bus: 'room', gain: 0.5 }],
				inserts: [{ id: 1, patch: 'duck', key: 'track:2' }]
			},
			{ id: 2, slots: ['pluck'], placements: [{ clip: 'a', tick: 0 }], output: 'bus:room' }
		],
		buses: [{ id: 'room', inserts: [{ id: 2, patch: 'verb' }] }],
		master: { gain: 0.5 }
	});

const lane = (clip: Clip, target: LaneTarget) => addPoint(clip, { target }, 0, 1);

describe('the grid', () => {
	it('offers whole ticks at any ppq, down to one', () => {
		for (const ppq of [1, 7, 96, 480]) {
			for (const { ticks } of grids(ppq)) {
				expect(Number.isInteger(ticks)).toBe(true);
				expect(ticks).toBeGreaterThan(0);
			}
		}
		expect(grids(480).find((g) => g.label === '1/16')?.ticks).toBe(120);
	});

	it('snaps to the nearest line and never before the start', () => {
		expect(snapTick(130, 120)).toBe(120);
		expect(snapTick(190, 120)).toBe(240);
		expect(snapTick(-200, 120)).toBe(0);
		expect(snapTick(17, 1)).toBe(17);
	});

	it('names notes with 60 as C4, and bars from one', () => {
		expect(noteName(60)).toBe('C4');
		expect(noteName(61)).toBe('C#4');
		expect(noteName(0)).toBe('C-1');
		expect(noteName(127)).toBe('G9');
		expect(barOf(0, 480)).toBe(1);
		expect(barOf(1919, 480)).toBe(1);
		expect(barOf(1920, 480)).toBe(2);
	});

	it('measures a song to the end of its last repeat', () => {
		expect(songLength(song())).toBe(4800);
		expect(songLength(timelineSchema.parse({}))).toBe(0);
	});
});

describe('placements', () => {
	it('stay in tick order, which is how the compiler reads them', () => {
		const doc = place(song(), 1, 'b', 1920);
		expect(doc.tracks[0].placements.map((p) => p.tick)).toEqual([0, 1920, 3840]);
		const moved = setPlacement(doc, 1, 2, { tick: 960 });
		expect(moved.tracks[0].placements.map((p) => p.tick)).toEqual([0, 960, 1920]);
	});

	it('move between tracks', () => {
		const doc = movePlacement(song(), 1, 1, 2, 7680);
		expect(doc.tracks[0].placements).toHaveLength(1);
		expect(doc.tracks[1].placements.map((p) => [p.clip, p.tick])).toEqual([
			['a', 0],
			['b', 7680]
		]);
	});

	it('keep their repeat when moved', () => {
		const doc = movePlacement(song(), 1, 0, 1, 480);
		expect(doc.tracks[0].placements[0]).toEqual({ clip: 'a', tick: 480, repeat: 2 });
	});

	it('come out one at a time', () => {
		expect(removePlacement(song(), 1, 0).tracks[0].placements.map((p) => p.clip)).toEqual(['b']);
	});

	it('leave the other uses of a clip alone when made unique', () => {
		const { doc, id } = makeUnique(song(), 1, 0);
		expect(id).toBe('a-2');
		expect(doc.tracks[0].placements[0].clip).toBe('a-2');
		expect(doc.tracks[1].placements[0].clip).toBe('a');
		expect(doc.clips.map((c) => c.id)).toEqual(['a', 'b', 'a-2']);
	});
});

describe('clips', () => {
	it('get a name nothing else has', () => {
		const first = addClip(song(), 1920);
		const second = addClip(first.doc, 1920);
		expect([first.id, second.id]).toEqual(['clip', 'clip-2']);
		expect(duplicateClip(second.doc, 'clip').id).toBe('clip-3');
	});

	it('take their placements along when renamed', () => {
		const doc = renameClip(song(), 'a', 'verse');
		expect(doc.clips[0].id).toBe('verse');
		expect(doc.tracks.flatMap((t) => t.placements).map((p) => p.clip)).toEqual(['verse', 'b', 'verse']);
	});

	it("can't take a name already in use", () => {
		const doc = song();
		expect(renameClip(doc, 'a', 'b')).toBe(doc);
		expect(renameClip(doc, 'a', '')).toBe(doc);
	});

	it('take their placements with them when removed', () => {
		const doc = removeClip(song(), 'a');
		expect(doc.tracks.flatMap((t) => t.placements).map((p) => p.clip)).toEqual(['b']);
	});
});

describe('notes', () => {
	const clip = clipNamed('c', 1920, [
		{ tick: 0, note: 60 },
		{ tick: 240, note: 64 },
		{ tick: 480, note: 67 }
	]);

	it('move as one shape, stopping together at the edges', () => {
		const left = moveNotes(clip, new Set([1, 2]), -1000, 0);
		expect(left.notes.map((n) => n.tick)).toEqual([0, 0, 240]);
		const high = moveNotes(clip, new Set([0, 2]), 0, 100);
		expect(high.notes.map((n) => n.note)).toEqual([120, 64, 127]);
		const low = moveNotes(clip, new Set([0, 1]), 0, -100);
		expect(low.notes.map((n) => n.note)).toEqual([0, 4, 67]);
	});

	it('leave the rest alone', () => {
		const moved = moveNotes(clip, new Set([1]), 120, 1);
		expect(moved.notes[0]).toEqual(clip.notes[0]);
		expect(moved.notes[2]).toEqual(clip.notes[2]);
		expect(moved.notes[1]).toMatchObject({ tick: 360, note: 65 });
	});

	it('never get shorter than a grid line', () => {
		expect(resizeNotes(clip, new Set([0]), -1000, 120).notes[0].dur).toBe(120);
		expect(resizeNotes(clip, new Set([0]), 120).notes[0].dur).toBe(360);
	});

	it('duplicate straight after the selection, with the copies chosen', () => {
		const { clip: next, chosen } = duplicateNotes(clip, new Set([0, 1]));
		expect(next.notes.slice(3).map((n) => n.tick)).toEqual([480, 720]);
		expect([...chosen]).toEqual([3, 4]);
	});

	it('come out by index', () => {
		expect(removeNotes(clip, new Set([0, 2])).notes.map((n) => n.note)).toEqual([64]);
	});
});

describe('lanes', () => {
	const a: LaneTarget = { mix: 'fader', track: 1 };

	it('group points by what they move, sorted by tick', () => {
		let clip = addPoint(clipNamed('c'), { param: 1 }, 480, 0.5);
		clip = addPoint(clip, { param: 1 }, 0, 0.25);
		clip = addPoint(clip, { target: a }, 0, 1);
		const lanes = lanesOf(clip);
		expect(lanes.map((l) => l.points.length)).toEqual([2, 1]);
		expect(lanes[0].points.map((p) => p.point.tick)).toEqual([0, 480]);
		expect(lanes[0].points.map((p) => p.index)).toEqual([1, 0]);
		expect(lanes[1].target).toEqual(a);
	});

	it('hold a value, then ramp from the next point for its own ticks', () => {
		let clip = addPoint(clipNamed('c'), { param: 1 }, 0, 0);
		clip = addPoint(clip, { param: 1 }, 480, 1);
		clip = setPoint(clip, 1, { ramp: 480 });
		expect(laneCurve(lanesOf(clip)[0], 1920)).toEqual([
			{ tick: 0, value: 0 },
			{ tick: 480, value: 0 },
			{ tick: 960, value: 1 },
			{ tick: 1920, value: 1 }
		]);
	});

	it('step where there is no ramp', () => {
		let clip = addPoint(clipNamed('c'), { param: 1 }, 0, 0);
		clip = addPoint(clip, { param: 1 }, 480, 1);
		expect(laneCurve(lanesOf(clip)[0], 960).map((p) => [p.tick, p.value])).toEqual([
			[0, 0],
			[480, 0],
			[480, 1],
			[960, 1]
		]);
	});

	it('drop a ramp of nothing, so a document only says what it means', () => {
		const clip = setPoint(addPoint(clipNamed('c'), { param: 1 }, 0, 0), 0, { ramp: 0 });
		expect(clip.automation[0]).not.toHaveProperty('ramp');
	});

	it('come out a point or a lane at a time', () => {
		let clip = addPoint(clipNamed('c'), { param: 1 }, 0, 0);
		clip = addPoint(clip, { param: 2 }, 0, 0);
		expect(removePoint(clip, 0).automation.map((p) => p.param)).toEqual([2]);
		expect(removeLane(clip, laneKey(2, undefined)).automation.map((p) => p.param)).toEqual([1]);
	});

	const patches: PatchLike[] = [
		{
			id: 'lead',
			name: 'Lead',
			graph: {
				nodes: [],
				edges: [],
				params: [{ id: 1, name: 'cutoff', scope: 'track', min: 80, max: 12000, default: 900, smooth_ms: 10 }]
			}
		},
		{
			id: 'verb',
			name: 'Verb',
			graph: {
				nodes: [],
				edges: [],
				params: [{ id: 3, name: 'mix', scope: 'track', min: 0, max: 1, default: 0.3, smooth_ms: 10 }]
			}
		}
	];

	it('are offered for the track, its inserts and the mixer', () => {
		const labels = laneChoices(song(), 1, patches).map((c) => c.label);
		expect(labels).toEqual([
			'cutoff',
			'Verb mix',
			'Fader',
			'Pan',
			'Send to room',
			'room fader',
			'room pan',
			'Master fader'
		]);
	});

	it('start where the document already is', () => {
		const doc = { ...song() };
		doc.tracks[0] = { ...doc.tracks[0], params: { '1': 4000 } };
		expect(laneChoices(doc, 1, patches).find((c) => c.label === 'cutoff')?.start).toBe(4000);
	});

	it('still draw if nothing on the page can name what they move', () => {
		const clip = addPoint(addPoint(clipNamed('c'), { param: 9 }, 0, 2), { param: 9 }, 480, 4);
		expect(describeLane(lanesOf(clip)[0], [])).toEqual({ label: 'Param 9', min: 2, max: 4 });
		const flat = addPoint(clipNamed('c'), { param: 9 }, 0, 2);
		expect(describeLane(lanesOf(flat)[0], []).max).toBe(3);
	});
});

describe('the mixer', () => {
	it('works out what the compiler writes to a route', () => {
		const doc = song();
		const track = doc.tracks[0];
		const { left, right } = routeGains(doc, track, MASTER);
		expect(left).toBeCloseTo(0.5 * Math.SQRT1_2, 6);
		expect(right).toBeCloseTo(0.5 * Math.SQRT1_2, 6);
		const send = routeGains(doc, track, busKey('room'));
		expect(send.left).toBeCloseTo(0.5 * Math.SQRT1_2, 6); // The master fader is only on the way to master
	});

	it('goes silent on a mute', () => {
		const doc = song();
		doc.tracks[0] = { ...doc.tracks[0], mute: true };
		expect(routeGains(doc, doc.tracks[0], MASTER)).toEqual({ left: 0, right: 0 });
	});

	const program = {
		tracks: [
			{
				id: 1,
				mix: [
					{ to: 'master', left: 0, right: 1 },
					{ to: 'bus:room', left: 2, right: 3 }
				]
			},
			{ id: 2, mix: [{ to: 'bus:room', left: 4, right: 5 }] }
		],
		buses: [{ id: 'room', mix: [{ to: 'master', left: 6, right: 7 }] }]
	};

	it('writes every route out of the chain that moved', () => {
		const registers = mixWrites(song(), program, trackKey(1)).map((w) => w.register);
		expect(registers).toEqual([0, 1, 2, 3]);
		expect(mixWrites(song(), program, busKey('room')).map((w) => w.register)).toEqual([6, 7]);
	});

	it('writes every route into master when the master fader moves', () => {
		expect(mixWrites(song(), program, MASTER).map((w) => w.register)).toEqual([0, 1, 6, 7]);
	});

	it('runs inserts in the order it is given, within bounds', () => {
		let doc = addInsert(song(), trackKey(1), 'a');
		doc = addInsert(doc, trackKey(1), 'b');
		doc = moveInsert(doc, trackKey(1), 2, -1);
		expect(doc.tracks[0].inserts.map((i) => i.patch)).toEqual(['duck', 'b', 'a']);
		expect(moveInsert(doc, trackKey(1), 0, -1).tracks[0].inserts).toEqual(doc.tracks[0].inserts);
		expect(moveInsert(doc, trackKey(1), 2, 1).tracks[0].inserts).toEqual(doc.tracks[0].inserts);
	});

	it('gives each insert an id no chain is using', () => {
		const doc = addInsert(song(), MASTER, 'limiter');
		expect(doc.master.inserts[0].id).toBe(3);
	});

	it('forgets an old patch\'s values and lanes when an insert changes patch', () => {
		const doc = song();
		doc.tracks[0] = { ...doc.tracks[0], inserts: [{ id: 1, patch: 'duck', params: { '1': 2 } }] };
		doc.clips[0] = addPoint(doc.clips[0], { param: 1, target: { insert: 1 } }, 0, 1);
		const next = setInsertPatch(doc, trackKey(1), 0, 'other');
		expect(next.tracks[0].inserts[0]).toEqual({ id: 1, patch: 'other' });
		expect(next.clips[0].automation).toEqual([]);
	});

	it('takes an insert\'s lanes when it goes', () => {
		const doc = song();
		doc.clips[0] = addPoint(doc.clips[0], { param: 1, target: { insert: 1 } }, 0, 1);
		doc.clips[0] = addPoint(doc.clips[0], { param: 1 }, 0, 1);
		const next = removeInsert(doc, trackKey(1), 0);
		expect(next.clips[0].automation.map((p) => p.target)).toEqual([undefined]);
	});

	it('takes a send\'s lane when it goes, and no other chain\'s', () => {
		const doc = addSend(song(), trackKey(2), 'room');
		doc.clips[0] = lane(lane(doc.clips[0], { mix: 'send', track: 1, to: 'room' }), { mix: 'send', track: 2, to: 'room' });
		const next = removeSend(doc, trackKey(1), 0);
		expect(next.tracks[0].sends).toEqual([]);
		expect(next.clips[0].automation.map((p) => p.target)).toEqual([{ mix: 'send', track: 2, to: 'room' }]);
	});

	it('refuses a bus name in use by staying as it was', () => {
		const doc = song();
		expect(addBus(doc, 'room')).toBe(doc);
		expect(addBus(doc, '')).toBe(doc);
		expect(addBus(doc, 'delay').buses.map((b) => b.id)).toEqual(['room', 'delay']);
	});

	it('takes everything that named a bus along with it', () => {
		const doc = song();
		doc.clips[0] = lane(lane(doc.clips[0], { mix: 'fader', bus: 'room' }), { mix: 'send', track: 1, to: 'room' });
		doc.clips[0] = addPoint(doc.clips[0], { param: 1, target: { insert: 2 } }, 0, 1);
		doc.clips[0] = lane(doc.clips[0], { mix: 'fader', track: 1 });
		const next = removeBus(doc, 'room');
		expect(next.buses).toEqual([]);
		expect(next.tracks[0].sends).toEqual([]);
		expect(next.tracks[1].output).toBe(MASTER);
		expect(next.clips[0].automation.map((p) => p.target)).toEqual([{ mix: 'fader', track: 1 }]);
	});

	it('takes everything that named a track along with it', () => {
		const doc = song();
		doc.clips[0] = lane(lane(doc.clips[0], { mix: 'fader', track: 2 }), { mix: 'fader', track: 1 });
		const next = removeTrack(doc, 2);
		expect(next.tracks.map((t) => t.id)).toEqual([1]);
		expect(next.tracks[0].inserts[0]).not.toHaveProperty('key'); // The sidechain came from track 2
		expect(next.clips[0].automation.map((p) => p.target)).toEqual([{ mix: 'fader', track: 1 }]);
	});

	it('numbers a new track after the highest', () => {
		const { doc, id } = addTrack(song(), 'lead');
		expect(id).toBe(3);
		expect(doc.tracks[2]).toMatchObject({ id: 3, name: 'Track 3', slots: ['lead'], output: 'master' });
	});
});

describe('tempo', () => {
	it('stays in order', () => {
		let doc = addTempo(song(), 1920, 90);
		doc = addTempo(doc, 960, 100);
		expect(doc.tempo.map((t) => t.tick)).toEqual([0, 960, 1920]);
		expect(setTempo(doc, 1, { tick: 2000 }).tempo.map((t) => t.tick)).toEqual([0, 1920, 2000]);
	});

	it('has one change per tick', () => {
		const doc = addTempo(song(), 0, 90);
		expect(doc.tempo).toEqual([{ tick: 0, bpm: 120 }]);
	});

	it('always keeps one', () => {
		const doc = removeTempo(song(), 0);
		expect(doc.tempo).toHaveLength(1);
		expect(removeTempo(addTempo(doc, 960, 90), 1).tempo).toHaveLength(1);
	});
});

describe('reading a document', () => {
	it('says where a patch is used', () => {
		const uses = patchUses(song(), 'verb');
		expect(uses).toEqual([{ kind: 'insert', chain: 'room' }]);
		const voice = patchUses(song(), 'pluck')[0];
		expect(voice).toMatchObject({ kind: 'voice', slot: 0 });
		expect(patchUses(song(), 'nothing')).toEqual([]);
	});

	it('finds what an error is about', () => {
		expect(placeOfError('timeline:"song"/track:1/clip:lead-a')).toEqual({ track: 1, clip: 'lead-a' });
		expect(placeOfError('timeline:"song"/track:12')).toEqual({ track: 12, clip: null });
		expect(placeOfError('timeline:"song"/bus:room')).toEqual({ track: null, clip: null });
		expect(placeOfError('patch:lead/node:3')).toEqual({ track: null, clip: null });
	});

	it('adds notes without disturbing the ones there', () => {
		const clip = addNote(clipNamed('c', 960, [{ tick: 0 }]), { tick: 120, note: 62, vel: 90, dur: 60 });
		expect(clip.notes.map((n) => n.note)).toEqual([60, 62]);
	});
});
