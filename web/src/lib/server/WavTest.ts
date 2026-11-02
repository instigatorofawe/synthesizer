import { describe, expect, it } from 'vitest';
import { decodeWav, keyFromName, rootOf, WavError } from '#lib/server/Wav.ts';

interface Options {
	tag?: number;
	channels?: number;
	rate?: number;
	bytes?: number;
	sampler?: Buffer;
	before?: Buffer; // A chunk ahead of the format, which some writers put there
}

function chunk(id: string, body: Buffer) {
	const head = Buffer.alloc(8);
	head.write(id, 0, 'latin1');
	head.writeUInt32LE(body.length, 4);
	return Buffer.concat([head, body, Buffer.alloc(body.length & 1)]);
}

function format({ tag = 1, channels = 1, rate = 48000, bytes = 2 }: Options) {
	const fmt = Buffer.alloc(16);
	fmt.writeUInt16LE(tag, 0);
	fmt.writeUInt16LE(channels, 2);
	fmt.writeUInt32LE(rate, 4);
	fmt.writeUInt32LE(rate * channels * bytes, 8);
	fmt.writeUInt16LE(channels * bytes, 12);
	fmt.writeUInt16LE(bytes * 8, 14);
	return fmt;
}

function wav(samples: Buffer, options: Options = {}) {
	const body = Buffer.concat([
		Buffer.from('WAVE', 'latin1'),
		options.before ?? Buffer.alloc(0),
		chunk('fmt ', format(options)),
		chunk('data', samples),
		options.sampler ? chunk('smpl', options.sampler) : Buffer.alloc(0)
	]);
	const head = Buffer.alloc(8);
	head.write('RIFF', 0, 'latin1');
	head.writeUInt32LE(body.length, 4);
	return new Uint8Array(Buffer.concat([head, body]));
}

const i16 = (...values: number[]) => {
	const out = Buffer.alloc(values.length * 2);
	values.forEach((v, i) => out.writeInt16LE(v, i * 2));
	return out;
};

function sampler(unity: number, loop?: [number, number]) {
	const out = Buffer.alloc(loop ? 60 : 36);
	out.writeUInt32LE(unity, 12);
	out.writeUInt32LE(loop ? 1 : 0, 28);
	if (loop) {
		out.writeUInt32LE(loop[0], 44);
		out.writeUInt32LE(loop[1], 48);
	}
	return out;
}

const floats = (data: Uint8Array) => [...new Float32Array(data.slice().buffer)];

