import { describe, expect, it } from 'vitest';
import { timelineSchema, type Timeline } from '#lib/Schema.ts';
import {
	addBus,
	addClip,
	addInsert,
	addNote,
	addPlayChange,
	addPoint,
	addSend,
	addTempo,
	addTrack,
	barOf,
	busKey,
	byOwner,
	canGrow,
	copiedSpan,
	describeLane,
	drawnClip,
	drawLengths,
	duplicateClip,
	duplicateNotes,
	duplicatePlacement,
	grids,
	growToHold,
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
	noteSpan,
	noteValue,
	pasteAt,
	pasteNotes,
	pastePlacement,
	patchUses,
	place,
	placeOfError,
	position,
	removeBus,
	removeClip,
	removeInsert,
	removeLane,
	removeNotes,
	removePlacement,
	removePlayChange,
	removePoint,
	removeSend,
	removeTempo,
	removeTrack,
	renameClip,
	replacePatch,
	resizeNotes,
	routeGains,
	curveAt,
	decibels,
	faderGain,
	faderPosition,
	panText,
	humanize,
	placementSpan,
	quantize,
	rampVelocities,
	scaleVelocities,
	setSend,
	windowOf,
	setInsertPatch,
	setPlacement,
	setPlay,
	setPlayChange,
	setPoint,
	settlingWrites,
	setTempo,
	setTrack,
	tempoAt,
	snapTick,
	soloed,
	songLength,
	stepLength,
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

describe('built-in patches', () => {
	it('swaps a patch for its copy everywhere it plays, and keeps what it was set to', () => {
		const doc = timelineSchema.parse({
			...song(),
			tracks: [
				...song().tracks,
				{ id: 3, slots: ['pluck', 'verb'], inserts: [{ id: 3, patch: 'verb', params: { 1: 0.5 } }] }
			],
			master: { inserts: [{ id: 4, patch: 'verb' }] }
		});
		const next = replacePatch(doc, 'verb', 'mine');
		expect(next.buses[0].inserts[0]).toEqual({ id: 2, patch: 'mine' });
		expect(next.tracks[2].slots).toEqual(['pluck', 'mine']);
		expect(next.tracks[2].inserts[0]).toEqual({ id: 3, patch: 'mine', params: { 1: 0.5 } });
		expect(next.master.inserts[0].patch).toBe('mine');
		expect(next.tracks[0]).toEqual(doc.tracks[0]);
		expect(replacePatch(doc, 'nothing', 'mine')).toEqual(doc);
	});

	it("lists a library's own patches apart from the built-in ones", () => {
		const graph = { params: [], nodes: [], edges: [] };
		const patches = [
			{ id: 'a', name: 'A', graph, builtin: true },
			{ id: 'b', name: 'B', graph },
			{ id: 'c', name: 'C', graph, builtin: false }
		];
		const { own, builtin } = byOwner(patches);
		expect(own.map((p) => p.id)).toEqual(['b', 'c']);
		expect(builtin.map((p) => p.id)).toEqual(['a']);
	});
});

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

	it('duplicate where they end, with their repeats and window, and say where the copy landed', () => {
		const trimmed = setPlacement(song(), 2, 0, { start: 480, transpose: 12, repeat: 3 });
		const { doc, index } = duplicatePlacement(trimmed, 2, 0);
		expect(index).toBe(1);
		expect(doc.tracks[1].placements[1]).toEqual({ clip: 'a', tick: 4320, repeat: 3, start: 480, transpose: 12 });
		const onto = duplicatePlacement(song(), 1, 0); // It lands on b, which the compiler will call an overlap
		expect(onto.doc.tracks[0].placements.map((p) => [p.clip, p.tick])).toEqual([
			['a', 0],
			['b', 3840],
			['a', 3840]
		]);
		expect(onto.index).toBe(2);
	});

	it('are drawn in whole bars across a row, either way, and stay in the gap they were drawn in', () => {
		const doc = song(); // Track 2 plays a from 0 to 1920. Track 1 plays a twice and then b, to 4800.
		expect(drawnClip(doc, 2, 2000, 5000)).toEqual({ tick: 1920, length: 3840 });
		expect(drawnClip(doc, 2, 5000, 2000)).toEqual({ tick: 1920, length: 3840 });
		expect(drawnClip(doc, 2, 2000, 2100)).toEqual({ tick: 1920, length: 1920 });
		expect(drawnClip(doc, 1, 5000, 100)).toEqual({ tick: 4800, length: 960 }); // From where b ends
		expect(drawnClip(place(doc, 2, 'b', 5000), 2, 2000, 9000)).toEqual({ tick: 1920, length: 3080 }); // To where b starts
		expect(drawnClip(doc, 2, 100, 200)).toBeNull(); // Pressed inside a, which fills that bar
	});

	it('paste on a track, playing the clip they were copied from while it is as it was', () => {
		const doc = song();
		const copied = { placement: { ...doc.tracks[0].placements[0], transpose: 5 }, clip: doc.clips[0] };
		expect(copiedSpan(copied)).toBe(3840); // Twice a bar
		const linked = pastePlacement(doc, 2, 1920, copied);
		expect(linked.doc.clips).toEqual(doc.clips);
		expect(linked.doc.tracks[1].placements).toEqual([
			{ clip: 'a', tick: 0, repeat: 1 },
			{ clip: 'a', tick: 1920, repeat: 2, transpose: 5 }
		]);
		expect(linked.index).toBe(1);
	});

	it('paste a copy of the clip as it was when it has changed since, or is in another timeline', () => {
		const doc = song();
		const copied = { placement: doc.tracks[1].placements[0], clip: { ...doc.clips[0], length: 960 } };
		const changed = pastePlacement(doc, 1, 9600, copied);
		expect(changed.doc.clips.map((c) => [c.id, c.length])).toEqual([
			['a', 1920],
			['b', 960],
			['a-2', 960]
		]);
		expect(changed.doc.tracks[0].placements[changed.index]).toEqual({ clip: 'a-2', tick: 9600, repeat: 1 });

		const elsewhere = timelineSchema.parse({ tracks: [{ id: 7, slots: ['x'] }] });
		const reached = pastePlacement(elsewhere, 7, 0, { placement: doc.tracks[1].placements[0], clip: doc.clips[0] });
		expect(reached.doc.clips).toEqual([doc.clips[0]]);
		expect(reached.doc.tracks[0].placements).toEqual([{ clip: 'a', tick: 0, repeat: 1 }]);
		expect(pastePlacement(elsewhere, 1, 0, copied)).toEqual({ doc: elsewhere, index: -1 }); // No such track
	});

	it('paste after what was copied where it came from, and at its own place anywhere else', () => {
		const copied = { from: 1, at: 960, span: 1920 };
		expect(pasteAt(copied, null, 1)).toBe(2880);
		expect(pasteAt(copied, { to: 1, at: 2880 }, 1)).toBe(4800); // End to end
		expect(pasteAt(copied, { to: 1, at: 2880 }, 2)).toBe(960);
		expect(pasteAt(copied, { to: 2, at: 960 }, 2)).toBe(2880);
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

	it('paste with the first of them where it says and the rest as far from it as they were, chosen', () => {
		const copied = [clip.notes[1], clip.notes[2]];
		expect(noteSpan(copied)).toBe(480); // From 240 to the end of the one at 480
		expect(noteSpan([])).toBe(0);
		const { clip: next, chosen } = pasteNotes(clip, copied, 1920);
		expect(next.notes.slice(3).map((n) => [n.tick, n.note])).toEqual([
			[1920, 64],
			[2160, 67]
		]);
		expect([...chosen]).toEqual([3, 4]);
		expect(pasteNotes(clip, [], 0).clip).toBe(clip);
	});
});

describe('note entry', () => {
	it('reads a position as bar.beat.tick, counting bars and beats from one', () => {
		expect(position(0, 480)).toBe('1.1.000');
		expect(position(1440, 480)).toBe('1.4.000');
		expect(position(1920 + 480 + 60, 480)).toBe('2.2.060');
		expect(position(7, 96)).toBe('1.1.007');
		expect(position(1000, 960)).toBe('1.2.040');
	});

	it('names a length as a note value, or in ticks when none fits', () => {
		expect(noteValue(240, 480)).toBe('1/8');
		expect(noteValue(360, 480)).toBe('3/16');
		expect(noteValue(1920, 480)).toBe('1 bar');
		expect(noteValue(3840, 480)).toBe('2 bars');
		expect(noteValue(2400, 480)).toBe('5/4');
		expect(noteValue(160, 480)).toBe('160 ticks'); // A triplet
		expect(noteValue(1, 480)).toBe('1 tick');
		expect(noteValue(12, 96)).toBe('1/32');
	});

	it('offers Draw lengths from a 1/32 to a bar, where the ppq holds them in whole ticks', () => {
		expect(drawLengths(480)).toEqual([
			{ label: '1/32', ticks: 60 },
			{ label: '1/16', ticks: 120 },
			{ label: '1/8', ticks: 240 },
			{ label: '1/4', ticks: 480 },
			{ label: '1/2', ticks: 960 },
			{ label: '1 bar', ticks: 1920 }
		]);
		expect(drawLengths(7).map((d) => d.label)).toEqual(['1/4', '1/2', '1 bar']);
		expect(drawLengths(1).map((d) => d.ticks)).toEqual([1, 2, 4]);
	});

	it('steps the Draw length to the next value either way, from any length, and stops at the ends', () => {
		expect(stepLength(240, 480, 1)).toBe(480);
		expect(stepLength(240, 480, -1)).toBe(120);
		expect(stepLength(360, 480, 1)).toBe(480); // A dotted 1/8 steps to the values either side of it
		expect(stepLength(360, 480, -1)).toBe(240);
		expect(stepLength(1920, 480, 1)).toBe(1920);
		expect(stepLength(60, 480, -1)).toBe(60);
		expect(stepLength(5000, 480, -1)).toBe(1920);
	});
});

describe('growing a clip', () => {
	it('grows to the end of the bar that holds a note, and not for a note it holds already', () => {
		const clip = clipNamed('c', 1920);
		expect(growToHold(clip, 1919, 480)).toBe(clip);
		expect(growToHold(clip, 1920, 480).length).toBe(3840);
		expect(growToHold(clip, 5000, 480).length).toBe(5760);
		expect(growToHold(clipNamed('c', 5280), 5300, 480).length).toBe(5760); // From 2.75 bars to 3
		expect(growToHold(clip, 2000, 480).notes).toBe(clip.notes);
	});

	it('is safe while no repeat of any placement of the clip runs into the next placement on its track', () => {
		// Clip a repeats twice from 0 on track 1, so it ends where b starts at 3840. On track 2 nothing follows it.
		const doc = song();
		expect(canGrow(doc, 'a', 1920)).toBe(true);
		expect(canGrow(doc, 'a', 1921)).toBe(false);
		expect(canGrow(doc, 'b', 96000)).toBe(true);
		const spaced = setPlacement(doc, 1, 1, { tick: 7680 });
		expect(canGrow(spaced, 'a', 3840)).toBe(true); // Two repeats of 3840 end at 7680, where b starts
		expect(canGrow(spaced, 'a', 3841)).toBe(false);
		expect(canGrow(doc, 'nothing', 3840)).toBe(false);
	});

	it('checks every track the clip is placed on, and a placement of it that follows another', () => {
		const doc = place(song(), 2, 'b', 2880); // Track 2 plays a from 0 to 1920, then b
		expect(canGrow(doc, 'a', 2880)).toBe(false);
		const twice = place(timelineSchema.parse({ clips: [clipNamed('a')], tracks: [{ id: 1 }] }), 1, 'a', 0);
		const again = place(twice, 1, 'a', 1920);
		expect(canGrow(again, 'a', 1920)).toBe(true);
		expect(canGrow(again, 'a', 2400)).toBe(false);
		expect(canGrow(twice, 'a', 2400)).toBe(true); // The last placement on its track grows freely
	});

	it("leaves out a placement that plays a window of its own length, which doesn't grow", () => {
		const doc = setPlacement(song(), 1, 0, { length: 960 }); // Two repeats of 960 end at 1920, well before b
		expect(canGrow(doc, 'a', 9600)).toBe(true);
		expect(canGrow(setPlacement(doc, 1, 0, { start: 480, length: 1440 }), 'a', 9600)).toBe(false); // To the end again
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

	it('mutes every track but those soloed, and leaves the buses and what was muted as they are', () => {
		const doc = song();
		const solo = soloed(doc, new Set([2]));
		expect(solo.tracks.map((t) => t.mute)).toEqual([true, false]);
		expect(solo.buses).toBe(doc.buses);
		expect(doc.tracks[0].mute).toBe(false); // The document itself is left as it was
		const muted = setTrack(doc, 2, { mute: true });
		expect(soloed(muted, new Set([2])).tracks.map((t) => t.mute)).toEqual([true, true]);
		expect(soloed(doc, new Set())).toBe(doc);
		expect(soloed(doc, new Set([9]))).toBe(doc); // A soloed track that has gone solos nothing
		expect(soloed(doc, new Set([1, 2]))).toEqual(doc);
		// The registers a solo writes are a mute's
		expect(mixWrites(solo, program, trackKey(1)).map((w) => w.value)).toEqual([0, 0, 0, 0]);
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

	it("forgets an old patch's values and lanes when an insert changes patch", () => {
		const doc = song();
		doc.tracks[0] = { ...doc.tracks[0], inserts: [{ id: 1, patch: 'duck', params: { '1': 2 } }] };
		doc.clips[0] = addPoint(doc.clips[0], { param: 1, target: { insert: 1 } }, 0, 1);
		const next = setInsertPatch(doc, trackKey(1), 0, 'other');
		expect(next.tracks[0].inserts[0]).toEqual({ id: 1, patch: 'other' });
		expect(next.clips[0].automation).toEqual([]);
	});

	it("takes an insert's lanes when it goes", () => {
		const doc = song();
		doc.clips[0] = addPoint(doc.clips[0], { param: 1, target: { insert: 1 } }, 0, 1);
		doc.clips[0] = addPoint(doc.clips[0], { param: 1 }, 0, 1);
		const next = removeInsert(doc, trackKey(1), 0);
		expect(next.clips[0].automation.map((p) => p.target)).toEqual([undefined]);
	});

	it("takes a send's lane when it goes, and no other chain's", () => {
		const doc = addSend(song(), trackKey(2), 'room');
		doc.clips[0] = lane(lane(doc.clips[0], { mix: 'send', track: 1, to: 'room' }), {
			mix: 'send',
			track: 2,
			to: 'room'
		});
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

describe('settling after a swap', () => {
	const param = (id: number, scope: 'track' | 'voice' | 'global', value = 0.5) => ({
		id,
		name: '',
		scope,
		min: 0,
		max: 1,
		default: value,
		smooth_ms: 10
	});
	const patch = (id: string, ...params: ReturnType<typeof param>[]): PatchLike => ({
		id,
		name: id,
		graph: { nodes: [], edges: [], params }
	});
	const patches = [
		patch('lead', param(1, 'track'), param(9, 'global', 0.25)),
		patch('pluck', param(9, 'global', 0.25)),
		patch('duck', param(4, 'track', 0.75))
	];
	const program = {
		tracks: [
			{ id: 1, index: 0, mix: [{ to: 'master', left: 0, right: 1 }] },
			{ id: 2, index: 1, mix: [{ to: 'bus:room', left: 2, right: 3 }] }
		],
		buses: [{ id: 'room', mix: [{ to: 'master', left: 4, right: 5 }] }],
		inserts: [
			{ id: 1, index: 0 },
			{ id: 2, index: 1 }
		]
	};
	const withLane = (doc: Timeline, lane: { param?: number; target?: LaneTarget }) => ({
		...doc,
		clips: doc.clips.map((clip) => (clip.id === 'a' ? addPoint(clip, lane, 0, 0) : clip))
	});
	const registers = (doc: Timeline) => settlingWrites(doc, program, patches).mix.map((w) => w.register);

	it('writes every value the document holds when nothing moves them', () => {
		const doc = song();
		doc.tracks[0] = { ...doc.tracks[0], params: { '1': 0.9 } };
		doc.globals = { '9': 0.125 };
		const { mix, params, inserts } = settlingWrites(doc, program, patches);
		expect(mix.map((w) => w.register)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(params).toEqual([
			{ track: 0, param: 1, value: 0.9 },
			{ track: 0, param: 9, value: 0.125 }
		]);
		expect(inserts).toEqual([{ insert: 0, param: 4, value: 0.75 }]);
	});

	it('uses the same gains the mixer would', () => {
		const doc = song();
		const { left } = routeGains(doc, doc.tracks[0], MASTER);
		expect(settlingWrites(doc, program, patches).mix.find((w) => w.register === 0)?.value).toBe(left);
	});

	it('leaves alone a chain a lane is moving, all of whose routes share its fader', () => {
		const doc = withLane(song(), { target: { mix: 'fader', track: 1 } });
		expect(registers(doc)).toEqual([2, 3, 4, 5]);
		const panned = withLane(song(), { target: { mix: 'pan', bus: 'room' } });
		expect(registers(panned)).toEqual([0, 1, 2, 3]);
	});

	it('leaves every route into master to a master lane', () => {
		expect(registers(withLane(song(), { target: { mix: 'fader', master: true } }))).toEqual([2, 3]);
	});

	it('leaves a parameter to its lane, on the track that plays it', () => {
		const doc = withLane(song(), { param: 1 });
		expect(settlingWrites(doc, program, patches).params.map((p) => p.param)).toEqual([9]);
	});

	it('leaves a global to a lane on any track', () => {
		const doc = withLane(song(), { param: 9 });
		expect(settlingWrites(doc, program, patches).params.map((p) => p.param)).toEqual([1]);
	});

	it("leaves an insert parameter to its lane, and no other insert's", () => {
		const own = withLane(song(), { param: 4, target: { insert: 1 } });
		expect(settlingWrites(own, program, patches).inserts).toEqual([]);
		const other = withLane(song(), { param: 4, target: { insert: 2 } });
		expect(settlingWrites(other, program, patches).inserts).toHaveLength(1);
	});

	it('takes back what a lane left, the moment the lane goes', () => {
		const doc = withLane(song(), { target: { mix: 'fader', track: 1 } });
		const gone = { ...doc, clips: doc.clips.map((clip) => ({ ...clip, automation: [] })) };
		expect(registers(doc)).not.toContain(0);
		expect(registers(gone)).toContain(0);
	});

	it('ignores a lane in a clip nothing plays', () => {
		const doc = song();
		doc.clips.push(addPoint(clipNamed('unused'), { param: 1 }, 0, 0));
		expect(settlingWrites(doc, program, patches).params.map((p) => p.param)).toContain(1);
	});

	it('says nothing about a track or insert the image has no room for', () => {
		const empty = { tracks: [], buses: [], inserts: [] };
		expect(settlingWrites(song(), empty, patches)).toEqual({ mix: [], params: [], inserts: [] });
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

	const ramp = {
		...song(),
		tempo: [
			{ tick: 0, bpm: 120, ramp: true },
			{ tick: 1920, bpm: 60 }
		]
	};

	it('holds a change until the next, and glides along a ramp to it', () => {
		const held = [
			{ tick: 480, bpm: 90 },
			{ tick: 960, bpm: 140 }
		];
		expect([0, 480, 700, 960, 5000].map((tick) => tempoAt(held, tick))).toEqual([120, 90, 90, 140, 140]);
		expect([0, 480, 960, 1920, 3000].map((tick) => tempoAt(ramp.tempo, tick))).toEqual([120, 105, 90, 60, 60]);
		// The compiler refuses a ramp with nowhere to go, and until it is fixed the tempo just holds.
		expect(tempoAt([{ tick: 0, bpm: 100, ramp: true }], 960)).toBe(100);
	});

	it('carries a ramp on through a change added inside it, so the curve stays as it was', () => {
		const doc = addTempo(ramp, 960, tempoAt(ramp.tempo, 960));
		expect(doc.tempo).toEqual([
			{ tick: 0, bpm: 120, ramp: true },
			{ tick: 960, bpm: 90, ramp: true },
			{ tick: 1920, bpm: 60 }
		]);
		for (const tick of [0, 480, 960, 1440, 1920]) expect(tempoAt(doc.tempo, tick)).toBe(tempoAt(ramp.tempo, tick));
		expect(addTempo(ramp, 3840, 60).tempo.at(-1)).toEqual({ tick: 3840, bpm: 60 });
	});

	it('marks a ramp only where a later change gives it somewhere to go', () => {
		expect(removeTempo(ramp, 1).tempo).toEqual([{ tick: 0, bpm: 120 }]);
		expect(setTempo(ramp, 1, { ramp: true }).tempo[1]).toEqual({ tick: 1920, bpm: 60 });
		expect(setTempo(ramp, 0, { ramp: false }).tempo[0]).toEqual({ tick: 0, bpm: 120 });
	});
});

describe('play modes', () => {
	it('say nothing on a track that plays the default way', () => {
		const mono = setPlay(song(), 1, { mode: 'mono', priority: 'high' });
		expect(mono.tracks[0].play).toEqual({ mode: 'mono', priority: 'high', glide: 0 });
		expect(setPlay(mono, 1, { mode: 'poly' }).tracks[0]).not.toHaveProperty('play');
	});

	it('keep a glide on a poly track, and never a priority', () => {
		const doc = setPlay(setPlay(song(), 1, { mode: 'mono', priority: 'low' }), 1, { mode: 'poly', glide: 0.1 });
		expect(doc.tracks[0].play).toEqual({ mode: 'poly', priority: 'last', glide: 0.1 });
	});

	it('change partway through a clip', () => {
		let clip = addPlayChange(clipNamed('c'), 480);
		clip = setPlayChange(clip, 0, { priority: 'low' });
		expect(clip.play).toEqual([{ tick: 480, mode: 'mono', priority: 'low', glide: 0 }]);
		expect(setPlayChange(clip, 0, { mode: 'poly' }).play[0].priority).toBe('last');
		expect(removePlayChange(clip, 0).play).toEqual([]);
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

describe('the gaps the pieces found', () => {
	it('refuse a field the compiler would refuse, rather than drop it', () => {
		const doc = song();
		const typo = { ...doc, clips: [{ ...doc.clips[0], notes: [{ tick: 0, note: 60, dur: 10, velocity: 30 }] }] };
		expect(timelineSchema.safeParse(typo).success).toBe(false);
		expect(timelineSchema.safeParse({ ...doc, swing: 0.6 }).success).toBe(false);
		const placed = { ...doc.tracks[0], placements: [{ clip: 'a', tick: 0, transpose: 12, velocity: 0.5, start: 10 }] };
		expect(timelineSchema.safeParse({ ...doc, tracks: [placed] }).success).toBe(true);
	});

	it('play a window of a clip, and last as long as its repeats of it', () => {
		const doc = song(); // clip a is 1920 ticks
		expect(windowOf(doc, { clip: 'a', tick: 0, repeat: 1 })).toEqual({ start: 0, length: 1920 });
		expect(windowOf(doc, { clip: 'a', tick: 0, repeat: 1, start: 480 })).toEqual({ start: 480, length: 1440 });
		expect(placementSpan(doc, { clip: 'a', tick: 0, repeat: 3, start: 480, length: 240 })).toBe(720);
		const trimmed = setPlacement(doc, 1, 1, { length: 240, repeat: 2 });
		expect(songLength(trimmed)).toBe(3840 + 480);
	});

	it('say only what differs from playing the whole clip as it is', () => {
		const doc = setPlacement(song(), 1, 0, { transpose: 0, velocity: 1, start: 0, length: 1920 });
		expect(doc.tracks[0].placements[0]).toEqual({ clip: 'a', tick: 0, repeat: 2 });
		const moved = setPlacement(song(), 1, 0, { transpose: -12, start: 480 });
		expect(moved.tracks[0].placements[0]).toEqual({ clip: 'a', tick: 0, repeat: 2, transpose: -12, start: 480 });
	});

	it('write a stage when the control it holds moves by hand', () => {
		const program = {
			tracks: [
				{
					id: 1,
					mix: [
						{ to: 'master', left: 0, right: 1, of: ['pan' as const] },
						{ to: 'bus:room', left: 2, right: 3, of: ['mute' as const, 'send' as const], pre: true }
					],
					stages: [{ left: 8, right: 9, of: ['fader' as const] }]
				}
			],
			buses: [{ id: 'room', mix: [{ to: 'master', left: 4, right: 5, of: ['fader' as const, 'pan' as const] }] }],
			master: { stages: [{ left: 6, right: 7, of: ['master' as const] }] }
		};
		const doc = song();
		expect(mixWrites(doc, program, trackKey(1)).map((w) => w.register)).toEqual([0, 1, 2, 3, 8, 9]);
		expect(mixWrites(doc, program, MASTER)).toEqual([
			{ register: 6, value: 0.5 },
			{ register: 7, value: 0.5 }
		]);
		const fader = mixWrites(
			{ ...doc, tracks: [{ ...doc.tracks[0], gain: 0.25 }, doc.tracks[1]] },
			program,
			trackKey(1)
		);
		expect(fader.find((w) => w.register === 8)?.value).toBe(0.25);
		expect(fader.find((w) => w.register === 2)?.value).toBe(0.5); // A pre-fader send holds its own gain only
	});

	it('leave a pair to a lane only if the pair holds what the lane moves', () => {
		const program = {
			tracks: [
				{
					id: 1,
					index: 0,
					mix: [
						{ to: 'master', left: 0, right: 1 },
						{ to: 'bus:room', left: 2, right: 3 }
					]
				}
			],
			buses: [],
			inserts: []
		};
		const withSend = {
			...song(),
			clips: song().clips.map((c) => (c.id === 'a' ? lane(c, { mix: 'send', track: 1, to: 'room' }) : c))
		};
		expect(settlingWrites(withSend, program, []).mix.map((w) => w.register)).toEqual([0, 1]);
	});

	it('trace an exp ramp by equal ratios, and stop it at the next point', () => {
		expect(curveAt(1, 0.01, 0.5)).toBeCloseTo(0.1, 12);
		expect(curveAt(1, 0, 0.5)).toBeCloseTo(Math.sqrt(0.001), 12);
		expect(curveAt(1, 0, 1)).toBe(0);
		let clip = addPoint(clipNamed('c'), { param: 1 }, 0, 1);
		clip = addPoint(clip, { param: 1 }, 100, 0.01);
		clip = setPoint(clip, 1, { ramp: 200, curve: 'exp' });
		clip = addPoint(clip, { param: 1 }, 200, 1);
		const curve = laneCurve(lanesOf(clip)[0], 1920);
		const middle = curve.find((p) => p.tick === 200 - 0 && p.value < 1);
		expect(middle?.value).toBeCloseTo(0.1, 6); // Halfway along it when the next point cuts it off
		expect(setPoint(clip, 1, { ramp: 0 }).automation[1].curve).toBeUndefined();
	});

	it('move a fader evenly through what is heard', () => {
		expect(faderGain(1)).toBeCloseTo(2, 12);
		expect(faderGain(0)).toBe(0);
		expect(faderPosition(1)).toBeCloseTo(0.794, 3);
		expect(20 * Math.log10(faderGain(0.368))).toBeCloseTo(-20, 0);
		for (const gain of [0, 0.01, 0.5, 1, 2, 3]) expect(faderGain(faderPosition(gain))).toBeCloseTo(gain, 12);
	});

	it('read a fader in decibels and a pan from the centre, as the Mixer and the track heads show them', () => {
		expect(decibels(1)).toBe('0.0 dB');
		expect(decibels(0.8)).toBe('-1.9 dB');
		expect(decibels(2)).toBe('6.0 dB');
		expect(decibels(0)).toBe('silent');
		expect(panText(0)).toBe('C');
		expect(panText(0.004)).toBe('C');
		expect(panText(-0.2)).toBe('L20');
		expect(panText(1)).toBe('R100');
	});

	it("fade a new track's stolen voices, and bring a slur's velocity only in legato", () => {
		const { doc } = addTrack(song());
		expect(doc.tracks.at(-1)?.steal).toBe('fade');
		expect(song().tracks[0].steal).toBeUndefined();
		const legato = setPlay(song(), 1, { mode: 'legato', slur_velocity: true });
		expect(legato.tracks[0].play?.slur_velocity).toBe(true);
		expect(setPlay(legato, 1, { mode: 'mono' }).tracks[0].play).not.toHaveProperty('slur_velocity');
	});

	it('mark a send pre-fader and back without leaving the field behind', () => {
		const pre = setSend(song(), trackKey(1), 0, { pre: true });
		expect(pre.tracks[0].sends[0]).toEqual({ bus: 'room', gain: 0.5, pre: true });
		expect(setSend(pre, trackKey(1), 0, { pre: undefined }).tracks[0].sends[0]).toEqual({ bus: 'room', gain: 0.5 });
	});

	it('shape the velocities of chosen notes', () => {
		const clip = {
			...clipNamed('c'),
			notes: [0, 480, 960, 1440].map((tick, i) => ({ tick, note: 60, vel: 100 - i * 10, dur: 100 }))
		};
		const all = new Set([0, 1, 2, 3]);
		expect(rampVelocities(clip, all, 40, 100).notes.map((n) => n.vel)).toEqual([40, 60, 80, 100]);
		expect(scaleVelocities(clip, new Set([0, 3]), 0.5).notes.map((n) => n.vel)).toEqual([50, 90, 80, 35]);
		expect(scaleVelocities(clip, all, 9).notes.every((n) => n.vel === 127)).toBe(true);
		const nudged = humanize(clip, all, 30, 8, 7);
		expect(humanize(clip, all, 30, 8, 7)).toEqual(nudged); // The same seed, the same nudge
		nudged.notes.forEach((n, i) => {
			expect(Math.abs(n.tick - clip.notes[i].tick)).toBeLessThanOrEqual(30);
			expect(Math.abs(n.vel - clip.notes[i].vel)).toBeLessThanOrEqual(8);
		});
		const loose = { ...clip, notes: [{ tick: 130, note: 60, vel: 90, dur: 10 }] };
		expect(quantize(loose, new Set([0]), 120).notes[0].tick).toBe(120);
		expect(quantize(loose, new Set([0]), 120, 0.5).notes[0].tick).toBe(125);
	});
});
