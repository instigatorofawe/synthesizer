import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Bars, pulseTicks } from '#lib/TimeSignature.ts';

const BLOCK = 4;
type Processor = {
	engine: unknown;
	pool: ArrayBuffer[];
	tapBlock: number;
	port: { postMessage: (message: { dropped: number }) => void };
	collectTaps: () => void;
};

// Run from its source, because a worklet's globals exist only on the audio thread, and the wasm it imports is a build
// product that a unit test has no need of.
function loadProcessor() {
	let type: (new () => Processor) | undefined;
	const source = readFileSync(new URL('../../static/worklet/Processor.js', import.meta.url), 'utf8');
	const body = source.replace(/^import .*$/m, 'const createModsynth = () => new Promise(() => {});');
	const base = class {
		port = { postMessage: () => {} };
	};
	new Function('AudioWorkletProcessor', 'registerProcessor', body)(base, (_: string, t: new () => Processor) => {
		type = t;
	});
	return type!;
}
const ModsynthProcessor = loadProcessor();

// One block waiting on slot 0 each time it is asked, as the engine reports it: taking one clears the engine's count.
function processor(enginesCount: () => number) {
	const heap = new Float32Array(BLOCK);
	const sent: number[] = [];
	const p = new ModsynthProcessor();
	p.engine = {
		HEAPF32: heap,
		_ms_tap_take: (slot: number) => (slot === 0 ? 4 : 0),
		_ms_tap_dropped: enginesCount,
		_ms_tap_start: () => 0,
		_ms_generation: () => 1
	};
	p.tapBlock = BLOCK;
	p.port.postMessage = (message) => sent.push(message.dropped);
	return { p, sent };
}

describe('collectTaps', () => {
	it('counts a block it had no buffer for, and reports it with the next one out', () => {
		const { p, sent } = processor(() => 0);
		p.collectTaps();
		p.collectTaps();
		expect(sent).toEqual([]);
		p.pool.push(new ArrayBuffer(BLOCK * 4));
		p.collectTaps();
		expect(sent).toEqual([2]);
	});

	it('keeps what the engine counted across a block it could not send', () => {
		const { p, sent } = processor(() => 3);
		p.collectTaps();
		p.pool.push(new ArrayBuffer(BLOCK * 4));
		p.collectTaps();
		expect(sent).toEqual([3 + 1 + 3]);
	});

	it('reports each loss once', () => {
		const { p, sent } = processor(() => 0);
		p.collectTaps();
		p.pool.push(new ArrayBuffer(BLOCK * 4), new ArrayBuffer(BLOCK * 4));
		p.collectTaps();
		p.collectTaps();
		expect(sent).toEqual([1, 0]);
	});
});

// ------------------------------------------------------------------------------------------------------------- recording

const RATE = 48000;
const QUANTUM = 128;
const PPQ = 480;

type Message = { type: string } & Record<string, number | boolean | string>;
type Recorder = {
	engine: unknown;
	left: Float32Array;
	right: Float32Array;
	port: { postMessage: (message: Message) => void };
	receive: (message: Record<string, unknown>) => void;
	process: (inputs: unknown, outputs: Float32Array[][]) => boolean;
	clickHz: number;
};

// An engine that moves `ticks` a quantum while it plays, round a loop if it has one, and renders silence.
function engineMoving(ticks: number, { loopEnd = 0, length = 0 } = {}) {
	const e = { tick: 0, playing: 0, sent: [] as number[] };
	return Object.assign(e, {
		HEAPF32: new Float32Array(QUANTUM),
		_ms_send: (kind: number) => {
			e.sent.push(kind);
			if (kind === 6) e.playing = 1;
			if (kind === 7) e.playing = 0;
			return 1;
		},
		_ms_render: () => {
			if (!e.playing) return;
			e.tick += ticks;
			if (loopEnd && e.tick >= loopEnd) e.tick -= loopEnd;
		},
		_ms_tick: () => e.tick,
		_ms_playing: () => e.playing,
		_ms_looping: () => (loopEnd ? 1 : 0),
		_ms_length: () => length,
		_ms_loading: () => 0,
		_ms_generation: () => 0,
		_ms_tap_take: () => 0,
		_ms_voices: () => 0,
		_ms_error: () => 0,
		_ms_guard_trips: () => 0,
		_ms_limited: () => 1
	});
}

