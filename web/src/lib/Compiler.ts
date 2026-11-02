import type { CompileReport } from '#lib/Request.ts';

export interface Compiled {
	report: CompileReport;
	image: Uint8Array;
}

// Talks to the worker. A compile error arrives as data in the report. A result that a newer compile on the same channel has
// superseded resolves to null, so an old edit can never load after a newer one started. Channels are for things compiled
// side by side, such as a song and a patch heard on its own, which mustn't cancel each other.
export class Compiler {
	private worker = new Worker(new URL('./CompilerWorker.ts', import.meta.url), { type: 'module' });
	private next = 0;
	private newest = new Map<string, number>();
	private waiting = new Map<number, { channel: string; resolve: (result: Compiled | null) => void }>();

	constructor() {
		this.worker.onmessage = (e: MessageEvent<{ id: number; report: string; image: Uint8Array }>) => {
			const waiter = this.waiting.get(e.data.id);
			if (!waiter) return;
			this.waiting.delete(e.data.id);
			const current = this.newest.get(waiter.channel) === e.data.id;
			waiter.resolve(current ? { report: JSON.parse(e.data.report), image: e.data.image } : null);
		};
	}

	compile(request: string, channel = ''): Promise<Compiled | null> {
		const id = this.next++;
		this.newest.set(channel, id);
		return new Promise((resolve) => {
			this.waiting.set(id, { channel, resolve });
			this.worker.postMessage({ id, request });
		});
	}

	close() {
		this.worker.terminate();
	}
}
