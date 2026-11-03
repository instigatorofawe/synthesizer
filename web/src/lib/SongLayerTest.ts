import { describe, expect, it } from 'vitest';
import { FOLDED, SONG_LANES, UNFOLDED, keepOpen, keptOpen, laneHeight, layerHeight } from '#lib/SongLayer.ts';

describe('the song layer', () => {
	it('has a Tempo lane, folded to a thin row until it is unfolded', () => {
		expect(SONG_LANES.map((lane) => lane.name)).toEqual(['Tempo']);
		expect(laneHeight(false)).toBe(FOLDED);
		expect(laneHeight(true)).toBe(UNFOLDED);
		expect(FOLDED).toBeLessThan(24);
		expect(UNFOLDED).toBeGreaterThanOrEqual(64);
		expect(UNFOLDED).toBeLessThanOrEqual(80);
	});

	it('is as tall as its lanes', () => {
		expect(layerHeight(new Set())).toBe(FOLDED);
		expect(layerHeight(new Set(['tempo']))).toBe(UNFOLDED);
		const two = [
			{ id: 'tempo', name: 'Tempo' },
			{ id: 'markers', name: 'Markers' }
		];
		expect(layerHeight(new Set(['markers']), two)).toBe(FOLDED + UNFOLDED);
	});
});

describe('which lanes are unfolded', () => {
	it('is kept for each timeline', () => {
		let text = keepOpen(null, 'timeline:a', new Set(['tempo']));
		text = keepOpen(text, 'timeline:b', new Set());
		expect(keptOpen(text, 'timeline:a')).toEqual(new Set(['tempo']));
		expect(keptOpen(text, 'timeline:b')).toEqual(new Set());
		expect(keptOpen(text, 'recipe:Kick808')).toEqual(new Set());
		// Folded, as a lane starts, a timeline needs no entry
		expect(JSON.parse(text)).toEqual({ 'timeline:a': ['tempo'] });
		expect(JSON.parse(keepOpen(text, 'timeline:a', new Set()))).toEqual({});
	});

	it('keeps only the newest timelines', () => {
		let text: string | null = null;
		for (const name of ['a', 'b', 'c', 'd']) text = keepOpen(text, name, new Set(['tempo']), 3);
		expect(Object.keys(JSON.parse(text!))).toEqual(['b', 'c', 'd']);
		text = keepOpen(text, 'b', new Set(['tempo']), 3); // Opening one again makes it the newest
		expect(Object.keys(JSON.parse(text))).toEqual(['c', 'd', 'b']);
	});

	it('shrugs off an entry it can’t read', () => {
		expect(keptOpen('not json', 'a')).toEqual(new Set());
		expect(keptOpen('[1, 2]', 'a')).toEqual(new Set());
		expect(keptOpen('{"a": "tempo", "b": ["tempo", 3]}', 'a')).toEqual(new Set());
		expect(keptOpen('{"a": "tempo", "b": ["tempo", 3]}', 'b')).toEqual(new Set(['tempo']));
		expect(JSON.parse(keepOpen('nonsense', 'a', new Set(['tempo'])))).toEqual({ a: ['tempo'] });
	});
});
