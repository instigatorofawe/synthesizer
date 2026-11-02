// node tools/RenderWasm.mjs Modsynth.js image out.f32 quanta
// Renders through the same wasm engine and exports the worklet uses, so its audio can be compared with native.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [engine, imagePath, outPath, quanta] = process.argv.slice(2);
const { default: createModsynth } = await import(pathToFileURL(resolve(engine)).href);
const m = await createModsynth();
m._ms_init(48000);

const image = readFileSync(imagePath);
m.HEAPU8.set(image, m._ms_image_buffer());
if (!m._ms_load(image.length, 0)) throw new Error('engine refused the load');
const left = m._ms_out(0) >> 2;
const right = m._ms_out(1) >> 2;
const FRAME = 128; // One ms_render(), whatever frame size the image declares
const STEREO = 2;
while (m._ms_loading()) m._ms_render();
if (m._ms_error() !== 0) throw new Error(`load failed: ${m._ms_error()}`);

m._ms_send(6, 0, 0, 0, 0, 0, 0, 0, 0); // Play
const out = new Float32Array(Number(quanta) * FRAME * STEREO);
for (let f = 0; f < Number(quanta); ++f) {
	m._ms_render();
	out.set(m.HEAPF32.subarray(left, left + FRAME), f * FRAME * STEREO);
	out.set(m.HEAPF32.subarray(right, right + FRAME), f * FRAME * STEREO + FRAME);
}
writeFileSync(outPath, Buffer.from(out.buffer));
