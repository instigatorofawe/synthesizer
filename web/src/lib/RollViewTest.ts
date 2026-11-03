import { describe, expect, it } from 'vitest';
import {
	BEAT,
	ROWS,
	anchored,
	clampBeat,
	clampRow,
	dropGone,
	fitRoll,
	keepZoom,
	keptZoom,
	wheelAction,
	zoomKey,
	type Wheel
} from '#lib/RollView.ts';

const wheel = (over: Partial<Wheel>): Wheel => ({
	deltaX: 0,
	deltaY: 0,
	deltaMode: 0,
	shiftKey: false,
	ctrlKey: false,
	metaKey: false,
	...over
});

describe('the wheel in the roll', () => {
	it('leaves a plain wheel or two fingers to the browser, which scrolls', () => {
		expect(wheelAction(wheel({ deltaY: 100 }), 'Meta', 600)).toEqual({ kind: 'scroll' });
		expect(wheelAction(wheel({ deltaX: 40, deltaY: 3 }), 'Control', 600)).toEqual({ kind: 'scroll' });
	});

	it('scrolls sideways with Shift, whichever way the system sends the turn', () => {
		expect(wheelAction(wheel({ deltaY: 100, shiftKey: true }), 'Control', 600)).toEqual({ kind: 'sideways', by: 100 });
		// macOS sends a Shifted mouse wheel as deltaX
		expect(wheelAction(wheel({ deltaX: -100, shiftKey: true }), 'Meta', 600)).toEqual({ kind: 'sideways', by: -100 });
	});

	it('counts a wheel that turns in lines or pages in pixels', () => {
		expect(wheelAction(wheel({ deltaY: 3, deltaMode: 1, shiftKey: true }), 'Control', 600)).toEqual({
			kind: 'sideways',
			by: 48
		});
		expect(wheelAction(wheel({ deltaY: 1, deltaMode: 2, shiftKey: true }), 'Control', 600)).toEqual({
			kind: 'sideways',
			by: 600
		});
	});

	it('zooms with Mod, in when the wheel turns up, and out when it turns down', () => {
		const up = wheelAction(wheel({ deltaY: -100, metaKey: true }), 'Meta', 600);
		const down = wheelAction(wheel({ deltaY: 100, ctrlKey: true }), 'Control', 600);
		expect(up.kind).toBe('zoom');
		expect(down.kind).toBe('zoom');
		expect(up.kind === 'zoom' && up.by).toBeGreaterThan(1);
		expect(down.kind === 'zoom' && down.by).toBeLessThan(1);
	});

	it('zooms with a pinch, which comes with ctrlKey on a Mac too, where Ctrl is not Mod', () => {
		const pinch = wheelAction(wheel({ deltaY: -4, ctrlKey: true }), 'Meta', 600);
		expect(pinch.kind).toBe('zoom');
		expect(pinch.kind === 'zoom' && pinch.by).toBeCloseTo(2 ** (4 / 150));
	});

	it('zooms a notch of a wheel no further than a short pinch', () => {
		const notch = wheelAction(wheel({ deltaY: -500, metaKey: true }), 'Meta', 600);
		expect(notch).toEqual({ kind: 'zoom', by: 2 ** (50 / 150) });
	});

	it('sets the row height with Mod and Shift, and with a Shifted pinch', () => {
		const taller = wheelAction(wheel({ deltaX: -100, metaKey: true, shiftKey: true }), 'Meta', 600);
		expect(taller.kind).toBe('rows');
		expect(taller.kind === 'rows' && taller.by).toBeGreaterThan(1);
		expect(wheelAction(wheel({ deltaY: 100, ctrlKey: true, shiftKey: true }), 'Control', 600).kind).toBe('rows');
	});

	it('ignores the Mod of the other platform', () => {
		expect(wheelAction(wheel({ deltaY: 100, metaKey: true }), 'Control', 600)).toEqual({ kind: 'scroll' });
	});
});

describe('zooming around the pointer', () => {
	it('keeps what is under the pointer where it was', () => {
		// 300 px scrolled, the pointer 200 px in: content at 500 is under it, and at twice the size that is at 1000.
		expect(anchored(300, 200, 2)).toBe(800);
		expect(anchored(300, 200, 0.5)).toBe(50);
	});

	it('leaves out what comes before the zoomed part, as the keys do', () => {
		// 48 px of keys: the pointer 248 px in is 200 px into the notes, 500 with the scroll, and 1000 at twice the size.
		expect(anchored(300, 248, 2, 48)).toBe(800);
	});

	it('never scrolls before the start', () => {
		expect(anchored(0, 10, 0.5)).toBe(0);
	});
});

