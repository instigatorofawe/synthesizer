// One take, from Record until the worklet says recording has stopped. The page starts it, tells it when the image that plays
// its track is playing and when the worklet stamps a key or stops, and does what only the page can: the engine and the editor.
// This holds what is held and writes what is let go, snapped, into the timeline, so the take's own rules are tested here
// rather than only end to end. The snapping and where a note goes are Recording.ts's.
import type { PlayedKey } from '#lib/AudioEngine.ts';
import { newTake, recordNote, snapPlayed, type Stamp, type Take } from '#lib/Recording.ts';
import type { Timeline } from '#lib/Schema.ts';

// What a take asks of the page.
export interface TakeHost {
	doc(key: string): Timeline | null; // The timeline the take records into, as it is now, or null once another is open
	loop(): { start: number; end: number } | null; // The loop the take goes round, while one is on
	write(doc: Timeline): void; // An edit of the take's run of edits, which undoes as one
	shown(track: number, clip: string): void; // The take now writes into this clip, which the roll should show
}

// Arming until an image that plays the track is playing, then started, then ending until the worklet says where it stopped.
export type TakePhase = 'arming' | 'started' | 'ending';

export class TakeRun {
	phase = $state<TakePhase>('arming');
	readonly track: number;
	readonly key: string; // The timeline's draft key, which its history goes by
	readonly #grid: number;
	readonly #velocity: number;
	readonly #host: TakeHost;
	readonly #held = new Map<number, Stamp>(); // Keys down, and when
	#write: Take;
	#shown: string | null = null; // The clip the take last wrote into

	constructor(host: TakeHost, track: number, key: string, settings: { grid: number; velocity: number }) {
		this.#host = host;
		this.track = track;
		this.key = key;
		this.#grid = settings.grid;
		this.#velocity = settings.velocity;
		this.#write = newTake(track);
	}

	start() {
		this.phase = 'started';
	}

	// Record again, Stop or Space. An arming take has heard nothing, so it is dropped at once. A started one waits for the worklet
	// to say where it stopped, which `ended` hears.
	stop(): 'dropped' | 'stopping' | 'waiting' {
		if (this.phase === 'arming') return 'dropped';
		if (this.phase === 'ending') return 'waiting';
		this.phase = 'ending';
		return 'stopping';
	}

	// A key the worklet stamped. One that comes up is written, and one that goes down waits for it to come up.
	played(key: PlayedKey) {
		if (this.phase === 'arming') return;
		if (key.on) {
			this.#held.set(key.note, { tick: key.tick, elapsed: key.elapsed });
			return;
		}
		const on = this.#held.get(key.note);
		if (!on) return;
		this.#held.delete(key.note);
		this.#written(key.note, on, key);
	}

	// Recording stopped at `at`. The keys still down are written as let go there.
	ended(at: Stamp) {
		for (const [note, on] of this.#held) this.#written(note, on, at);
		this.#held.clear();
	}

	#written(note: number, on: Stamp, off: Stamp) {
		const doc = this.#host.doc(this.key);
		if (!doc) return;
		const snapped = snapPlayed({ note, vel: this.#velocity, on, off }, this.#grid, this.#host.loop());
		if (!snapped) return;
		const done = recordNote(doc, this.#write, snapped);
		if (!done) return;
		this.#write = done.take;
		this.#host.write(done.doc);
		if (done.clip !== this.#shown) {
			this.#shown = done.clip;
			this.#host.shown(this.track, done.clip);
		}
	}
}
