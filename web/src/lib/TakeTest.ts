import { describe, expect, it } from 'vitest';
import { EMPTY_TIMELINE, type Timeline } from '#lib/Schema.ts';
import { TakeRun, type TakeHost } from '#lib/Take.svelte.ts';
import { addClip, addTrack, place, removeTrack } from '#lib/TimelineEdit.ts';

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
	const said: string[] = [];
	const host: TakeHost = {
		doc: (key) => (open && key === KEY ? doc : null),
		loop: () => null,
		write: (next) => (doc = next),
		shown: (_, id) => shown.push(id),
		say: (text) => said.push(text)
	};
	const take = new TakeRun(host, track.id, KEY, { grid: SIXTEENTH, velocity: 90 });
	return {
		take,
		shown,
		said,
		notes: () => doc.clips[0].notes,
		edit: (next: (doc: Timeline) => Timeline) => (doc = next(doc))
	};
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

	it('writes a key let go, its start snapped and its length as played, at its velocity, and shows the clip it wrote into once', () => {
		const { take, notes, shown } = recording();
		take.start();
		take.played(key(true, 60, SIXTEENTH + 20));
		take.played(key(false, 60, SIXTEENTH * 3 - 10));
		take.played(key(true, 62, SIXTEENTH * 4));
		take.played(key(false, 62, SIXTEENTH * 5));
		expect(notes()).toEqual([
			{ tick: SIXTEENTH, note: 60, vel: 90, dur: SIXTEENTH * 2 - 30 },
			{ tick: SIXTEENTH * 4, note: 62, vel: 90, dur: SIXTEENTH }
		]);
		expect(shown).toEqual(['clip']);
	});

	it('says so when a note has nowhere to go, rather than leaving it out without a word', () => {
		const { take, said, edit } = recording();
		take.start();
		take.played(key(true, 60, 0));
		edit((doc) => removeTrack(doc, take.track)); // The track goes while its key is down
		take.played(key(false, 60, SIXTEENTH));
		expect(said).toEqual(["The note played at bar 1 had nowhere to go, so it wasn't written."]);
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
