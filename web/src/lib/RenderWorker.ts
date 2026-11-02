// Renders a song off the main thread, for a file. It runs the same wasm engine the worklet does, so what it writes is what
// plays: to the Program's end, then on until every voice has stopped and a tenth of a second has stayed below -100 dB, for at
// most `tail` seconds more, as the Python binding's render does.
interface Engine {
	HEAPU8: Uint8Array;
	HEAPF32: Float32Array;
	_ms_init(rate: number): void;
	_ms_image_capacity(): number;
	_ms_image_buffer(): number;
	_ms_load(size: number, program: number): number;
	_ms_loading(): number;
	_ms_error(): number;
	_ms_out(channel: number): number;
	_ms_render(): void;
	_ms_send(...args: number[]): number;
	_ms_tick(): number;
	_ms_voices(): number;
}

export interface RenderRequest {
	image: ArrayBuffer;
	program: number;
	rate: number;
	length: number; // The Program's length in ticks
	tail: number; // Seconds
}

export type RenderMessage =
	| { type: 'progress'; fraction: number }
	| { type: 'done'; left: Float32Array; right: Float32Array }
	| { type: 'error'; message: string };

const QUANTUM = 128; // One ms_render()
const SILENCE = 1e-5;
const PLAY = 6;

self.onmessage = async (e: MessageEvent<RenderRequest>) => {
	const post = (message: RenderMessage, transfer: Transferable[] = []) => self.postMessage(message, { transfer });
	try {
		const { image, program, rate, length, tail } = e.data;
		const url = new URL('/wasm/Modsynth.js', self.location.origin).href;
		const { default: create } = (await import(/* @vite-ignore */ url)) as { default: () => Promise<Engine> };
		const m = await create();
		m._ms_init(rate);
		if (image.byteLength > m._ms_image_capacity()) throw new Error('the image is too large for the engine');
		m.HEAPU8.set(new Uint8Array(image), m._ms_image_buffer());
		if (!m._ms_load(image.byteLength, program)) throw new Error('the engine refused the image');
		while (m._ms_loading()) m._ms_render();
		if (m._ms_error() !== 0) throw new Error(`the engine refused the image (${m._ms_error()})`);
		m._ms_send(PLAY, 0, 0, 0, 0, 0, 0, 0, 0);

		const left = m._ms_out(0) >> 2;
		const right = m._ms_out(1) >> 2;
		const parts: Float32Array[][] = [];
		const step = Math.max(1, Math.round(rate / 10 / QUANTUM)); // Quanta in about a tenth of a second
		const chunk = () => {
			const l = new Float32Array(step * QUANTUM);
			const r = new Float32Array(step * QUANTUM);
			let peak = 0;
			for (let q = 0; q < step; ++q) {
				m._ms_render();
				l.set(m.HEAPF32.subarray(left, left + QUANTUM), q * QUANTUM);
				r.set(m.HEAPF32.subarray(right, right + QUANTUM), q * QUANTUM);
			}
			for (let i = 0; i < l.length; ++i) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
			parts.push([l, r]);
			return peak;
		};
		let last = 0;
		while (m._ms_tick() < length) {
			chunk();
			const fraction = m._ms_tick() / length;
			if (fraction - last > 0.02) post({ type: 'progress', fraction: (last = fraction) });
		}
		for (let n = 0; n < Math.ceil(tail * 10); ++n) {
			if (chunk() < SILENCE && m._ms_voices() === 0) break;
		}
		const frames = parts.length * step * QUANTUM;
		const out = [new Float32Array(frames), new Float32Array(frames)];
		parts.forEach(([l, r], i) => {
			out[0].set(l, i * step * QUANTUM);
			out[1].set(r, i * step * QUANTUM);
		});
		post({ type: 'done', left: out[0], right: out[1] }, [out[0].buffer, out[1].buffer]);
	} catch (error) {
		post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
	}
};
