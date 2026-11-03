import { describe, expect, it } from 'vitest';
import { FOLLOW_MARGIN, followScroll } from '#lib/Follow.ts';

describe('following the playhead', () => {
	it('leaves a view alone while the playhead is in it', () => {
		expect(followScroll(0, null, 0, 800)).toBeNull();
		expect(followScroll(500, 480, 0, 800)).toBeNull();
		expect(followScroll(800, 790, 0, 800)).toBeNull();
	});

	it('turns the page when the playhead runs off the right edge', () => {
		expect(followScroll(805, 795, 0, 800)).toBe(805 - FOLLOW_MARGIN);
		expect(followScroll(1580, 1570, 805 - FOLLOW_MARGIN, 800)).toBe(1580 - FOLLOW_MARGIN); // The next page
	});

	it('comes back when a loop or a locate sends the playhead off the left edge', () => {
		expect(followScroll(100, 1500, 1000, 800)).toBe(100 - FOLLOW_MARGIN);
		expect(followScroll(10, 1500, 1000, 800)).toBe(0);
	});

	it('finds the playhead when the song starts out of sight', () => {
		expect(followScroll(3000, null, 0, 800)).toBe(3000 - FOLLOW_MARGIN);
	});

	it('leaves a view someone has scrolled away from', () => {
		expect(followScroll(410, 400, 2000, 800)).toBeNull();
	});

	it('keeps the playhead well inside a narrow view', () => {
		expect(followScroll(105, 95, 0, 100)).toBe(80);
		expect(followScroll(105, 95, 0, 0)).toBeNull();
	});
});
