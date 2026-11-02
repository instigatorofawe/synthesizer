import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
