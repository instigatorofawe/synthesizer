import { describe, expect, it } from 'vitest';
import { columns, findTrigger, Ring } from '#lib/ScopeMath.ts';

function sine(length: number, period: number, phase = 0) {
	return Float32Array.from({ length }, (_, i) => Math.sin((2 * Math.PI * (i + phase)) / period));
}

describe('Ring', () => {
	it('addresses samples by absolute index across the wrap', () => {
		const ring = new Ring(100);
		ring.push(
			Float32Array.from({ length: 80 }, (_, i) => i),
			0
		);
		ring.push(
			Float32Array.from({ length: 80 }, (_, i) => 80 + i),
			80
		);
		expect(ring.newest).toBe(160);
		expect(ring.at(159)).toBe(159);
		expect(ring.at(60)).toBe(60);
	});

	it('reads a dropped block as silence', () => {
		const ring = new Ring(100);
		ring.push(new Float32Array(10).fill(1), 0);
		ring.push(new Float32Array(10).fill(1), 30);
		expect(ring.at(9)).toBe(1);
		expect(ring.at(20)).toBe(0);
		expect(ring.at(30)).toBe(1);
	});
});

describe('findTrigger', () => {
	it('holds a periodic waveform still as new samples arrive', () => {
		const period = 100;
		const starts: number[] = [];
		for (const offset of [0, 37, 71]) {
			const ring = new Ring(48000);
			ring.push(sine(8000 + offset, period), 0);
			const start = findTrigger(ring, 200, 0);
			expect(start).not.toBeNull();
			starts.push(start! % period);
		}
		expect(new Set(starts).size).toBe(1);
	});

	it('leaves a full span after the trigger', () => {
		const ring = new Ring(48000);
		ring.push(sine(8000, 100), 0);
		expect(findTrigger(ring, 500, 0)! + 500).toBeLessThanOrEqual(ring.newest);
	});

	it('free-runs on silence', () => {
		const ring = new Ring(48000);
		ring.push(new Float32Array(8000), 0);
		expect(findTrigger(ring, 200, 0)).toBeNull();
	});
});

describe('columns', () => {
	it('keeps a one-sample peak on a wide timebase', () => {
		const ring = new Ring(48000);
		const samples = new Float32Array(48000);
		samples[12345] = 0.9;
		ring.push(samples, 0);
		const peak = Math.max(...columns(ring, 0, 48000, 400).map((c) => c.max));
		expect(peak).toBeCloseTo(0.9);
	});
});
