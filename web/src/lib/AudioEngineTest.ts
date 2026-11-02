import { describe, expect, it } from 'vitest';
import { AudioEngine, probeTargets, tapTargets } from '#lib/AudioEngine.ts';
import type { CompileReport, ProgramReport } from '#lib/Request.ts';

const chain = (id: number | string, step: number) => ({ id, step, bus: step + 1, mix: [] });

const program = (tracks: number, buses: number): ProgramReport => ({
	name: 'p',
	index: 0,
	hash: '',
	ppq: 480,
	length_ticks: 0,
	size: 0,
	tracks: Array.from({ length: tracks }, (_, i) => chain(i + 1, i)),
	buses: Array.from({ length: buses }, (_, i) => chain(`b${i}`, 100 + i)),
	master: { step: 200, bus: 201 },
	inserts: [],
	patches: []
});

describe('what the scopes read', () => {
	it('is the master, then tracks, then buses, each named as the compiler names it', () => {
		const targets = tapTargets(program(2, 1));
		expect(targets.map((t) => t.chain)).toEqual(['master', 'track:1', 'track:2', 'bus:b0']);
		expect(targets.map((t) => t.slot)).toEqual([0, 1, 2, 3]);
	});

	it('stops at the slots there are, and tracks come before buses', () => {
		const targets = tapTargets(program(6, 4));
		expect(targets).toHaveLength(8);
		expect(targets.at(-1)?.chain).toBe('bus:b0');
		expect(tapTargets(program(9, 1)).at(-1)?.chain).toBe('track:7');
	});
});

describe('a load the worklet refuses', () => {
	it('reaches the page, where it can be explained', () => {
		const engine = new AudioEngine();
		const reasons: string[] = [];
		engine.onRejected = (reason) => reasons.push(reason);
		const inside = engine as unknown as { receive: (message: Record<string, unknown>) => void };
		inside.receive({ type: 'load-rejected', reason: 'image is larger than the image slot' });
		expect(reasons).toEqual(['image is larger than the image slot']);
	});
});

describe('a probe', () => {
	const nodes = { 3: { ports: { out: { rate: 'audio' as const, step: 2, operand: 40 } } } };
	const probe = { node: 3, port: 'out', label: 'three' };

	it('goes after the scopes, and only as far as the slots go', () => {
		expect(probeTargets(nodes, [probe], 2)).toEqual([{ slot: 2, label: 'three', step: 2, operand: 40 }]);
		expect(probeTargets(nodes, [probe], 8)).toEqual([]);
	});

	it('is left out if its node compiled away', () => {
		expect(probeTargets({}, [probe], 2)).toEqual([]);
	});

	// A wrong track here is quiet: the probe reads a register of some other voice and draws it as if it were this node.
	it('reaches the track and slot it was aimed at', () => {
		const engine = new AudioEngine();
		const sent: Record<string, number>[] = [];
		const inside = engine as unknown as { node: unknown; live: CompileReport };
		inside.node = { port: { postMessage: (message: Record<string, number>) => sent.push(message) } };
		inside.live = {
			programs: [program(3, 0)],
			sidecar: { hat: nodes }
		} as unknown as CompileReport;
		engine.setProbes('hat', [probe], { track: 2, slot: 1 });
		const probed = sent.find((message) => message.kind === 10);
		expect(probed).toMatchObject({ target: 2, channel: 1, tick: 2, tickEnd: 40 });
	});
});
