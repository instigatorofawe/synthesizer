// How a parameter's slider maps its travel to a value. A range that starts above zero and spans a ratio of 100 or more, as a
// cutoff from 80 Hz to 12 kHz does, is logarithmic: equal travel is an equal ratio, so 900 Hz sits near the middle rather than at
// 7% of the way, and an octave takes the same travel at the bottom as at the top. Any other range is linear. A mixer's fader has
// its own law, in decibels, and doesn't use this.

// What a slider's travel is divided into: the steps its arrows move by, and what a value is rounded to as it is dragged.
export const STEPS = 500;

export interface Taper {
	min: number;
	max: number;
	log: boolean;
}

// The decision: logarithmic when the range is above zero and its ends are two decades or more apart.
export const isLog = (min: number, max: number) => min > 0 && max / min >= 100;

export const taper = (min: number, max: number): Taper => ({ min, max, log: isLog(min, max) });

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

// How far along the travel a value sits, from 0 to 1. A value outside the range sits at its end.
export function travelOf(shape: Taper, value: number): number {
	const { min, max, log } = shape;
	if (!(max > min) || !Number.isFinite(value)) return 0;
	const at = clamp(value, min, max);
	return log ? Math.log(at / min) / Math.log(max / min) : (at - min) / (max - min);
}

// The value at a point of the travel, from 0 to 1. The ends are the range's ends exactly.
export function valueAt(shape: Taper, travel: number): number {
	const { min, max, log } = shape;
	if (!(max > min) || !(travel > 0)) return min;
	if (travel >= 1) return max;
	return log ? min * (max / min) ** travel : min + travel * (max - min);
}

// The step a value is nearest, from 0 to STEPS, which is where a slider shows it.
export const stepOf = (shape: Taper, value: number) => Math.round(travelOf(shape, value) * STEPS);

// The value at one of a slider's steps, rounded to the decimal place that keeps a quarter of a step there, so a dragged
// value reads and saves as 900 rather than 903.4826 or 0.30000000000000004 and still comes back to the same step. The ends
// are the range's own.
export function stepValue(shape: Taper, step: number): number {
	const value = valueAt(shape, step / STEPS);
	if (step <= 0 || step >= STEPS) return value;
	const size = Math.abs(valueAt(shape, (step + 1) / STEPS) - value);
	if (!(size > 0)) return value;
	const digits = -Math.floor(Math.log10(size / 4));
	const rounded =
		digits > 0 ? Number(value.toFixed(Math.min(digits, 20))) : Math.round(value / 10 ** -digits) * 10 ** -digits;
	return clamp(rounded, shape.min, shape.max);
}
