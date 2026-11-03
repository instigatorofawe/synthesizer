import { describe, expect, it } from 'vitest';
import { EMPTY_TIMELINE, type Timeline } from '#lib/Schema.ts';
import { TakeRun, type TakeHost } from '#lib/Take.svelte.ts';
import { addClip, addTrack, place } from '#lib/TimelineEdit.ts';

const PPQ = 480;
const BAR = 4 * PPQ;
const SIXTEENTH = PPQ / 4;
const KEY = 'timeline:song';

// A song with one track and a bar's clip on it, recorded into through a host that keeps what the take writes.
function recording(open = true) {
	const track = addTrack(EMPTY_TIMELINE, 'lead');
	const clip = addClip(track.doc, BAR);
	let doc: Timeline = place(clip.doc, track.id, clip.id, 0);
	const shown: string[] = [];
	const host: TakeHost = {
		doc: (key) => (open && key === KEY ? doc : null),
		loop: () => null,
		write: (next) => (doc = next),
		shown: (_, id) => shown.push(id)
	};
	const take = new TakeRun(host, track.id, KEY, { grid: SIXTEENTH, velocity: 90 });
	return { take, shown, notes: () => doc.clips[0].notes };
}

const key = (on: boolean, note: number, tick: number) => ({ on, note, tick, elapsed: tick });

describe('a take', () => {
	it('hears nothing while it arms, and is dropped if it stops then', () => {
		const { take, notes } = recording();
		take.played(key(true, 60, 0));
		take.played(key(false, 60, SIXTEENTH));
		expect(notes()).toEqual([]);
		expect(take.stop()).toBe('dropped');
	});

	it('writes a key let go, snapped, at its velocity, and shows the clip it wrote into once', () => {
		const { take, notes, shown } = recording();
		take.start();
		take.played(key(true, 60, SIXTEENTH + 20));
		take.played(key(false, 60, SIXTEENTH * 3 - 10));
		take.played(key(true, 62, SIXTEENTH * 4));
		take.played(key(false, 62, SIXTEENTH * 5));
		expect(notes()).toEqual([
			{ tick: SIXTEENTH, note: 60, vel: 90, dur: SIXTEENTH * 2 },
			{ tick: SIXTEENTH * 4, note: 62, vel: 90, dur: SIXTEENTH }
		]);
		expect(shown).toEqual(['clip']);
	});

	it('writes the keys still down as let go where recording stopped', () => {
		const { take, notes } = recording();
		take.start();
		take.played(key(true, 64, 0));
		expect(take.stop()).toBe('stopping');
		expect(take.stop()).toBe('waiting');
		take.ended({ tick: SIXTEENTH * 2, elapsed: SIXTEENTH * 2 });
		expect(notes()).toEqual([{ tick: 0, note: 64, vel: 90, dur: SIXTEENTH * 2 }]);
	});

	it('writes nothing once another timeline is open', () => {
		const { take, notes } = recording(false);
		take.start();
		take.played(key(true, 60, 0));
		take.played(key(false, 60, SIXTEENTH));
		expect(notes()).toEqual([]);
	});
});
