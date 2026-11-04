import { describe, expect, it } from 'vitest';
import { timelineSchema } from '#lib/Schema.ts';
import {
	Bars,
	addMeter,
	barsOf,
	compound,
	meterText,
	metersOf,
	pulseTicks,
	removeMeter,
	setMeter,
	setPickup
} from '#lib/TimeSignature.ts';

const PPQ = 480;
const song = (extra: object = {}) => timelineSchema.parse({ ppq: PPQ, ...extra });

describe('bars in 4/4 from tick 0, as every song was', () => {
	const bars = barsOf(song());

	it('numbers bars from 1, each 4 beats long', () => {
		expect(bars.at(0)).toEqual({ number: 1, start: 0, end: 1920, meter: { beats: 4, unit: 4 }, beat: 480 });
		expect(bars.at(1919).number).toBe(1);
		expect(bars.at(1920)).toMatchObject({ number: 2, start: 1920, end: 3840 });
	});

	it('reads and parses positions as before', () => {
		expect(bars.position(0)).toBe('1.1.000');
		expect(bars.position(1440)).toBe('1.4.000');
		expect(bars.position(1920 + 480 + 120)).toBe('2.2.120');
		expect(bars.parse('2.2.120')).toBe(2520);
		expect(bars.parse('3')).toBe(3840);
		expect(bars.parse('1 4')).toBe(1440);
		expect(bars.parse('1.5')).toBeNull();
		expect(bars.parse('1.1.480')).toBeNull();
		expect(bars.parse('0')).toBeNull();
	});

	it('snaps to every multiple of a grid, as snapTick did', () => {
		for (const grid of [1, 120, 160, 240, 320, 480, 1920]) {
			for (const tick of [0, 59, 60, 61, 239, 240, 1000, 1919, 1921, 5000]) {
				expect(bars.snap(tick, grid), `${tick} on ${grid}`).toBe(Math.max(0, Math.round(tick / grid) * grid));
				expect(bars.floor(tick, grid)).toBe(Math.floor(tick / grid) * grid);
			}
		}
		expect(bars.snap(-50, 480)).toBe(0);
	});
});

describe('Für Elise: 3/8 after an eighth of pickup', () => {
	const bars = barsOf(song({ meter: [{ tick: 0, beats: 3, unit: 8 }], pickup: 240 }));

	it('makes the pickup bar 0, the end of a bar of 3/8, and starts bar 1 after it', () => {
		expect(bars.at(0)).toMatchObject({ number: 0, start: -480, end: 240, beat: 240 });
		expect(bars.at(240)).toMatchObject({ number: 1, start: 240, end: 960 });
		expect(bars.at(960).number).toBe(2);
		expect(bars.position(0)).toBe('0.3.000');
		expect(bars.position(120)).toBe('0.3.120');
		expect(bars.position(240)).toBe('1.1.000');
		expect(bars.position(240 + 480)).toBe('1.3.000');
	});

	it('parses what it reads, and nothing before the song starts', () => {
		expect(bars.parse('0.3')).toBe(0);
		expect(bars.parse('0.2')).toBeNull();
		expect(bars.parse('1')).toBe(240);
		expect(bars.parse('17.1')).toBe(240 + 16 * 720);
		expect(bars.parse('1.4')).toBeNull();
	});

	it('snaps to the bars and beats it has, never before 0', () => {
		expect(bars.snap(100, 1920)).toBe(0);
		expect(bars.snap(200, 1920)).toBe(240);
		expect(bars.snap(700, 1920)).toBe(960);
		expect(bars.snap(500, 480)).toBe(720);
		expect(bars.snap(800, 480)).toBe(720);
		expect(bars.snap(900, 480)).toBe(960);
		expect(bars.floor(239, 480)).toBe(0);
		expect(bars.whole(100, 300)).toEqual({ start: 0, end: 960 });
	});

	it('clicks a beat of eighths, the first of each bar accented', () => {
		expect(bars.clicks(0, 960)).toEqual([
			{ tick: 0, accent: false },
			{ tick: 240, accent: true },
			{ tick: 480, accent: false },
			{ tick: 720, accent: false }
		]);
	});
});

