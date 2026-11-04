// The audio thread. It owns one wasm instance, and everything else reaches it over the MessagePort.
//
// There is no SharedArrayBuffer here, so no cross-origin isolation is needed. Image bytes and tap blocks are transferred.
import createModsynth from '../wasm/Modsynth.js';

const FRAME = 128; // One ms_render(), which is Web Audio's render quantum and not the engine's frame size
const TAP_SLOTS = 8;
const POOL_SIZE = 32;
const COPY_PER_QUANTUM = 64 * 1024; // A large image must not take a whole render quantum to copy in
const STATE_EVERY = 8;
const NOTE_ON = 0; // EventKind in Synth.hpp
const PLAY = 6;
const STOP = 7;
// Where the song was for each of the last quanta, about 1.4 s at 48 kHz, so a key can be put where the song was when it was
// heard, however long the output's latency and the key's way here took. Each is five numbers: when the quantum started, on
// the audio clock, the tick there and at its end, and how far the song had gone at each.
const HISTORY = 512;
const CLICK_SECONDS = 0.03;
const CLICK_GAIN = 0.25; // About -12 dBFS, under what most songs play at, and not limited, since it is never in the song

class ModsynthProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.engine = null;
		this.events = [];
		this.request = null; // The newest load that has not started. Older ones are superseded.
		this.copy = null;
		this.pool = [];
		this.loadingId = 0; // Which load the engine is working on, and which one is live, so the main thread can match reports
		this.liveId = 0;
		this.awaiting = null; // The load the engine is working on, until the page has been told whether it went live
		this.generation = 0;
		this.tapStart = new Array(TAP_SLOTS).fill(null);
		this.tapDropped = new Array(TAP_SLOTS).fill(0); // Blocks lost since this slot last sent one
		// postMessage copies a message as it sends it, so the audio thread sends the same objects every time and makes
		// no garbage for them. What it can't keep is a view for each block, since every buffer comes back a new one.
		this.tapMessages = Array.from({ length: TAP_SLOTS }, (_, slot) => ({
			type: 'tap',
			slot,
			buffer: null,
			start: 0,
			dropped: 0,
			generation: 0
		}));
		this.transfer = [null];
		this.stateMessage = {
			type: 'state',
			tick: 0,
			playing: false,
			voices: 0,
			generation: 0,
			liveId: 0,
			error: 0,
			loading: false,
			guardTrips: 0,
			limited: 1,
			time: 0,
			recording: 0,
			countIn: 0,
			clicks: 0
		};
		this.quanta = 0;
		// Recording: 0 for none, 1 while a bar is counted in, 2 while a take runs. The count-in plays the click and then starts
		// the song, so the engine plays as it always does, and the click is mixed in here, after the taps, so no meter shows it.
		this.recording = 0;
		this.countIn = null; // { start, left, frames, ticks, beats }: the tick the song starts from, and the frames to go
		this.ppq = 0;
		// The song's meters, as Meter.ts's `segments` sends them: from where each starts, in ticks, a whole bar's length, a
		// click's, and a tick its bars start on. 4/4 from tick 0 until a take says otherwise.
		this.meter = [];
		this.history = new Float64Array(HISTORY * 5);
		this.kept = 0; // Quanta written into the history
		this.elapsed = 0; // Ticks the song has gone, counting through a loop's wrap, which a note's length is taken from
		this.lastDelta = 0;
		this.clicks = 0; // Clicks begun since the worklet started, so a test can see them
		this.clickAt = null; // Frames into the click sounding, negative before it starts, or null for none
		this.clickHz = 0;
		this.stamp = { tick: 0, elapsed: 0 };
		this.playedMessage = { type: 'played', on: false, note: 0, tick: 0, elapsed: 0 };
		this.port.onmessage = (e) => this.receive(e.data);
		// registerProcessor() cannot wait for this, so process() outputs silence until it resolves.
		createModsynth().then((module) => this.start(module));
	}

	start(module) {
		module._ms_init(sampleRate);
		this.engine = module;
		const heap = module.HEAPF32;
		const left = module._ms_out(0) >> 2;
		const right = module._ms_out(1) >> 2;
		// Memory growth is off, so these views stay valid and the audio thread never allocates new ones.
		this.left = heap.subarray(left, left + FRAME);
		this.right = heap.subarray(right, right + FRAME);
		this.tapBlock = module._ms_tap_block_samples();
		for (let i = 0; i < POOL_SIZE; ++i) this.pool.push(new ArrayBuffer(this.tapBlock * 4));
		this.port.postMessage({ type: 'ready', sampleRate, capacity: module._ms_image_capacity() });
	}

	receive(message) {
		switch (message.type) {
			case 'load':
				this.request = message;
				break;
			case 'event':
			case 'record':
			case 'record-stop':
				this.events.push(message); // In order with the notes, so a take ends after the last one sent before it
				break;
			case 'tap-return':
				if (message.buffer.byteLength === this.tapBlock * 4) this.pool.push(message.buffer);
				break;
		}
	}

	flushEvents() {
		const m = this.engine;
		let i = 0;
		for (; i < this.events.length; ++i) {
			const e = this.events[i];
			if (e.type === 'record') {
				this.beginTake(e);
				continue;
			}
			if (e.type === 'record-stop') {
				this.endTake(e.heard);
				continue;
			}
			if (
				!m._ms_send(
					e.kind,
					e.note ?? 0,
					e.velocity ?? 0,
					e.channel ?? 0,
					e.target ?? 0,
					e.param ?? 0,
					e.value ?? 0,
					e.tick ?? 0,
					e.tickEnd ?? 0
				)
			) {
				break; // Queue full: try the rest next quantum
			}
			if (e.heard !== undefined) this.sendPlayed(e);
		}
		if (i > 0) this.events.splice(0, i);
	}

	// A take begins, with a bar counted in first if the song isn't playing. The song starts from `start`, which a locate sent
	// just before can't have reached the engine yet, since the engine takes events as it renders.
	// The bar counted in is `ticks` long, the bar of the song's meter where it starts, with `pulses` clicks in it.
	beginTake(e) {
		this.ppq = e.ppq;
		this.meter = e.meter ?? [{ from: -1e15, bar: e.ppq * (e.beatsPerBar ?? 4), pulse: e.ppq, anchor: 0 }];
		if (e.bpm > 0 && !this.engine._ms_playing()) {
			const perBeat = (sampleRate * 60) / e.bpm; // A quarter's frames, since a tempo is in quarters
			const ticks = e.ticks ?? e.beats * e.ppq;
			const frames = Math.max(FRAME, Math.round(((ticks / e.ppq) * perBeat) / FRAME) * FRAME);
			const start = e.start ?? this.engine._ms_tick();
			this.countIn = { start, left: frames, frames, ticks, beats: e.pulses ?? e.beats };
			this.recording = 1;
		} else {
			this.countIn = null;
			this.recording = 2;
		}
	}

	// A take ends, and says where the song was when it was heard to, for the notes still held then.
	endTake(heard) {
		const stamp = this.stampAt(heard ?? currentTime);
		this.recording = 0;
		this.countIn = null;
		this.port.postMessage({ type: 'take-end', tick: stamp.tick, elapsed: stamp.elapsed });
	}

	// Where the song is: the engine's tick, or while a bar is counted in, where it would be, from a bar before the start.
	position() {
		const c = this.countIn;
		return c ? c.start - (c.left / c.frames) * c.ticks : this.engine._ms_tick();
	}

	// Where the song was at a time on the audio clock, from the history, between the ticks either side of it.
	stampAt(heard) {
		const h = this.history;
		const stamp = this.stamp;
		const count = Math.min(this.kept, HISTORY);
		for (let back = 1; back <= count; ++back) {
			const i = ((this.kept - back) % HISTORY) * 5;
			if (h[i] > heard && back < count) continue;
			const along = Math.min(1, Math.max(0, ((heard - h[i]) * sampleRate) / FRAME));
			const [from, to] = [h[i + 1], h[i + 2]];
			stamp.tick = to >= from ? from + along * (to - from) : along < 0.5 ? from : to;
			stamp.elapsed = h[i + 3] + along * (h[i + 4] - h[i + 3]);
			return stamp;
		}
		stamp.tick = this.position();
		stamp.elapsed = this.elapsed;
		return stamp;
	}

	// A note the page asked to have stamped, as it does while a take runs: where the song was when its key was heard.
	sendPlayed(e) {
		const stamp = this.stampAt(e.heard);
		const message = this.playedMessage;
		message.on = e.kind === NOTE_ON;
		message.note = e.note ?? 0;
		message.tick = stamp.tick;
		message.elapsed = stamp.elapsed;
		this.port.postMessage(message);
	}

	// The click on each beat that starts in this quantum, between where the song was and where it is now, accented on a bar's
	// first. A beat is the meter's, or three of them in a compound meter, as 6/8 is clicked in two. Round a loop the quantum is
	// taken to have gone as far as the one before, back from where it ended.
	clickBeat(from, to, delta) {
		if (!this.recording || this.ppq <= 0 || !this.meter.length) return;
		const low = to >= from ? from : to - delta;
		const span = to - low;
		if (span <= 0) return;
		const segments = this.meter;
		let at = segments.length - 1;
		while (at > 0 && low < segments[at].from) --at;
		let segment = segments[at];
		let beat = segment.anchor + Math.ceil((low - segment.anchor) / segment.pulse) * segment.pulse;
		const next = segments[at + 1];
		if (next && beat >= next.from) [beat, segment] = [next.from, next];
		if (beat >= to) return;
		const into = (((beat - segment.anchor) % segment.bar) + segment.bar) % segment.bar;
		this.clickAt = -Math.min(FRAME - 1, Math.floor(((beat - low) / span) * FRAME));
		this.clickHz = into === 0 ? 1760 : 1320;
		++this.clicks;
	}

	mixClick(left, right) {
		if (this.clickAt === null) return;
		const length = Math.round(CLICK_SECONDS * sampleRate);
		const step = (2 * Math.PI * this.clickHz) / sampleRate;
		for (let i = 0; i < FRAME; ++i) {
			const n = this.clickAt + i;
			if (n < 0) continue;
			if (n >= length) {
				this.clickAt = null;
				return;
			}
			const value = CLICK_GAIN * Math.exp((-5 * n) / length) * Math.sin(step * n);
			left[i] += value;
			if (right) right[i] += value;
		}
		this.clickAt += FRAME;
	}

	// A song stops where it ends, as a DAW's does, and its tails ring on, since stopping lets go of every note. A loop goes on
	// round instead, and Play at the end starts again from the top. The engine plays on past the end, as a device does, so
	// this belongs to the player.
	stopAtEnd() {
		const m = this.engine;
		if (this.recording || !m._ms_playing() || m._ms_looping()) return; // A take goes on past the end, and the clip grows
		const length = m._ms_length();
		if (length > 0 && m._ms_tick() >= length) m._ms_send(STOP, 0, 0, 0, 0, 0, 0, 0, 0);
	}

	advanceLoad() {
		const m = this.engine;
		if (!this.copy && this.request && !m._ms_loading()) {
			const { image, program, id } = this.request;
			this.request = null;
			const bytes = new Uint8Array(image);
			if (bytes.length > m._ms_image_capacity()) {
				this.port.postMessage({ type: 'load-rejected', reason: 'image is larger than the image slot' });
			} else {
				this.copy = { bytes, offset: 0, program, id, target: m._ms_image_buffer() };
			}
		}
		if (this.copy) {
			const { bytes, offset, target, program, id } = this.copy;
			const end = Math.min(offset + COPY_PER_QUANTUM, bytes.length);
			m.HEAPU8.set(bytes.subarray(offset, end), target + offset);
			this.copy.offset = end;
			if (end === bytes.length) {
				m._ms_load(bytes.length, program);
				this.loadingId = id;
				this.awaiting = id;
				this.copy = null;
			}
		}
	}

	collectTaps() {
		const m = this.engine;
		for (let slot = 0; slot < TAP_SLOTS; ++slot) {
			const pointer = m._ms_tap_take(slot);
			if (pointer === 0) continue;
			this.tapDropped[slot] += m._ms_tap_dropped(); // Taking a block cleared the engine's count, so it lives here until one goes out
			const buffer = this.pool.pop();
			if (!buffer) {
				++this.tapDropped[slot]; // The display can never hold up audio
				continue;
			}
			const offset = pointer >> 2;
			this.tapStart[slot] ??= m.HEAPF32.subarray(offset, offset + this.tapBlock);
			new Float32Array(buffer).set(this.tapStart[slot]);
			const message = this.tapMessages[slot];
			message.buffer = buffer;
			message.start = m._ms_tap_start();
			message.dropped = this.tapDropped[slot];
			message.generation = m._ms_generation();
			this.transfer[0] = buffer;
			this.port.postMessage(message, this.transfer);
			message.buffer = this.transfer[0] = null;
			this.tapDropped[slot] = 0;
		}
	}

	process(_inputs, outputs) {
		const output = outputs[0];
		const m = this.engine;
		if (!m) return true;
		this.advanceLoad();
		this.flushEvents();
		const time = currentTime;
		if (this.countIn && this.countIn.left <= 0) {
			this.countIn = null;
			this.recording = 2;
			m._ms_send(PLAY, 0, 0, 0, 0, 0, 0, 0, 0);
		}
		const from = this.position();
		const went = this.elapsed;
		m._ms_render();
		if (this.countIn) this.countIn.left -= FRAME;
		const to = this.position();
		const moving = this.countIn !== null || m._ms_playing() !== 0;
		const delta = to >= from ? to - from : this.lastDelta;
		if (moving) {
			this.elapsed += delta;
			if (to > from) this.lastDelta = to - from;
		}
		this.stopAtEnd();
		const generation = m._ms_generation();
		if (generation !== this.generation) {
			this.generation = generation;
			this.liveId = this.loadingId;
		}
		// The engine stops loading and swaps generations in one step, so a load that has stopped without going live failed.
		if (this.awaiting !== null && !m._ms_loading()) {
			if (this.liveId !== this.awaiting) this.port.postMessage({ type: 'load-rejected', error: m._ms_error() });
			this.awaiting = null;
		}
		output[0].set(this.left);
		if (output[1]) output[1].set(this.right);
		if (moving) this.clickBeat(from, to, delta);
		this.mixClick(output[0], output[1]);
		const at = (this.kept++ % HISTORY) * 5;
		this.history[at] = time;
		this.history[at + 1] = from;
		this.history[at + 2] = to;
		this.history[at + 3] = went;
		this.history[at + 4] = this.elapsed;
		this.collectTaps();
		if (++this.quanta % STATE_EVERY === 0) {
			const state = this.stateMessage;
			state.tick = m._ms_tick();
			state.playing = m._ms_playing() !== 0;
			state.voices = m._ms_voices();
			state.generation = generation;
			state.liveId = this.liveId;
			state.error = m._ms_error();
			state.loading = m._ms_loading() !== 0;
			state.guardTrips = m._ms_guard_trips();
			state.limited = m._ms_limited();
			state.time = currentTime; // The audio clock, which moves only as audio is rendered
			state.recording = this.recording;
			state.countIn = this.countIn ? Math.ceil((this.countIn.left / this.countIn.frames) * this.countIn.beats) : 0;
			state.clicks = this.clicks;
			this.port.postMessage(state);
		}
		return true;
	}
}

registerProcessor('modsynth', ModsynthProcessor);
