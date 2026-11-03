import { describe, expect, it } from 'vitest';
import { LEAST_ARRANGEMENT, LEAST_NOTES, keepSplit, keptSplit, splitAt } from '#lib/Split.ts';

describe('the split between the arrangement and the notes', () => {
	it('follows the drag, and leaves each side its least', () => {
		expect(splitAt(200, 50, 600)).toBe(250);
		expect(splitAt(200, -500, 600)).toBe(LEAST_ARRANGEMENT);
		expect(splitAt(200, 900, 600)).toBe(600 - LEAST_NOTES);
		expect(splitAt(100, 10, 150)).toBe(LEAST_ARRANGEMENT); // No room to give: the arrangement keeps its least
	});

	it('is kept for each song, and a song at its own height has no entry', () => {
		let text = keepSplit(null, 'timeline:a', 300.4);
		text = keepSplit(text, 'recipe:Ballad', 180);
		expect(keptSplit(text, 'timeline:a')).toBe(300);
		expect(keptSplit(text, 'recipe:Ballad')).toBe(180);
		text = keepSplit(text, 'timeline:a', null);
		expect(keptSplit(text, 'timeline:a')).toBeNull();
		expect(JSON.parse(text)).toEqual({ 'recipe:Ballad': 180 });
	});

	it('forgets the oldest past what it keeps, and what it can’t read', () => {
		let text = keepSplit(null, 'a', 100, 2);
		text = keepSplit(text, 'b', 110, 2);
		text = keepSplit(text, 'c', 120, 2);
		expect(Object.keys(JSON.parse(text))).toEqual(['b', 'c']);
		expect(keptSplit('not json', 'a')).toBeNull();
		expect(keptSplit('{"a": "tall", "b": 5}', 'a')).toBeNull();
		expect(keptSplit('{"a": "tall", "b": 5}', 'b')).toBeNull();
	});
});
