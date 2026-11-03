import { describe, expect, it } from 'vitest';
import { NODE_HELP } from '#lib/NodeHelp.ts';
import { SCRUB_PX, scrubbed, valueText } from '#lib/NodeValues.ts';

describe('a value on a node', () => {
	it('scrubs along a range, logarithmically where it spans two decades, and stops at its ends', () => {
		const range = { min: 20, max: 20000 };
		expect(scrubbed(20, SCRUB_PX / 2, range, false)).toBeCloseTo(632.5, 0); // Halfway, the geometric middle
		expect(scrubbed(1000, SCRUB_PX * 3, range, false)).toBe(20000);
		expect(scrubbed(1000, -SCRUB_PX * 3, range, false)).toBe(20);
		expect(scrubbed(0, SCRUB_PX / 4, { min: 0, max: 1 }, false)).toBe(0.25);
	});

	it('moves a tenth as far with Shift', () => {
		expect(scrubbed(0, SCRUB_PX, { min: 0, max: 1 }, true)).toBe(0.1);
	});

	it('moves by its own size where the input has no range', () => {
		expect(scrubbed(2, SCRUB_PX, undefined, false)).toBe(4);
		expect(scrubbed(0, SCRUB_PX / 2, undefined, false)).toBe(0.5);
		expect(scrubbed(1, SCRUB_PX / 2, { min: 0, max: 'its max' }, false)).toBe(1.5);
	});

	it('reads as four figures, with a short unit', () => {
		expect(valueText(1234.567, 'Hz')).toBe('1235 Hz');
		expect(valueText(0.005, 's')).toBe('0.005 s');
		expect(valueText(60, NODE_HELP.mtof?.inputs.note?.unit)).toBe('60');
	});
});
