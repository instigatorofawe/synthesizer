// The compiler on its own thread and its own wasm instance, so the worklet's heap never sees it.
import createCompiler from '#lib/wasm/ModsynthCompiler.js';

const compiler = createCompiler();

self.onmessage = async (e: MessageEvent<{ id: number; request: string }>) => {
	const module = await compiler;
	const { report, image } = module.compile(e.data.request);
	self.postMessage({ id: e.data.id, report, image }, { transfer: [image.buffer] });
};
