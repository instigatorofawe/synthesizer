// Reads a WAV file into what an asset holds. Files come from outside, so every length is checked against the bytes that are
// actually there, and anything this can't read exactly is refused with the reason. Nothing is resampled, because an asset
// plays at its own rate on any engine.
export class WavError extends Error {}

export interface Wav {
	encoding: 'i16' | 'f32';
	channels: 1 | 2;
	rate: number;
	frames: number;
	data: Uint8Array; // Interleaved and little endian, as an asset holds it
	root: number | null; // The key it was recorded at, if the file says
	loop: { start: number; end: number } | null; // `end` is one past the last frame, as an asset's is
	peak: number; // Full scale is 1
}

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;
const MIDDLE_C = 60;

interface Format {
	tag: number;
	channels: number;
	rate: number;
	sampleBytes: number;
}

function readFormat(view: DataView, at: number, size: number): Format {
	if (size < 16) throw new WavError('its format chunk is too short');
	const channels = view.getUint16(at + 2, true);
	const blockAlign = view.getUint16(at + 12, true);
	let tag = view.getUint16(at, true);
	if (tag === EXTENSIBLE) {
		if (size < 26) throw new WavError('its format chunk is too short');
		tag = view.getUint16(at + 24, true); // The first two bytes of the subformat GUID
	}
	return { tag, channels, rate: view.getUint32(at + 4, true), sampleBytes: channels ? blockAlign / channels : 0 };
}

function checkFormat({ tag, channels, rate, sampleBytes }: Format) {
	if (tag !== PCM && tag !== FLOAT) throw new WavError(`it uses format ${tag}, and only PCM and float can be read`);
	if (channels !== 1 && channels !== 2) throw new WavError(`it has ${channels} channels, and an asset has 1 or 2`);
	if (rate < 1) throw new WavError('it has no sample rate');
	const known = tag === PCM ? [1, 2, 3, 4] : [4, 8];
	if (!known.includes(sampleBytes)) throw new WavError(`it has ${sampleBytes * 8}-bit samples, which can't be read`);
}

function sampleReader(view: DataView, { tag, sampleBytes }: Format): (at: number) => number {
	if (tag === FLOAT) {
		return sampleBytes === 4 ? (at) => view.getFloat32(at, true) : (at) => view.getFloat64(at, true);
	}
	if (sampleBytes === 1) return (at) => (view.getUint8(at) - 128) / 128;
	if (sampleBytes === 2) return (at) => view.getInt16(at, true) / 32768;
	if (sampleBytes === 3) {
		return (at) => ((view.getInt8(at + 2) << 16) | view.getUint16(at, true)) / 8388608;
	}
	return (at) => view.getInt32(at, true) / 2147483648;
}

// 16 bits or fewer fit i16 and cost half the memory. More than that stays exact in f32.
function convert(view: DataView, start: number, samples: number, format: Format) {
	const read = sampleReader(view, format);
	const wide = format.tag === FLOAT || format.sampleBytes > 2;
	const data = new Uint8Array(samples * (wide ? 4 : 2));
	const out = new DataView(data.buffer);
	let peak = 0;
	for (let i = 0; i < samples; ++i) {
		const value = read(start + i * format.sampleBytes);
		if (!Number.isFinite(value)) throw new WavError('it has samples that are not numbers');
		peak = Math.max(peak, Math.abs(value));
		if (wide) out.setFloat32(i * 4, value, true);
		else out.setInt16(i * 2, Math.round(value * 32768), true);
	}
	return { data, peak, encoding: wide ? ('f32' as const) : ('i16' as const) };
}

// The sampler chunk. Its first loop is the sustain loop, and its end is the last frame played rather than one past it.
function readSampler(view: DataView, at: number, size: number, frames: number) {
	if (size < 36) return { root: null, loop: null };
	const unity = view.getUint32(at + 12, true);
	const root = unity <= 127 ? unity : null;
	if (view.getUint32(at + 28, true) === 0 || size < 60) return { root, loop: null };
	const start = view.getUint32(at + 44, true);
	const end = Math.min(frames, view.getUint32(at + 48, true) + 1);
	return { root, loop: start < end ? { start, end } : null };
}

export function decodeWav(bytes: Uint8Array): Wav {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
	if (bytes.length < 12 || text(0) !== 'RIFF' || text(8) !== 'WAVE') throw new WavError('it is not a WAV file');

	let format: Format | null = null;
	let data: { at: number; size: number } | null = null;
	let sampler: { at: number; size: number } | null = null;
	for (let at = 12; at + 8 <= bytes.length;) {
		const id = text(at);
		const body = at + 8;
		const size = Math.min(view.getUint32(at + 4, true), bytes.length - body); // A cut-off file reads as far as it goes
		if (id === 'fmt ') format = readFormat(view, body, size);
		else if (id === 'data') data = { at: body, size };
		else if (id === 'smpl') sampler = { at: body, size };
		at = body + size + (size & 1); // Chunks sit on even offsets
	}
	if (!format) throw new WavError('it has no format chunk');
	if (!data) throw new WavError('it has no data chunk');
	checkFormat(format);

	const frames = Math.floor(data.size / (format.sampleBytes * format.channels));
	if (frames === 0) throw new WavError('it has no audio');
	const { root, loop } = sampler ? readSampler(view, sampler.at, sampler.size, frames) : { root: null, loop: null };
	return {
		...convert(view, data.at, frames * format.channels, format),
		channels: format.channels as 1 | 2,
		rate: format.rate,
		frames,
		root,
		loop
	};
}

const LETTERS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// A key from a name such as `Piano_C#4.wav` or `horn-Bb2`, with 60 as C4. A note has to stand alone, or `Bass2` would be a B.
export function keyFromName(name: string): number | null {
	const stem = name.replace(/\.[^.]*$/, '');
	const found = /(?:^|[^a-z0-9])([a-g])([#b]?)(-?\d)(?![a-z0-9])/i.exec(stem);
	if (!found) return null;
	const accidental = found[2] === '#' ? 1 : found[2].toLowerCase() === 'b' ? -1 : 0;
	const key = LETTERS[found[1].toLowerCase()] + accidental + (Number(found[3]) + 1) * 12;
	return key >= 0 && key <= 127 ? key : null;
}

export const rootOf = (wav: Wav, name: string) => wav.root ?? keyFromName(name) ?? MIDDLE_C;
