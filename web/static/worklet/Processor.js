// The audio thread. It owns one wasm instance, and everything else reaches it over the MessagePort.
//
// There is no SharedArrayBuffer here, so no cross-origin isolation is needed. Image bytes and tap blocks are transferred.
import createModsynth from '../wasm/Modsynth.js';

const FRAME = 128; // One ms_render(), which is Web Audio's render quantum and not the engine's frame size
const TAP_SLOTS = 8;
const POOL_SIZE = 32;
const COPY_PER_QUANTUM = 64 * 1024; // A large image must not take a whole render quantum to copy in
const STATE_EVERY = 8;

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
		this.quanta = 0;
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
				this.events.push(message);
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
		}
		if (i > 0) this.events.splice(0, i);
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
			this.port.postMessage(
				{
					type: 'tap',
					slot,
					buffer,
					start: m._ms_tap_start(),
					dropped: this.tapDropped[slot],
					generation: m._ms_generation()
				},
				[buffer]
			);
			this.tapDropped[slot] = 0;
		}
	}

	process(_inputs, outputs) {
		const output = outputs[0];
		const m = this.engine;
		if (!m) return true;
		this.advanceLoad();
		this.flushEvents();
		m._ms_render();
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
		this.collectTaps();
		if (++this.quanta % STATE_EVERY === 0) {
			this.port.postMessage({
				type: 'state',
				tick: m._ms_tick(),
				playing: m._ms_playing() !== 0,
				voices: m._ms_voices(),
				generation,
				liveId: this.liveId,
				error: m._ms_error(),
				loading: m._ms_loading() !== 0,
				guardTrips: m._ms_guard_trips()
			});
		}
		return true;
	}
}

registerProcessor('modsynth', ModsynthProcessor);
