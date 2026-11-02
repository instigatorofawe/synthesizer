// A WAV file of 24-bit PCM, which every player and editor reads. Samples past full scale are clipped, as a converter would.
export function encodeWav(channels: Float32Array[], rate: number): Uint8Array<ArrayBuffer> {
	const frames = channels[0]?.length ?? 0;
	const bytesPerSample = 3;
	const data = frames * channels.length * bytesPerSample;
	const out = new Uint8Array(44 + data);
	const view = new DataView(out.buffer);
	const text = (at: number, value: string) => {
		for (let i = 0; i < value.length; ++i) out[at + i] = value.charCodeAt(i);
	};
	text(0, 'RIFF');
	view.setUint32(4, 36 + data, true);
	text(8, 'WAVE');
	text(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, channels.length, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * channels.length * bytesPerSample, true);
	view.setUint16(32, channels.length * bytesPerSample, true);
	view.setUint16(34, bytesPerSample * 8, true);
	text(36, 'data');
	view.setUint32(40, data, true);
	let at = 44;
	for (let frame = 0; frame < frames; ++frame) {
		for (const channel of channels) {
			const clipped = Math.max(-1, Math.min(1, channel[frame]));
			const value = Math.round(clipped * 8388607);
			out[at] = value & 0xff;
			out[at + 1] = (value >> 8) & 0xff;
			out[at + 2] = (value >> 16) & 0xff;
			at += 3;
		}
	}
	return out;
}