describe('fitting the roll to the notes', () => {
	const ppq = 480;
	const bar = 4 * ppq;
	const note = (tick: number, pitch: number, dur = ppq) => ({ tick, note: pitch, dur, vel: 100 });

	it('fits the bars the notes are in across the roll, and their pitches down it', () => {
		const clip = { length: 4 * bar, notes: [note(0, 60), note(bar + ppq, 67), note(2 * bar - ppq, 64)] };
		const view = fitRoll(clip, ppq, { width: 800, height: 600 });
		expect(view.beat).toBe(100); // Two bars, eight beats, in 800 px
		expect(view.left).toBe(0);
		expect(view.row).toBe(ROWS.most); // 58 to 69 would be 50 px rows
		expect(fitRoll(clip, ppq, { width: 800, height: 240 }).row).toBe(20);
	});

	it('scrolls to the first bar with a note, and centres the notes', () => {
		const clip = { length: 8 * bar, notes: [note(2 * bar + 10, 40), note(3 * bar, 80, bar)] };
		const view = fitRoll(clip, ppq, { width: 1200, height: 360 });
		expect(view.beat).toBe(1200 / 8); // Bars 3 and 4
		expect(view.left).toBe(8 * view.beat); // Bar 3 starts eight beats in
		expect(view.row).toBe(Math.floor(360 / 45)); // 38 to 82
		const middle = (127 - 60) * view.row + view.row / 2;
		expect(view.top).toBe(middle - 180);
	});

	it('fits an empty clip by its length, around middle C', () => {
		const view = fitRoll({ length: 2 * bar, notes: [] }, ppq, { width: 640, height: 500 });
		expect(view.beat).toBe(80);
		expect(view.left).toBe(0);
		expect(view.row).toBe(20); // C3 to C5
		expect(view.top).toBe((127 - 60) * 20 + 10 - 250);
	});

	it('keeps to the sizes a roll can be read at', () => {
		const long = fitRoll({ length: 400 * bar, notes: [note(0, 0), note(399 * bar, 127)] }, ppq, {
			width: 600,
			height: 300
		});
		expect(long.beat).toBe(BEAT.least);
		expect(long.row).toBe(ROWS.least);
		expect(long.top).toBe((127 - 63.5) * ROWS.least + ROWS.least / 2 - 150);
		const short = fitRoll({ length: ppq, notes: [note(0, 60, 10)] }, ppq, { width: 1200, height: 900 });
		expect(short.beat).toBe(1200 / 4); // A bar at least
		expect(fitRoll({ length: ppq, notes: [note(0, 60, 10)] }, ppq, { width: 6000, height: 900 }).beat).toBe(BEAT.most);
		expect(clampBeat(1e6)).toBe(BEAT.most);
		expect(clampRow(1.2)).toBe(ROWS.least);
	});
});

describe("each clip's zoom across a reload", () => {
	const song = zoomKey('timeline:1', 'lead-a');
	const pluck = zoomKey('timeline:1', 'pluck-a');

	it('keeps a zoom for each timeline and clip', () => {
		let text = keepZoom(null, song, { beat: 120.123, row: 16 });
		text = keepZoom(text, pluck, { beat: 40, row: 10 });
		expect(keptZoom(text, song)).toEqual({ beat: 120.12, row: 16 });
		expect(keptZoom(text, pluck)).toEqual({ beat: 40, row: 10 });
		expect(keptZoom(text, zoomKey('timeline:2', 'lead-a'))).toBeNull();
	});

	it('forgets the oldest past the most it keeps, and a zoom kept again is new again', () => {
		let text = keepZoom(null, 'a', { beat: 10, row: 10 }, 2);
		text = keepZoom(text, 'b', { beat: 20, row: 10 }, 2);
		text = keepZoom(text, 'a', { beat: 30, row: 10 }, 2);
		text = keepZoom(text, 'c', { beat: 40, row: 10 }, 2);
		expect(keptZoom(text, 'b')).toBeNull();
		expect(keptZoom(text, 'a')).toEqual({ beat: 30, row: 10 });
		expect(keptZoom(text, 'c')).toEqual({ beat: 40, row: 10 });
	});

	it('drops what it cannot read, and holds what it reads to the sizes a roll can be', () => {
		expect(keptZoom('not json', song)).toBeNull();
		expect(keptZoom('[1, 2]', song)).toBeNull();
		expect(keptZoom(JSON.stringify({ [song]: ['wide', 12] }), song)).toBeNull();
		expect(keptZoom(JSON.stringify({ [song]: [9999, 1] }), song)).toEqual({ beat: BEAT.most, row: ROWS.least });
		expect(keepZoom('not json', song, { beat: 50, row: 12 })).toBe(JSON.stringify({ [song]: [50, 12] }));
	});

	it("forgets a clip that has gone from its timeline, and only that timeline's", () => {
		const other = zoomKey('timeline:2', 'gone');
		let text = keepZoom(null, song, { beat: 120, row: 16 });
		text = keepZoom(text, pluck, { beat: 40, row: 10 });
		text = keepZoom(text, other, { beat: 60, row: 12 });
		const kept = dropGone(text, 'timeline:1', new Set(['lead-a']));
		expect(keptZoom(kept, song)).toEqual({ beat: 120, row: 16 });
		expect(keptZoom(kept, pluck)).toBeNull();
		expect(keptZoom(kept, other)).toEqual({ beat: 60, row: 12 });
		expect(dropGone(kept, 'timeline:1', new Set(['lead-a']))).toBeNull(); // Nothing more to drop
	});
});
