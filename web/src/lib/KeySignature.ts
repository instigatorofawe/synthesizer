// Key signatures: how many sharps or flats, as fifths from C, and whether the key is minor. They change how notes are named
// and spelled and nothing about how a song plays, so the compiler ignores them, as it ignores time signatures (TimeSignature.ts). A
// song that says none is in C major.
import type { Timeline } from '#lib/Schema.ts';

export interface Key {
	fifths: number; // -7 to 7: flats below 0, sharps above
	minor?: boolean;
}
export type KeyChange = Key & { tick: number };

export const C_MAJOR: Key = { fifths: 0 };

// Each key's tonic, from seven flats to seven sharps.
const MAJORS = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const MINORS = ['A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯'];

export const keyName = (key: Key) =>
	`${(key.minor ? MINORS : MAJORS)[key.fifths + 7]} ${key.minor ? 'minor' : 'major'}`;

// What a key signature has, as it reads beside a key's name: 2♯, 3♭, or nothing for C major and A minor.
export const accidentalsText = (fifths: number) => (fifths > 0 ? `${fifths}♯` : fifths < 0 ? `${-fifths}♭` : '');

export const sameKey = (a: Key, b: Key) => a.fifths === b.fifths && !!a.minor === !!b.minor;

// Every key a song can be in, majors then minors, each from the most flats to the most sharps, for a list to choose from.
export const KEYS: Key[] = [
	...MAJORS.map((_, index) => ({ fifths: index - 7 })),
	...MINORS.map((_, index) => ({ fifths: index - 7, minor: true }))
];

// A key as a list's value and back, so a <select> can hold one.
export const keyValue = (key: Key) => `${key.fifths}${key.minor ? 'm' : ''}`;
export function parseKeyValue(value: string): Key | null {
	const match = /^(-?\d)(m?)$/.exec(value);
	if (!match) return null;
	const fifths = Number(match[1]);
	if (fifths < -7 || fifths > 7) return null;
	return match[2] ? { fifths, minor: true } : { fifths };
}

// The changes a song's keys make, in order, the first at tick 0.
export function keysOf(doc: Pick<Timeline, 'key'>): KeyChange[] {
	const sorted = [...(doc.key ?? [])].sort((a, b) => a.tick - b.tick);
	if (!sorted.length || sorted[0].tick > 0) sorted.unshift({ tick: 0, ...C_MAJOR });
	return sorted;
}

// A key on its own, without where it changes.
const keyOnly = ({ fifths, minor }: Key): Key => (minor ? { fifths, minor } : { fifths });

// The key playing at a tick.
export function keyAt(doc: Pick<Timeline, 'key'>, tick: number): Key {
	const keys = keysOf(doc);
	return keyOnly(keys.findLast((change) => change.tick <= tick) ?? keys[0]);
}

// ------------------------------------------------------------------------------------------------------------------ edits

// A document says only what differs from C major throughout.
function tidy(doc: Timeline, keys: KeyChange[]): Timeline {
	const { key: _key, ...rest } = doc;
	const sorted = [...keys].sort((a, b) => a.tick - b.tick);
	const plain = sorted.length === 1 && sameKey(sorted[0], C_MAJOR);
	return {
		...rest,
		...(plain
			? {}
			: { key: sorted.map(({ tick, fifths, minor }) => (minor ? { tick, fifths, minor } : { tick, fifths })) })
	} as Timeline;
}

// A key from a tick on. One there already is changed instead.
export function addKey(doc: Timeline, tick: number, key: Key): Timeline {
	const at = Math.max(0, tick);
	return tidy(doc, [...keysOf(doc).filter((change) => change.tick !== at), { tick: at, ...keyOnly(key) }]);
}

export const setKey = (doc: Timeline, index: number, key: Key) =>
	tidy(
		doc,
		keysOf(doc).map((change, i) => (i === index ? { tick: change.tick, ...keyOnly(key) } : change))
	);

// The first one says what the song opens in, so it stays.
export const removeKey = (doc: Timeline, index: number) =>
	index <= 0
		? doc
		: tidy(
				doc,
				keysOf(doc).filter((_, i) => i !== index)
			);
