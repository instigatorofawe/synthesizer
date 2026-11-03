// node --expose-gc --min-semi-space-size=1024 --max-semi-space-size=1024 tools/MeasureWorklet.mjs REQUEST...
//
// Runs web/static/worklet/Processor.js on build/wasm/Modsynth.js under Node, which has the V8 and the wasm a browser's
// audio thread has, and measures what the design leaves to Milestone 7:
// - what starting the engine costs, with its fixed heap;
// - the dearest render quantum while each image loads, against the quanta around it and Web Audio's 2.67 ms;
// - what the oscilloscope makes the audio thread allocate, with every tap slot on and with none. The young generation
//   is made big enough that nothing is collected during a run, so what the heap grows by is what was allocated.
// Prints JSON. Requests compile with build/wasm/ModsynthCompiler.js, as the page's worker does. Each plays from its
// start, and a quantum is timed from the outside, as process() runs.

import { readFileSync } from 'node:fs';
import v8 from 'node:v8';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const RATE = 48000;
const QUANTUM_MS = (128 / RATE) * 1000;

const created = performance.now();
const rssBefore = process.memoryUsage().rss;
const { default: createModsynth } = await import(`${root}build/wasm/Modsynth.js`);
const module = await createModsynth();
const startMs = performance.now() - created;
const rssAfter = process.memoryUsage().rss;

// The worklet as Web Audio would run it: its globals given, its port a plain object, and its engine the one above.
function processor() {
	const source = readFileSync(`${root}web/static/worklet/Processor.js`, 'utf8');
	const body = source.replace(/^import .*$/m, 'const createModsynth = () => Promise.resolve(globalModule);');
	let type;
	const sent = { length: 0 }; // a count, so the port allocates nothing itself
	const base = class {
		port = {
			postMessage: () => {
				++sent.length;
			}
		};
	};
	globalThis.globalModule = module;
	new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', body)(base, (_, t) => (type = t), RATE);
	const p = new type();
	return { p, sent };
}

const { p, sent } = processor();
await new Promise((resolve) => setTimeout(resolve, 0)); // start() runs once createModsynth resolves
const outputs = [[new Float32Array(128), new Float32Array(128)]];

function quantum() {
	const from = performance.now();
	p.process([], outputs);
	return performance.now() - from;
}

const { default: createCompiler } = await import(`${root}build/wasm/ModsynthCompiler.js`);
const compiler = await createCompiler();
const compiled = new Map();
function compile(path) {
	if (!compiled.has(path)) {
		const result = compiler.compile(readFileSync(path, 'utf8'));
		const report = typeof result.report === 'string' ? JSON.parse(result.report) : result.report;
		if (!report.ok) throw new Error(`${path}: ${JSON.stringify(report.errors)}`);
		compiled.set(path, { image: new Uint8Array(result.image), master: report.programs[0].master });
	}
	return compiled.get(path);
}

// A load, timed quantum by quantum until it goes live, then 2 s of play for comparison.
function load(path, warm) {
	const bytes = compile(path).image;
	const image = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
	const generation = module._ms_generation();
	p.receive({ type: 'load', image, program: 0, id: 1 });
	const loading = [];
	while (module._ms_generation() === generation && loading.length < 48000) loading.push(quantum());
	p.receive({ type: 'event', kind: 6 }); // Play
	const playing = [];
	for (let i = 0; i < (2 * RATE) / 128; ++i) playing.push(quantum());
	if (!warm) return null;
	const sorted = [...playing].sort((a, b) => a - b);
	return {
		request: path.split('/').pop(),
		image_bytes: bytes.length,
		quanta: loading.length,
		worst_loading_ms: Math.max(...loading),
		median_playing_ms: sorted[sorted.length >> 1],
		worst_playing_ms: sorted[sorted.length - 1]
	};
}

// Bytes the audio thread allocates in each quantum while one image plays, with `slots` tap slots on the master bus.
function allocation(path, slots) {
	load(path, false);
	const { master } = compile(path);
	for (let s = 0; s < 8; ++s) {
		// SetTap: slot, the master's mix step and register, channel. A slot past `slots` is turned off.
		const target = s < slots ? master.step : 0xffff;
		p.receive({ type: 'event', kind: 5, param: s, target, note: master.bus, channel: s % 2 });
	}
	for (let i = 0; i < 2000; ++i) quantum(); // past warming up, and tap buffers coming back
	const quanta = 20000;
	let returned = 0;
	sent.length = 0;
	const buffers = Array.from({ length: 100000 }, () => new ArrayBuffer(p.tapBlock * 4)); // the page's, made now
	globalThis.gc();
	const young = () => v8.getHeapSpaceStatistics().find((s) => s.space_name === 'new_space').space_used_size;
	const before = young();
	for (let i = 0; i < quanta; ++i) {
		p.process([], outputs); // untimed, as reading the clock allocates
		// The page sends each block's buffer back, as Scope.svelte does
		while (p.pool.length < 8 && returned < 100000) {
			p.receive({ type: 'tap-return', buffer: buffers[returned] });
			++returned;
		}
	}
	const grown = young() - before;
	return { slots, bytes_per_quantum: grown / quanta, messages_per_second: (sent.length / quanta) * (RATE / 128) };
}

const images = process.argv.slice(2);
load(images[0], false); // V8 compiles as it goes, so the first run warms up and isn't counted
const loads = images.map((path) => load(path, true));
const scope = [allocation(images[0], 0), allocation(images[0], 8)];
console.log(
	JSON.stringify(
		{
			node: process.version,
			quantum_ms: QUANTUM_MS,
			start_ms: startMs,
			start_rss_mb: (rssAfter - rssBefore) / 2 ** 20,
			heap_mb: module.HEAPU8.length / 2 ** 20,
			loads,
			scope
		},
		null,
		1
	)
);
