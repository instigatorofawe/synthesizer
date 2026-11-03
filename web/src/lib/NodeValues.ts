// The values drawn on a node, beside the inputs no wire feeds, and how dragging one across changes it, as a DAW's knob scrubs:
// along the input's range where it has one, logarithmically where its slider would be (`Taper.ts`), and in proportion to the
// value where it has none. Shift drags a tenth as fast.
import type { InputHelp } from '#lib/NodeHelp.ts';
import { taper, travelOf, valueAt } from '#lib/Taper.ts';

export const SCRUB_PX = 200; // A drag this far goes across a whole range, or by the value's own size where there is none

const rounded = (value: number) => Number(value.toPrecision(4));

export function scrubbed(from: number, dx: number, range: InputHelp | undefined, fine: boolean): number {
	const by = (dx / SCRUB_PX) * (fine ? 0.1 : 1);
	if (typeof range?.min === 'number' && typeof range.max === 'number' && range.max > range.min) {
		const shape = taper(range.min, range.max);
		return rounded(valueAt(shape, Math.min(1, Math.max(0, travelOf(shape, from) + by))));
	}
	return rounded(from + by * Math.max(Math.abs(from), 1));
}

// A value as a node shows it: four figures, with a short unit. A long one, as "MIDI note", is the inspector's to say.
export const valueText = (value: number, unit?: string) =>
	`${rounded(value)}${unit && unit.length <= 3 ? ` ${unit}` : ''}`;
