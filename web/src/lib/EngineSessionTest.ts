import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineState } from '#lib/AudioEngine.ts';
import type { Compiled } from '#lib/Compiler.ts';
import {
	COMPILE_WAIT_MS,
	EngineSession,
	type Compiles,
	type Engine,
	type SessionHost
} from '#lib/EngineSession.svelte.ts';
import type { CompileReport } from '#lib/Request.ts';

// An engine that keeps what it was asked, and plays what it loaded only when the test says it went live.
class FakeEngine {
	calls: string[] = [];
	loaded: CompileReport[] = [];
	onState: Engine['onState'] = () => {};
	onTap: Engine['onTap'] = () => {};
	onTargets: Engine['onTargets'] = () => {};
	onRejected: Engine['onRejected'] = () => {};
	onLive: Engine['onLive'] = () => {};
	start = async () => void this.calls.push('start');
	load = (_: Uint8Array, report: CompileReport) => void this.loaded.push(report);
	play = () => void this.calls.push('play');
	stop = () => void this.calls.push('stop');
	locate = (tick: number) => void this.calls.push(`locate ${tick}`);
	setLoop = (start: number, end: number) => void this.calls.push(`loop ${start} ${end}`);
	noteOn = (track: number, note: number) => void this.calls.push(`on ${track} ${note}`);
	noteOff = (track: number, note: number) => void this.calls.push(`off ${track} ${note}`);
	setMix = (register: number, value: number) => void this.calls.push(`mix ${register} ${value}`);
	setParam = () => {};
	setInsertParam = () => {};
	close = async () => {};

	// The image last loaded goes live, as the worklet says once it has swapped it in.
	goLive() {
		this.onLive(this.loaded[this.loaded.length - 1]);
	}

	state(tick: number, playing: boolean) {
		this.onState({ tick, playing, generation: 1 } as EngineState);
	}
}

const report = (ok: boolean, length = 1920): CompileReport =>
	({ ok, programs: [{ length_ticks: length, tracks: [] }] }) as unknown as CompileReport;

// A compiler that answers each request with a report made of it: a request with "bad" in it doesn't compile. Held, it keeps
// its answers until the test lets them go, so a test can order a compile against what happens meanwhile.
class FakeCompiler implements Compiles {
	asked: string[] = [];
	hold = false;
	#held: (() => void)[] = [];
	compile = async (request: string): Promise<Compiled | null> => {
		this.asked.push(request);
		if (this.hold) await new Promise<void>((answer) => this.#held.push(answer));
		return { report: report(!request.includes('bad')), image: new Uint8Array() };
	};
	answer() {
		const held = this.#held;
		this.#held = [];
		for (const answer of held) answer();
	}
	close = () => {};
}

function session(want: 'song' | 'alone' = 'song') {
	const made = { song: 'song 1', alone: 'patch 1' as string | null, key: 'timeline:a', refused: 0 };
	const host: SessionHost = {
		songRequest: () => ({ request: made.song }),
		aloneRequest: () => made.alone,
		assetsArriving: () => false,
		openKey: () => made.key,
		patches: () => [],
		songRefused: () => void made.refused++
	};
	const engine = new FakeEngine();
	const compiler = new FakeCompiler();
	const it = new EngineSession(host, want, engine as unknown as Engine, () => compiler);
	return { it, engine, compiler, made };
}

// Lets the compile's promise and the start's resolve.
const settled = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('compiling', () => {
	it('compiles once a run of edits stops, and not again for the same request', async () => {
		const { it: s, compiler } = session();
		s.schedule('song');
		s.schedule('song');
		expect(s.compiling.song).toBe(true);
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		expect(compiler.asked).toEqual(['song 1']);
		expect(s.compiles).toBe(1);
		expect(s.compiling.song).toBe(false);
		expect(s.goodSong?.report.ok).toBe(true);
		s.schedule('song');
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		expect(compiler.asked).toEqual(['song 1']);
	});

	it('keeps the last good song when an edit fails, and says so', async () => {
		const { it: s, made } = session();
		s.schedule('song');
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		const good = s.goodSong;
		made.song = 'bad song';
		s.schedule('song');
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		expect(s.song?.report.ok).toBe(false);
		expect(s.goodSong).toBe(good);
		expect(made.refused).toBe(1);
	});

	it('drops a song that compiled for the song open before', async () => {
		const { it: s, made } = session();
		const compiling = s.compile('song');
		made.key = 'timeline:b';
		await compiling;
		expect(s.song).toBeNull();
	});

	it('keeps the light on while a compile is on its way, though a compile with nothing new to send finishes first', async () => {
		const { it: s, compiler, made } = session();
		compiler.hold = true;
		made.song = 'song 2';
		s.schedule('song');
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS); // Sent, and its answer held
		expect(compiler.asked).toEqual(['song 2']);
		s.schedule('song'); // As Save does: the request is the one already sent
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		expect(compiler.asked).toEqual(['song 2']);
		expect(s.compiling.song).toBe(true);
		compiler.answer();
		await settled();
		expect(s.compiling.song).toBe(false);
		expect(s.song?.report.ok).toBe(true);
	});

	it('loads only once audio has started, and then what is wanted', async () => {
		const { it: s, engine } = session();
		s.schedule('song');
		s.schedule('alone');
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		expect(engine.loaded).toEqual([]);
		await s.start();
		expect(engine.loaded).toEqual([s.goodSong?.report]);
		expect(s.busy).toBe(true); // Until it is live
		engine.goLive();
		expect(s.live).toBe('song');
		expect(s.busy).toBe(false);
	});
});

