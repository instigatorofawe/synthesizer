import { describe, expect, it } from 'vitest';
import { HIGHEST_BASE, baseAfter, belongsElsewhere, keyFor, noteForKey } from '#lib/KeyboardKeys.ts';

describe('the computer keyboard', () => {
	it('plays the home row as white keys and the row above as black ones, from the base', () => {
		const row = [
			'KeyA',
			'KeyW',
			'KeyS',
			'KeyE',
			'KeyD',
			'KeyF',
			'KeyT',
			'KeyG',
			'KeyY',
			'KeyH',
			'KeyU',
			'KeyJ',
			'KeyK'
		];
		expect(row.map((code) => noteForKey(code, 48))).toEqual([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
		expect(noteForKey('Quote', 48)).toBe(65);
		expect(noteForKey('KeyQ', 48)).toBeNull();
		expect(noteForKey('Space', 48)).toBeNull();
	});

	it('moves an octave with Z and X, and keeps every key on a note', () => {
		expect(baseAfter('KeyZ', 48)).toBe(36);
		expect(baseAfter('KeyX', 48)).toBe(60);
		expect(baseAfter('KeyZ', 0)).toBe(0);
		expect(baseAfter('KeyX', HIGHEST_BASE)).toBe(HIGHEST_BASE);
		expect(HIGHEST_BASE % 12).toBe(0);
		expect(noteForKey('Quote', HIGHEST_BASE)).toBeLessThanOrEqual(127);
		expect(baseAfter('KeyA', 48)).toBeNull();
	});

	it('names the key that plays a note', () => {
		expect(keyFor(48, 48)).toBe('A');
		expect(keyFor(49, 48)).toBe('W');
		expect(keyFor(64, 48)).toBe(';');
		expect(keyFor(65, 48)).toBe("'");
		expect(keyFor(66, 48)).toBe('');
		expect(keyFor(47, 48)).toBe('');
	});

	it('leaves alone a key typed into a field, or one with a modifier', () => {
		const field = { closest: (selector: string) => (selector.includes('input') ? field : null) };
		const page = { closest: () => null };
		const key = (target: object, modifiers = {}) =>
			({ metaKey: false, ctrlKey: false, altKey: false, target, ...modifiers }) as unknown as KeyboardEvent;
		expect(belongsElsewhere(key(field))).toBe(true);
		expect(belongsElsewhere(key(page, { metaKey: true }))).toBe(true);
		expect(belongsElsewhere(key(page, { ctrlKey: true }))).toBe(true);
		expect(belongsElsewhere(key(page, { altKey: true }))).toBe(true);
		expect(belongsElsewhere(key(page))).toBe(false);
	});
});
