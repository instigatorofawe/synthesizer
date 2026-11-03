// The computer keyboard as a piano, as most DAWs lay it out: the home row is the white keys from C, the row above it the
// black keys, and Z and X move down and up an octave. Keys are matched by where they are, `KeyboardEvent.code`, so a
// French or German layout plays the same piano. No other shortcut may use these keys, bare or with Shift (Shortcuts.ts).
import { shortcut, typingIn } from '#lib/Shortcuts.ts';

const KEYS = [
	'KeyA', // C
	'KeyW',
	'KeyS', // D
	'KeyE',
	'KeyD', // E
	'KeyF', // F
	'KeyT',
	'KeyG', // G
	'KeyY',
	'KeyH', // A
	'KeyU',
	'KeyJ', // B
	'KeyK', // C
	'KeyO',
	'KeyL', // D
	'KeyP',
	'Semicolon', // E
	'Quote' // F
];

const LETTERS: Record<string, string> = { Semicolon: ';', Quote: "'" };

const OCTAVE_DOWN = shortcut('octave-down').code;
const OCTAVE_UP = shortcut('octave-up').code;

// Every key the piano takes: its notes and its octave.
export const PIANO_KEYS: readonly string[] = [...KEYS, OCTAVE_DOWN, OCTAVE_UP];

// The lowest C the keys can reach and the highest, so every key plays a note from 0 to 127.
export const LOWEST_BASE = 0;
export const HIGHEST_BASE = 127 - (KEYS.length - 1) - ((127 - (KEYS.length - 1)) % 12);

// The note a key plays with the A key on `base`, or null for a key that isn't one of the piano's.
export function noteForKey(code: string, base: number): number | null {
	const at = KEYS.indexOf(code);
	return at < 0 ? null : base + at;
}

// The base after a key that moves it, or null for any other key. It stays a C, and every key stays on a note.
export function baseAfter(code: string, base: number): number | null {
	if (code === OCTAVE_DOWN) return Math.max(LOWEST_BASE, base - 12);
	if (code === OCTAVE_UP) return Math.min(HIGHEST_BASE, base + 12);
	return null;
}

// What to show on the key that plays `note`, or '' if no key does.
export function keyFor(note: number, base: number): string {
	const code = KEYS[note - base];
	if (!code) return '';
	return LETTERS[code] ?? code.slice(3);
}

// Whether a key belongs to something else on the page: a field being typed in, or a shortcut with a modifier. A button or a
// slider with focus leaves the keys to the piano, as it leaves Space to the transport.
export function belongsElsewhere(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'target'>): boolean {
	return event.metaKey || event.ctrlKey || event.altKey || typingIn(event.target);
}
