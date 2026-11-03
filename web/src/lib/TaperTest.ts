import { describe, expect, it } from 'vitest';
import { isLog, STEPS, stepOf, stepValue, taper, travelOf, valueAt } from '#lib/Taper.ts';

describe('which ranges are logarithmic', () => {
	it('are those above zero whose ends are a ratio of 100 or more apart', () => {
		expect(isLog(80, 12000)).toBe(true);
		expect(isLog(20, 20000)).toBe(true);
		expect(isLog(1, 100)).toBe(true);
		expect(isLog(0.001, 0.1)).toBe(true);
	});

	it('are not those that reach zero or below, or span less', () => {
		expect(isLog(0, 1)).toBe(false);
		expect(isLog(0, 12000)).toBe(false);
		expect(isLog(-1, 1000)).toBe(false);
		expect(isLog(1, 99.9)).toBe(false);
		expect(isLog(0.1, 4)).toBe(false);
		expect(isLog(5, 5)).toBe(false);
	});
});

describe('a cutoff from 80 Hz to 12 kHz', () => {
	const cutoff = taper(80, 12000);

	it('puts 900 Hz near the middle, not at 7% of the way', () => {
		expect(travelOf(cutoff, 900)).toBeCloseTo(0.483, 3);
		expect(travelOf(taper(0, 12000), 900)).toBeCloseTo(0.075, 3); // As a linear slider would
	});

	it('has its geometric middle at the middle', () => {
		expect(valueAt(cutoff, 0.5)).toBeCloseTo(Math.sqrt(80 * 12000), 6);
		expect(stepValue(cutoff, STEPS / 2)).toBe(980);
	});

	it('moves an equal ratio for equal travel', () => {
		const ratio = (from: number) => valueAt(cutoff, from + 0.1) / valueAt(cutoff, from);
		expect(ratio(0)).toBeCloseTo(ratio(0.8), 9);
	});
});

describe('the ends', () => {
	for (const [min, max] of [
		[80, 12000],
		[0, 1],
		[-1, 1],
		[0.0001, 60]
	]) {
		it(`of ${min} to ${max} are the range's own`, () => {
			const shape = taper(min, max);
			expect(valueAt(shape, 0)).toBe(min);
			expect(valueAt(shape, 1)).toBe(max);
			expect(stepValue(shape, 0)).toBe(min);
			expect(stepValue(shape, STEPS)).toBe(max);
			expect(travelOf(shape, min)).toBe(0);
			expect(travelOf(shape, max)).toBe(1);
		});
	}

	it('hold a value outside the range, and a range with no width', () => {
		const shape = taper(80, 12000);
		expect(travelOf(shape, 10)).toBe(0);
		expect(travelOf(shape, 50000)).toBe(1);
		expect(valueAt(shape, -0.5)).toBe(80);
		expect(valueAt(shape, 2)).toBe(12000);
		expect(stepOf(shape, Number.NaN)).toBe(0);
		expect(travelOf(taper(3, 3), 3)).toBe(0);
		expect(valueAt(taper(3, 3), 0.5)).toBe(3);
	});
});

describe('round trips', () => {
	for (const [min, max] of [
		[80, 12000],
		[20, 20000],
		[0, 1],
		[-1, 1],
		[0.1, 4],
		[0, 1000],
		[0.0001, 60],
		[1000, 1001]
	]) {
		it(`from every step of ${min} to ${max}, and back to it`, () => {
			const shape = taper(min, max);
			for (let step = 0; step <= STEPS; step++) {
				const value = stepValue(shape, step);
				expect(value).toBeGreaterThanOrEqual(min);
				expect(value).toBeLessThanOrEqual(max);
				expect(stepOf(shape, value), `${value} at step ${step}`).toBe(step);
			}
		});
	}

	it('from a value to its travel and back', () => {
		for (const shape of [taper(80, 12000), taper(0, 1), taper(-12, 12)]) {
			for (const value of [shape.min, (shape.min + shape.max) / 3, shape.max]) {
				expect(valueAt(shape, travelOf(shape, value))).toBeCloseTo(value, 9);
			}
		}
	});

	it('rounds what a step gives to what can be read, not float noise', () => {
		expect(stepValue(taper(0, 1), 150)).toBe(0.3);
		expect(stepValue(taper(-1, 1), 251)).toBe(0.004);
		expect(String(stepValue(taper(20, 20000), 250))).toBe('632');
		expect(String(stepValue(taper(80, 12000), 499))).toBe('11880');
	});
});
