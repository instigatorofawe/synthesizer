import { describe, expect, it } from 'vitest';
import {
	KEYS,
	accidentalsText,
	addKey,
	keyAt,
	keyName,
	keyValue,
	keysOf,
	parseKeyValue,
	removeKey,
	setKey
} from '#lib/KeySignature.ts';
import { timelineSchema } from '#lib/Schema.ts';

const song = (extra: object = {}) => timelineSchema.parse({ ...extra });

describe('a key', () => {
	it('is named by its tonic and mode, and says its sharps or flats', () => {
		expect(keyName({ fifths: 0 })).toBe('C major');
		expect(keyName({ fifths: 0, minor: true })).toBe('A minor');
		expect(keyName({ fifths: -3 })).toBe('E♭ major');
		expect(keyName({ fifths: 2, minor: true })).toBe('B minor');
		expect(keyName({ fifths: 7 })).toBe('C♯ major');
		expect(accidentalsText(-3)).toBe('3♭');
		expect(accidentalsText(2)).toBe('2♯');
		expect(accidentalsText(0)).toBe('');
	});

	it('is one of thirty, each read back from its value', () => {
		expect(KEYS).toHaveLength(30);
		for (const key of KEYS) expect(parseKeyValue(keyValue(key))).toEqual(key);
		expect(parseKeyValue('8')).toBeNull();
		expect(parseKeyValue('x')).toBeNull();
	});
});

describe('a song’s keys', () => {
	it('are C major throughout until one says otherwise', () => {
		expect(keysOf(song())).toEqual([{ tick: 0, fifths: 0 }]);
		expect(keyAt(song(), 5000)).toEqual({ tick: 0, fifths: 0 });
	});

	it('are added, changed and taken away, the first staying, and say nothing when they are C major throughout', () => {
		let doc = addKey(song(), 3840, { fifths: -1 });
		expect(doc.key).toEqual([
			{ tick: 0, fifths: 0 },
			{ tick: 3840, fifths: -1 }
		]);
		expect(keyAt(doc, 3839)).toMatchObject({ fifths: 0 });
		expect(keyAt(doc, 3840)).toMatchObject({ fifths: -1 });
		doc = setKey(doc, 0, { fifths: 0, minor: true });
		expect(doc.key?.[0]).toEqual({ tick: 0, fifths: 0, minor: true });
		expect(removeKey(doc, 0)).toBe(doc);
		doc = removeKey(setKey(doc, 0, { fifths: 0 }), 1);
		expect(doc).not.toHaveProperty('key');
	});

	it('are refused two at one tick', () => {
		const twice = [
			{ tick: 0, fifths: 0 },
			{ tick: 0, fifths: 1 }
		];
		expect(timelineSchema.safeParse({ key: twice }).success).toBe(false);
		expect(timelineSchema.safeParse({ key: [{ tick: 0, fifths: 8 }] }).success).toBe(false);
	});
});