describe('reading a WAV file', () => {
	it('keeps 16-bit samples as they are', () => {
		const decoded = decodeWav(wav(i16(0, 16384, -32768)));
		expect(decoded).toMatchObject({ encoding: 'i16', channels: 1, rate: 48000, frames: 3, root: null, loop: null, peak: 1 });
		expect([...new Int16Array(decoded.data.slice().buffer)]).toEqual([0, 16384, -32768]);
	});

	it('counts frames, not samples, in stereo', () => {
		const decoded = decodeWav(wav(i16(1, 2, 3, 4), { channels: 2 }));
		expect(decoded).toMatchObject({ channels: 2, frames: 2 });
		expect(decoded.data).toHaveLength(8);
	});

	it('widens 8-bit to i16', () => {
		const decoded = decodeWav(wav(Buffer.from([128, 255, 0]), { bytes: 1 }));
		expect(decoded.encoding).toBe('i16');
		expect([...new Int16Array(decoded.data.slice().buffer)]).toEqual([0, 32512, -32768]);
	});

	it('keeps 24 bits exactly, in f32', () => {
		const decoded = decodeWav(wav(Buffer.from([0, 0, 0x40, 0xff, 0xff, 0xff, 0, 0, 0x80]), { bytes: 3 }));
		expect(decoded.encoding).toBe('f32');
		expect(floats(decoded.data)).toEqual([0.5, -1 / 8388608, -1]);
	});

	it('reads 32-bit PCM and both float widths', () => {
		const pcm = Buffer.alloc(4);
		pcm.writeInt32LE(1 << 30, 0);
		expect(floats(decodeWav(wav(pcm, { bytes: 4 })).data)).toEqual([0.5]);
		const single = Buffer.alloc(4);
		single.writeFloatLE(0.25, 0);
		expect(floats(decodeWav(wav(single, { tag: 3, bytes: 4 })).data)).toEqual([0.25]);
		const double = Buffer.alloc(8);
		double.writeDoubleLE(-0.75, 0);
		expect(floats(decodeWav(wav(double, { tag: 3, bytes: 8 })).data)).toEqual([-0.75]);
	});

	it('finds the format wherever it is, past a chunk of odd length', () => {
		const decoded = decodeWav(wav(i16(7), { before: chunk('LIST', Buffer.from('abc')) }));
		expect(decoded.frames).toBe(1);
	});

	it('takes the extensible format for what it wraps', () => {
		const fmt = Buffer.concat([format({ tag: 0xfffe }), Buffer.alloc(24)]);
		fmt.writeUInt16LE(1, 24);
		const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), chunk('fmt ', fmt), chunk('data', i16(5))]);
		const head = Buffer.alloc(8);
		head.write('RIFF', 0, 'latin1');
		expect(decodeWav(new Uint8Array(Buffer.concat([head, body]))).frames).toBe(1);
	});

	it('reads a root and a loop from a sampler chunk, with the end made exclusive', () => {
		const decoded = decodeWav(wav(i16(0, 0, 0, 0, 0, 0), { sampler: sampler(69, [1, 3]) }));
		expect(decoded.root).toBe(69);
		expect(decoded.loop).toEqual({ start: 1, end: 4 });
	});

	it('keeps a loop inside the audio, and ignores one that collapses', () => {
		expect(decodeWav(wav(i16(0, 0, 0), { sampler: sampler(60, [1, 900]) })).loop).toEqual({ start: 1, end: 3 });
		expect(decodeWav(wav(i16(0, 0, 0), { sampler: sampler(60, [800, 900]) })).loop).toBeNull();
	});

	it('ignores a root that is no key', () => {
		expect(decodeWav(wav(i16(0), { sampler: sampler(200) })).root).toBeNull();
	});

	it('reads what is there of a file that was cut off', () => {
		const whole = wav(i16(1, 2, 3, 4));
		expect(decodeWav(whole.subarray(0, whole.length - 3)).frames).toBe(2);
	});

	it.each([
		['something else', new Uint8Array(Buffer.from('not audio at all')), 'not a WAV'],
		['nothing at all', new Uint8Array(0), 'not a WAV'],
		['no audio', wav(Buffer.alloc(0)), 'no audio'],
		['six channels', wav(i16(0, 0, 0, 0, 0, 0), { channels: 6 }), '6 channels'],
		['a compressed format', wav(i16(0), { tag: 85 }), 'format 85'],
		['12-byte samples', wav(Buffer.alloc(12), { bytes: 12 }), '96-bit'],
		['16-bit float', wav(i16(0), { tag: 3, bytes: 2 }), '16-bit'],
		['no channels', wav(i16(0), { channels: 0 }), '0 channels'],
		['no sample rate', wav(i16(0), { rate: 0 }), 'no sample rate']
	])('refuses %s', (_, bytes, reason) => {
		expect(() => decodeWav(bytes)).toThrow(WavError);
		expect(() => decodeWav(bytes)).toThrow(reason);
	});

	it('refuses samples that are not numbers, since a sound can be nothing else', () => {
		const bad = Buffer.alloc(4);
		bad.writeFloatLE(Number.NaN, 0);
		expect(() => decodeWav(wav(bad, { tag: 3, bytes: 4 }))).toThrow('not numbers');
	});

	it('survives random bytes without anything but a refusal', () => {
		let seed = 12345;
		const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
		for (let round = 0; round < 2000; ++round) {
			const bytes = wav(i16(1, 2, 3, 4), { sampler: sampler(60, [0, 2]) });
			for (let hit = 0; hit < 6; ++hit) bytes[next() % bytes.length] = next() & 0xff;
			try {
				decodeWav(bytes);
			} catch (e) {
				expect(e).toBeInstanceOf(WavError);
			}
		}
	});
});

describe('finding the key a sample was recorded at', () => {
	it.each([
		['Piano_C4.wav', 60],
		['horn-Bb2.wav', 46],
		['Strings A#3.WAV', 58],
		['a4.wav', 69],
		['low C-1.wav', 0]
	])('reads %s', (name, key) => {
		expect(keyFromName(name)).toBe(key);
	});

	it.each(['Bass2.wav', 'kick.wav', 'take12.wav', 'Piano_C10.wav', 'G9b.wav'])('finds nothing in %s', (name) => {
		expect(keyFromName(name)).toBeNull();
	});

	it('prefers what the file says, then its name, then middle C', () => {
		const said = decodeWav(wav(i16(0), { sampler: sampler(50) }));
		const silent = decodeWav(wav(i16(0)));
		expect(rootOf(said, 'Piano_C4.wav')).toBe(50);
		expect(rootOf(silent, 'Piano_C4.wav')).toBe(60);
		expect(rootOf(silent, 'kick.wav')).toBe(60);
	});
});
