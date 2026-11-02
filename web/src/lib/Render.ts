import type { RenderMessage, RenderRequest } from '#lib/RenderWorker.ts';
import { encodeWav } from '#lib/Wav.ts';

// Renders a Program of an image to a WAV file, on a worker of its own so neither the page nor the audio thread waits for it.
export function renderWav(
	image: Uint8Array,
	length: number,
	onprogress: (fraction: number) => void,
	{ program = 0, rate = 48000, tail = 10 } = {}
): Promise<Uint8Array<ArrayBuffer>> {
	const worker = new Worker(new URL('./RenderWorker.ts', import.meta.url), { type: 'module' });
	return new Promise((resolve, reject) => {
		worker.onmessage = (e: MessageEvent<RenderMessage>) => {
			const message = e.data;
			if (message.type === 'progress') return onprogress(message.fraction);
			worker.terminate();
			if (message.type === 'error') reject(new Error(message.message));
			else resolve(encodeWav([message.left, message.right], rate));
		};
		worker.onerror = (e) => {
			worker.terminate();
			reject(new Error(e.message));
		};
		const bytes = image.slice().buffer;
		const request: RenderRequest = { image: bytes, program, rate, length, tail };
		worker.postMessage(request, [bytes]);
	});
}
