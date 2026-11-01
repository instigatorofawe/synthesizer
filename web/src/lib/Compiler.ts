import type { CompileReport } from '#lib/Request.ts';

export interface Compiled {
	report: CompileReport;
	image: Uint8Array;
}

// Talks to the worker. Every call resolves, and a compile error arrives as data in the report.
export class Compiler {
	private worker = new Worker(new URL('./CompilerWorker.ts', import.meta.url), { type: 'module' });
	private next = 0;
	private waiting = new Map<number, (result: Compiled) => void>();

	constructor() {
		this.worker.onmessage = (e: MessageEvent<{ id: number; report: string; image: Uint8Array }>) => {
			const resolve = this.waiting.get(e.data.id);
			this.waiting.delete(e.data.id);
			resolve?.({ report: JSON.parse(e.data.report), image: e.data.image });
		};
	}

	compile(request: string): Promise<Compiled> {
		const id = this.next++;
		return new Promise((resolve) => {
			this.waiting.set(id, resolve);
			this.worker.postMessage({ id, request });
		});
	}

	close() {
		this.worker.terminate();
	}
}
