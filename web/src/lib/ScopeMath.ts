// The oscilloscope's logic, separate from drawing so it can be tested.

// Keeps the newest samples of a tap, addressed by absolute sample index.
export class Ring {
	readonly data: Float32Array;
	private end = 0; // absolute index one past the newest sample

	constructor(readonly capacity: number) {
		this.data = new Float32Array(capacity);
	}

	push(samples: Float32Array, start: number) {
		// A jump means blocks were dropped. The gap reads as silence rather than joining two unrelated moments.
		if (start > this.end) {
			for (let i = this.end; i < start; ++i) this.data[i % this.capacity] = 0;
		}
		for (let i = 0; i < samples.length; ++i) this.data[(start + i) % this.capacity] = samples[i];
		this.end = start + samples.length;
	}

	get newest() {
		return this.end;
	}

	at(index: number) {
		return this.data[index % this.capacity];
	}
}

// Searches back from the newest sample for a rising edge through `level`, with hysteresis so noise does not retrigger.
// Returns the absolute index to start the trace at, so `span` samples after it exist. Null means free-run: no edge
// arrived, so silence and noise still draw.
export function findTrigger(ring: Ring, span: number, level: number, hysteresis = 0.02): number | null {
	const newest = ring.newest - span;
	const oldest = Math.max(ring.newest - ring.capacity + 1, span);
	for (let i = newest; i >= oldest; --i) {
		if (ring.at(i) < level || ring.at(i - 1) >= level) continue;
		for (let back = 1; back < span && i - back >= oldest; ++back) {
			if (ring.at(i - back) < level - hysteresis) return i;
		}
	}
	return null;
}

export interface Column {
	min: number;
	max: number;
}

// One min and max per pixel, so peaks do not vanish on wide timebases.
export function columns(ring: Ring, start: number, span: number, width: number): Column[] {
	const out: Column[] = [];
	for (let x = 0; x < width; ++x) {
		const from = start + Math.floor((x * span) / width);
		const to = Math.max(from + 1, start + Math.floor(((x + 1) * span) / width));
		let min = Infinity;
		let max = -Infinity;
		for (let i = from; i < to; ++i) {
			const v = ring.at(i);
			if (v < min) min = v;
			if (v > max) max = v;
		}
		out.push({ min, max });
	}
	return out;
}