describe('what plays', () => {
	// Audio started with the song live and stopped at tick 480.
	async function songLive(want: 'song' | 'alone' = 'song') {
		const made = session(want);
		made.it.schedule('song');
		made.it.schedule('alone');
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		made.it.use('song');
		await settled();
		made.engine.goLive();
		made.engine.state(480, false);
		made.engine.calls = [];
		return made;
	}

	it("sends a note once the song is live, and doesn't start audio twice", async () => {
		const { it: s, engine } = session();
		s.schedule('song');
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		s.controls.noteOn(0, 60, 100);
		s.controls.noteOff(0, 60);
		await settled();
		expect(engine.calls).toEqual(['start']);
		engine.goLive();
		expect(engine.calls).toEqual(['start', 'on 0 60', 'off 0 60']);
	});

	it('leaves the song stopped where it was after a patch on its own ran the transport', async () => {
		const { it: s, engine } = await songLive();
		s.use('alone');
		engine.goLive();
		engine.state(2000, true); // The patch on its own runs the transport for its LFOs
		s.use('song');
		expect(engine.calls).toContain('stop');
		engine.goLive();
		expect(engine.calls.at(-1)).toBe('locate 480');
	});

	it('keeps the song playing when it was playing as a patch took over', async () => {
		const { it: s, engine } = await songLive();
		engine.state(960, true);
		s.use('alone');
		engine.goLive();
		s.use('song');
		expect(engine.calls).not.toContain('stop');
		engine.goLive();
		expect(engine.calls.at(-1)).toBe('locate 960');
	});

	it('plays from the start once the song has played to its end', async () => {
		const { it: s, engine } = await songLive();
		engine.state(1920, false);
		s.play();
		expect(engine.calls).toEqual(['locate 0', 'play']);
	});

	it('stops, and once stopped goes back to the start', async () => {
		const { it: s, engine } = await songLive();
		engine.state(960, true);
		s.stopOrStart();
		engine.state(960, false);
		s.stopOrStart();
		expect(engine.calls).toEqual(['stop', 'locate 0']);
		expect(s.songTick).toBe(0);
	});

	it('moves the playhead while a patch plays on its own, for the song to start from', async () => {
		const { it: s, engine } = await songLive();
		s.use('alone');
		engine.goLive();
		engine.calls = [];
		s.moveTo(1440);
		expect(s.tick).toBe(1440);
		expect(engine.calls).toEqual([]);
		engine.goLive(); // The song's image, which the move asked for
		expect(engine.calls.at(-1)).toBe('locate 1440');
	});

	it('takes the song back once nothing plays on its own, and starts nothing for it', async () => {
		const quiet = session('alone');
		quiet.it.wantSong();
		expect(quiet.it.want).toBe('song');
		expect(quiet.engine.calls).toEqual([]); // No click or key yet, so no audio

		const { it: s, engine } = await songLive();
		s.use('alone', () => engine.noteOn(0, 60)); // Waits for an image that never comes
		s.wantSong(() => engine.noteOn(1, 60));
		engine.goLive();
		expect(engine.calls).toContain('on 1 60');
		expect(engine.calls).not.toContain('on 0 60');
		expect(s.want).toBe('song');
	});

	it('waits with Play for an edit on its way, so the newest image plays from the start', async () => {
		const { it: s, engine, made } = await songLive();
		made.song = 'song 2';
		s.schedule('song');
		s.play();
		expect(engine.calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		expect(engine.calls).toEqual([]); // Compiled and on its way to the engine
		engine.goLive();
		expect(engine.calls).toEqual(['play']);
	});

	it('lets Play go to the image playing once the edit is refused', async () => {
		const { it: s, engine, made } = await songLive();
		made.song = 'bad song';
		s.schedule('song');
		s.play();
		expect(engine.calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		expect(engine.calls).toEqual(['play']);
	});

	it('sends keys at once while an edit compiles', async () => {
		const { it: s, engine } = await songLive();
		s.schedule('song');
		s.controls.noteOn(0, 60, 100);
		expect(engine.calls).toEqual(['on 0 60']);
	});

	it("doesn't let the last song's image take Play once another song opens", async () => {
		const { it: s, engine, made } = await songLive();
		made.key = 'timeline:b';
		made.song = 'song b';
		s.songChanged();
		expect(s.live).toBeNull();
		engine.calls = [];
		s.play();
		expect(engine.calls).toEqual([]);
		s.schedule('song');
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		engine.goLive();
		expect(s.live).toBe('song');
		expect(engine.calls).toEqual(['play']);
	});

	it("doesn't count an image of the last song, arriving late, as the song open", async () => {
		const { it: s, engine, made, compiler } = await songLive();
		made.song = 'song a, edited';
		s.schedule('song');
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS); // Song a's edit, on its way to the engine
		made.key = 'timeline:b';
		s.songChanged();
		engine.goLive(); // Song a's image arrives after song b opened
		expect(s.live).toBeNull();
		expect(compiler.asked.at(-1)).toBe('song a, edited');
	});

	it('says whether what is heard is the newest edit', async () => {
		const { it: s, engine, made } = session();
		s.schedule('song');
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		expect(s.heard).toBe('none'); // No audio yet
		s.use('song');
		await settled();
		expect(s.heard).toBe('none'); // On its way
		engine.goLive();
		expect(s.heard).toBe('newest');
		made.song = 'song 2';
		s.schedule('song');
		expect(s.heard).toBe('older'); // An edit compiling
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		expect(s.heard).toBe('older'); // Its image on its way
		engine.goLive();
		expect(s.heard).toBe('newest');
		made.song = 'bad song';
		s.schedule('song');
		await vi.advanceTimersByTimeAsync(COMPILE_WAIT_MS);
		expect([s.busy, s.heard]).toEqual([false, 'older']); // Refused, so the image before it plays
		made.key = 'timeline:b';
		s.songChanged();
		expect(s.heard).toBe('none');
	});

	it('forgets the last song when another opens', async () => {
		const { it: s, engine } = await songLive();
		s.setLoop({ start: 0, end: 960 }, true);
		s.solo = new Set([1]);
		s.songChanged();
		expect([s.loop, s.looping, s.solo.size, s.goodSong, s.songTick]).toEqual([null, false, 0, null, 0]);
		expect(engine.calls).toEqual(['stop', 'locate 0', 'loop 0 0']);
	});
});

describe('the loop and solo', () => {
	it('sends no loop until one has been sent, then takes it away', () => {
		const { it: s, engine } = session();
		s.sendLoop(null);
		expect(engine.calls).toEqual([]);
		s.sendLoop({ start: 0, end: 960 });
		s.sendLoop(null);
		s.sendLoop(null);
		expect(engine.calls).toEqual(['loop 0 960', 'loop 0 0']);
	});

	it('keeps solo only for tracks that are still there', () => {
		const { it: s } = session();
		s.toggleSolo(1, null);
		s.toggleSolo(2, null);
		s.toggleSolo(1, null);
		expect([...s.solo]).toEqual([2]);
		s.keepSolo(new Set([1, 3]));
		expect(s.solo.size).toBe(0);
	});
});
