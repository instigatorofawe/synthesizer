// Test sounds, and the rule for them: a level judged against another level never takes in a moment where a voice overlaps
// itself. A release of r rings for about 9.2 r to -80 dB, so a release of 10 ms under a note that starts again at a loop's wrap
// adds the old note's tail to the new one's start, by an amount that depends on the phase they meet at, and so on the sample
// rate and on where the test's window falls. Use a 0.1 ms release, and a clip longer than the test listens. Never choose a
// pitch or a tempo because it comes out evenly at one rate.

// A sine, as loud as its note's velocity unless `velocity` is false, held while its key is, times a level the song or the
// patch sets: so a meter reads the level and the velocity straight off. Its release is 0.1 ms, so a note that starts again on
// its own pitch, as a looped one does at each wrap, never adds to the last one still ringing out.
export function tone(level: { scope: string; default: number }, velocity = true) {
	const out = velocity ? 10 : 9;
	return {
		params: [{ id: 7, name: 'level', min: 0, max: 1, smooth_ms: 0, ...level }],
		nodes: [
			{ id: 1, type: 'note' },
			{ id: 2, type: 'mtof' },
			{ id: 3, type: 'osc', wave: 'sine' },
			{ id: 4, type: 'env', inputs: { attack: 0.001, decay: 0.01, sustain: 1, release: 0.0001 } },
			{ id: 5, type: 'mul' },
			{ id: 6, type: 'param', param: 7 },
			{ id: 8, type: 'mul' },
			...(velocity ? [{ id: 9, type: 'mul' }] : []),
			{ id: out, type: 'out' }
		],
		edges: [
			{ from: 1, port: 'pitch', to: 2, input: 'in' },
			{ from: 2, to: 3, input: 'freq' },
			{ from: 3, to: 5, input: 'a' },
			{ from: 4, to: 5, input: 'b' },
			{ from: 5, to: 8, input: 'a' },
			{ from: 6, to: 8, input: 'b' },
			...(velocity
				? [
						{ from: 8, to: 9, input: 'a' },
						{ from: 1, port: 'velocity', to: 9, input: 'b' },
						{ from: 9, to: out, input: 'l' },
						{ from: 9, to: out, input: 'r' }
					]
				: [
						{ from: 8, to: out, input: 'l' },
						{ from: 8, to: out, input: 'r' }
					])
		]
	};
}
