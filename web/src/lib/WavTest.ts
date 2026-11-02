import { describe, expect, it } from 'vitest';
import { encodeWav } from '#lib/Wav.ts';

describe('a WAV file', () => {
	it('has a header any reader takes, and its samples interleaved in 24 bits', () => {
		const left = new Float32Array([0, 1, -1, 2]);
		const right = new Float32Array([0.5, -0.5, 0, -3]);
		const bytes = encodeWav([left, right], 48000);
		const view = new DataView(bytes.buffer);
		const text = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4));
		expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
		expect(view.getUint32(4, true)).toBe(bytes.length - 8);
		expect(view.getUint16(22, true)).toBe(2);
		expect(view.getUint32(24, true)).toBe(48000);
		expect(view.getUint16(34, true)).toBe(24);
		expect(view.getUint32(40, true)).toBe(4 * 2 * 3);
		const sample = (index: number) => {
			const at = 44 + index * 3;
			return ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) << 8) >> 8;
		};
		expect([0, 1, 2, 3, 4, 5, 6, 7].map(sample)).toEqual([
			0, 4194304, 8388607, -4194303, -8388607, 0, 8388607, -8388607
		]);
	});
});