// A processor on that engine, and what it has sent the page. `run` renders quanta with the audio clock moving as it would.
function recorder(engine: ReturnType<typeof engineMoving>) {
	const g = globalThis as unknown as { sampleRate: number; currentTime: number };
	g.sampleRate = RATE;
	g.currentTime = 0;
	const p = new ModsynthProcessor() as unknown as Recorder;
	const sent: Message[] = [];
	p.engine = engine;
	p.left = new Float32Array(QUANTUM);
	p.right = new Float32Array(QUANTUM);
	p.port.postMessage = (message) => sent.push({ ...message });
	const output = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
	let loudest = 0;
	const run = (quanta: number) => {
		for (let i = 0; i < quanta; ++i) {
			p.process([], [output]);
			loudest = Math.max(loudest, ...output[0].map(Math.abs));
			g.currentTime += QUANTUM / RATE;
		}
	};
	const states = () => sent.filter((m) => m.type === 'state');
	return { p, sent, run, states, loudest: () => loudest, now: () => g.currentTime };
}

describe('a take', () => {
	it('counts a bar in with a click on each beat, then starts the song on the next', () => {
		const engine = engineMoving(2.56);
		const { p, run, states, loudest } = recorder(engine);
		p.receive({ type: 'record', ppq: PPQ, beatsPerBar: 4, beats: 4, bpm: 120 }); // A bar at 120 is 2 s, 750 quanta
		run(8);
		expect(states().at(-1)).toMatchObject({ recording: 1, countIn: 4, clicks: 1, playing: false });
		expect(loudest()).toBeGreaterThan(0.1);
		run(742);
		expect(states().at(-1)).toMatchObject({ recording: 1, clicks: 4 });
		expect(engine.sent).not.toContain(6);
		run(8);
		expect(engine.sent).toContain(6);
		expect(states().at(-1)).toMatchObject({ recording: 2, countIn: 0, clicks: 5 });
	});

	// What AudioEngine.record sends for a song in this meter, from tick 0.
	const take = (bars: Bars) => {
		const bar = bars.at(0);
		const ticks = bar.beat * bar.meter.beats;
		const pulses = ticks / pulseTicks(PPQ, bar.meter);
		return { type: 'record', ppq: PPQ, meter: bars.segments(), ticks, pulses, beats: pulses, bpm: 120 };
	};

	it('counts in a bar of the song’s meter, accenting its first beat, and clicks 6/8 in two', () => {
		const engine = engineMoving(2.56);
		const { p, run, states } = recorder(engine);
		p.receive(take(Bars.of(PPQ, [{ tick: 0, beats: 3, unit: 4 }]))); // A bar of 3/4 at 120 is 1.5 s, 563 quanta
		run(8);
		expect(states().at(-1)).toMatchObject({ recording: 1, countIn: 3, clicks: 1 });
		expect(p.clickHz).toBe(1760);
		run(200);
		expect(states().at(-1)).toMatchObject({ clicks: 2 });
		expect(p.clickHz).toBe(1320);
		run(355);
		expect(engine.sent).not.toContain(6);
		run(8);
		expect(engine.sent).toContain(6);
		expect(states().at(-1)).toMatchObject({ recording: 2, clicks: 4 });
		expect(p.clickHz).toBe(1760);

		const compound = recorder(engineMoving(2.56));
		compound.p.receive(take(Bars.of(PPQ, [{ tick: 0, beats: 6, unit: 8 }])));
		compound.run(560);
		expect(compound.states().at(-1)).toMatchObject({ recording: 1, clicks: 2 });
	});

	it('accents the bars a pickup leaves, so a count-in leads into it', () => {
		// 3/8 after an eighth's pickup: the song starts on the third eighth of bar 0, and the count-in is the bar of 3/8 before
		// that, from the last eighth of bar -1.
		const engine = engineMoving(2.56);
		const { p, run, states } = recorder(engine);
		p.receive(take(Bars.of(PPQ, [{ tick: 0, beats: 3, unit: 8 }], 240)));
		run(8);
		expect(states().at(-1)).toMatchObject({ recording: 1, countIn: 3, clicks: 1 });
		expect(p.clickHz).toBe(1320); // The last eighth of the bar before the pickup's
		run(100);
		expect(p.clickHz).toBe(1760); // Bar 0's first beat
	});

	it('clicks on the beats of a song already playing, from where it is, and stops clicking when the take ends', () => {
		const engine = engineMoving(10);
		engine.playing = 1;
		engine.tick = 5;
		const { p, run, states } = recorder(engine);
		p.receive({ type: 'record', ppq: PPQ, beatsPerBar: 4, beats: 4, bpm: 120 });
		run(48); // To tick 485: one beat, at 480
		expect(states().at(-1)).toMatchObject({ recording: 2, clicks: 1 });
		p.receive({ type: 'record-stop' });
		run(96);
		expect(states().at(-1)).toMatchObject({ recording: 0, clicks: 1 });
	});

	it('puts a key where the song was when it was heard, however late it arrives', () => {
		const engine = engineMoving(10);
		engine.playing = 1;
		const { p, sent, run, now } = recorder(engine);
		p.receive({ type: 'record', ppq: PPQ, beatsPerBar: 4, beats: 0, bpm: 0 });
		run(40); // Quantum 20 runs from tick 200 to 210
		const heard = (20.5 * QUANTUM) / RATE;
		expect(now()).toBeGreaterThan(heard);
		p.receive({ type: 'event', kind: 0, note: 64, velocity: 100, target: 0, heard });
		run(1);
		const played = sent.find((m) => m.type === 'played')!;
		expect(played).toMatchObject({ on: true, note: 64 });
		expect(played.tick).toBeCloseTo(205); // The audio clock is a sum of quanta, a little off whole ticks
		expect(played.elapsed).toBeCloseTo(205);
	});

	it("keeps counting how far the song went round a loop, so a held note's length survives the wrap", () => {
		const engine = engineMoving(10, { loopEnd: 400 });
		engine.playing = 1;
		const { p, sent, run } = recorder(engine);
		p.receive({ type: 'record', ppq: PPQ, beatsPerBar: 4, beats: 0, bpm: 0 });
		run(50); // Round once: tick 100 again, 500 ticks along
		const at = (quantum: number) => (quantum * QUANTUM) / RATE;
		p.receive({ type: 'event', kind: 0, note: 60, target: 0, heard: at(35) });
		p.receive({ type: 'event', kind: 1, note: 60, target: 0, heard: at(45) });
		run(1);
		const [on, off] = sent.filter((m) => m.type === 'played');
		expect(on).toMatchObject({ on: true });
		expect(off).toMatchObject({ on: false });
		expect(on.tick).toBeCloseTo(350);
		expect(off.tick).toBeCloseTo(50);
		expect((off.elapsed as number) - (on.elapsed as number)).toBeCloseTo(100);
	});

	it('plays on past the end of the song, and stops there again once the take is over', () => {
		const engine = engineMoving(10, { length: 100 });
		engine.playing = 1;
		const { p, sent, run } = recorder(engine);
		p.receive({ type: 'record', ppq: PPQ, beatsPerBar: 4, beats: 0, bpm: 0 });
		run(20);
		expect(engine.sent).not.toContain(7);
		p.receive({ type: 'record-stop' });
		run(1);
		expect(sent.find((m) => m.type === 'take-end')).toMatchObject({ tick: 200 });
		run(1);
		expect(engine.sent).toContain(7);
	});
});