describe('a change of meter part way', () => {
	// Four bars of 4/4, then 3/4, then a change half way through a bar of 3/4 that cuts it short.
	const bars = barsOf(
		song({
			meter: [
				{ tick: 0, beats: 4, unit: 4 },
				{ tick: 4 * 1920, beats: 3, unit: 4 },
				{ tick: 4 * 1920 + 2 * 1440 + 480, beats: 6, unit: 8 }
			]
		})
	);
	const third = 4 * 1920 + 2 * 1440 + 480;

	it('starts a bar at each change and numbers on', () => {
		expect(bars.at(4 * 1920)).toMatchObject({ number: 5, end: 4 * 1920 + 1440, meter: { beats: 3, unit: 4 } });
		expect(bars.at(4 * 1920 + 2 * 1440)).toMatchObject({ number: 7, end: third });
		expect(bars.at(third)).toMatchObject({ number: 8, start: third, end: third + 1440, meter: { beats: 6, unit: 8 } });
		expect(bars.numbered(8)?.start).toBe(third);
		expect(bars.numbered(7)).toMatchObject({ start: 4 * 1920 + 2 * 1440, end: third });
		expect(bars.position(third - 1)).toBe('7.1.479');
		expect(bars.parse('7.2')).toBeNull();
		expect(bars.between(0, third + 1).map((bar) => bar.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it('snaps a bar grid to the short bar too', () => {
		expect(bars.snap(third - 100, 1920)).toBe(third);
		expect(bars.snap(4 * 1920 + 2 * 1440 + 100, 1920)).toBe(4 * 1920 + 2 * 1440);
		expect(bars.after(0, 6)).toBe(4 * 1920 + 2 * 1440);
		expect(bars.after(0, 7)).toBe(third);
	});

	it('clicks 6/8 in two, a dotted quarter a click', () => {
		expect(compound({ beats: 6, unit: 8 })).toBe(true);
		expect(compound({ beats: 3, unit: 8 })).toBe(false);
		expect(pulseTicks(PPQ, { beats: 6, unit: 8 })).toBe(720);
		expect(bars.clicks(third, third + 1440)).toEqual([
			{ tick: third, accent: true },
			{ tick: third + 720, accent: false }
		]);
	});
});

describe('a frame of a clip’s own ticks', () => {
	it('answers in the clip’s ticks, as the roll asks', () => {
		const songBars = barsOf(song({ meter: [{ tick: 0, beats: 3, unit: 4 }] }));
		const clip = songBars.shifted(1440 * 2);
		expect(clip.at(0)).toMatchObject({ number: 3, start: 0, end: 1440 });
		expect(clip.position(480)).toBe('3.2.000');
		expect(clip.snap(1000, 1920)).toBe(1440);
		const early = songBars.shifted(-480);
		expect(early.at(0)).toMatchObject({ number: 0, start: -960 });
		expect(early.at(480)).toMatchObject({ number: 1, start: 480 });
	});
});

describe('a song’s time signatures, edited', () => {
	it('says nothing for 4/4 from the start with no pickup', () => {
		const doc = song();
		expect(addMeter(doc, 0, { beats: 4, unit: 4 })).not.toHaveProperty('meter');
		const three = addMeter(doc, 0, { beats: 3, unit: 4 });
		expect(three.meter).toEqual([{ tick: 0, beats: 3, unit: 4 }]);
		expect(setMeter(three, 0, { beats: 4 })).not.toHaveProperty('meter');
	});

	it('adds, changes and removes changes after the first, which stays', () => {
		let doc = addMeter(song(), 3840, { beats: 6, unit: 8 });
		expect(metersOf(doc).map((change) => `${change.tick} ${meterText(change)}`)).toEqual(['0 4/4', '3840 6/8']);
		doc = setMeter(doc, 1, { unit: 16 });
		expect(doc.meter?.[1]).toEqual({ tick: 3840, beats: 6, unit: 16 });
		expect(removeMeter(doc, 0)).toBe(doc);
		expect(removeMeter(doc, 1)).not.toHaveProperty('meter');
	});

	it('keeps a pickup shorter than the first bar, and drops one that isn’t', () => {
		const doc = setPickup(song(), 480);
		expect(doc.pickup).toBe(480);
		expect(setPickup(doc, 0)).not.toHaveProperty('pickup');
		expect(setPickup(doc, 1920)).not.toHaveProperty('pickup');
		expect(setMeter(doc, 0, { beats: 3 }).pickup).toBe(480);
	});

	it('refuses a beat this ppq can’t hold in whole ticks', () => {
		const coarse = timelineSchema.parse({ ppq: 3 });
		expect(setMeter(coarse, 0, { unit: 8 })).toBe(coarse);
		expect(timelineSchema.safeParse({ ppq: 3, meter: [{ tick: 0, beats: 3, unit: 8 }] }).success).toBe(false);
		expect(
			timelineSchema.safeParse({
				meter: [
					{ tick: 0, beats: 3, unit: 4 },
					{ tick: 0, beats: 4, unit: 4 }
				]
			}).success
		).toBe(false);
		expect(Bars.of(3, [{ tick: 0, beats: 3, unit: 8 }]).meterAt(0)).toEqual({ beats: 4, unit: 4 });
	});
});

describe('a clip that counts its own bars', () => {
	it('numbers the bar its first tick is in 1, however far into the song it is', () => {
		const songBars = barsOf(song({ meter: [{ tick: 0, beats: 3, unit: 8 }], pickup: 240 }));
		const atStart = songBars.shifted(0, true);
		expect(atStart.position(0)).toBe('1.3.000');
		expect(atStart.position(240)).toBe('2.1.000');
		expect(atStart.parse('2')).toBe(240);
		const later = songBars.shifted(240 + 4 * 720, true);
		expect(later.position(0)).toBe('1.1.000');
		expect(later.at(720)).toMatchObject({ number: 2, start: 720, end: 1440 });
		expect(later.parse('2.2')).toBe(960);
		const plain = barsOf(song()).shifted(3 * 1920, true);
		expect(plain.position(1920 + 480)).toBe('2.2.000');
	});
});
