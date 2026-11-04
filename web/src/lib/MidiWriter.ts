// Standard MIDI Files written byte by byte, which is how the tests of Midi.ts and MidiImport.ts make the files they read
// back. It writes what it is given and nothing more: a test can leave a status out to run on from the one before, or write
// bytes no tool would, to see what the reader makes of them.

// An event at a tick in its track, and its bytes after the delta time.
export interface Raw {
	tick: number;
	bytes: number[];
}

export function quantity(value: number): number[] {
	const out = [value & 0x7f];
	for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) out.unshift((rest & 0x7f) | 0x80);
	return out;
}

const u32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

// A track's chunk: its events in order of their ticks, and those at one tick in the order given, each after the ticks since
// the one before, and an End of Track after the last unless `end` says where, or null for none.
export function track(events: Raw[], end?: number | null): number[] {
	const sorted = [...events].sort((a, b) => a.tick - b.tick);
	const body: number[] = [];
	let now = 0;
	end = end === undefined ? (sorted.at(-1)?.tick ?? 0) : end;
	for (const event of sorted) {
		body.push(...quantity(event.tick - now), ...event.bytes);
		now = event.tick;
	}
	if (end !== null) body.push(...quantity(end - now), 0xff, 0x2f, 0x00);
	return [...ascii('MTrk'), ...u32(body.length), ...body];
}

// A whole file. `division` is ticks a quarter, or the raw header word for SMPTE timing.
export function midiFile(format: number, division: number, tracks: number[][]): Uint8Array {
	return new Uint8Array([
		...ascii('MThd'),
		...u32(6),
		...u16(format),
		...u16(tracks.length),
		...u16(division),
		...tracks.flat()
	]);
}

// Events as a file holds them, channels counted from 0.
export const on = (tick: number, channel: number, key: number, velocity = 100): Raw => ({
	tick,
	bytes: [0x90 | channel, key, velocity]
});
export const off = (tick: number, channel: number, key: number, velocity = 64): Raw => ({
	tick,
	bytes: [0x80 | channel, key, velocity]
});
export const cc = (tick: number, channel: number, controller: number, value: number): Raw => ({
	tick,
	bytes: [0xb0 | channel, controller, value]
});
export const program = (tick: number, channel: number, value: number): Raw => ({
	tick,
	bytes: [0xc0 | channel, value]
});
export const pressure = (tick: number, channel: number, value: number): Raw => ({
	tick,
	bytes: [0xd0 | channel, value]
});
export const keyPressure = (tick: number, channel: number, key: number, value: number): Raw => ({
	tick,
	bytes: [0xa0 | channel, key, value]
});
// The wheel from -8192 to 8191.
export const bend = (tick: number, channel: number, value: number): Raw => ({
	tick,
	bytes: [0xe0 | channel, (value + 8192) & 0x7f, ((value + 8192) >> 7) & 0x7f]
});
// Data bytes alone, which run on from the status before them.
export const running = (tick: number, ...bytes: number[]): Raw => ({ tick, bytes });

export const meta = (tick: number, type: number, body: number[]): Raw => ({
	tick,
	bytes: [0xff, type, ...quantity(body.length), ...body]
});
export const tempo = (tick: number, bpm: number) => {
	const perQuarter = Math.round(60e6 / bpm);
	return meta(tick, 0x51, [(perQuarter >> 16) & 0xff, (perQuarter >> 8) & 0xff, perQuarter & 0xff]);
};
export const meter = (tick: number, beats: number, unit: number) => meta(tick, 0x58, [beats, Math.log2(unit), 24, 8]);
export const key = (tick: number, fifths: number, minor = false) => meta(tick, 0x59, [fifths & 0xff, minor ? 1 : 0]);
export const name = (tick: number, text: string) => meta(tick, 0x03, [...new TextEncoder().encode(text)]);
export const sysex = (tick: number, body: number[]): Raw => ({
	tick,
	bytes: [0xf0, ...quantity(body.length), ...body]
});
