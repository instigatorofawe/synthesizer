import { Bars } from '#lib/TimeSignature.ts';
import { describe, expect, it } from 'vitest';
import {
	noteName,
	noteValue,
	barLength,
	barLengths,
	noteLengths,
	parseLength,
	parsePitch,
	readLength,
	readPitch,
	readPosition
} from '#lib/Units.ts';

const PPQ = 480;

describe('a pitch', () => {
	it('is typed as a name, with sharps or flats, or as a MIDI number', () => {
		expect(parsePitch('E4')).toBe(64);
		expect(parsePitch('c4')).toBe(60);
		expect(parsePitch('F#3')).toBe(54);
		expect(parsePitch('Bb2')).toBe(46);
		expect(parsePitch('D♭5')).toBe(73);
		expect(parsePitch('C♯ 4')).toBe(61);
		expect(parsePitch('B#3')).toBe(60);
		expect(parsePitch('Cb4')).toBe(59);
		expect(parsePitch('bb3')).toBe(58);
		expect(parsePitch(' 64 ')).toBe(64);
		expect(parsePitch('C-1')).toBe(0);
		expect(parsePitch('G9')).toBe(127);
	});

	it('reads back as the name it was written as, for every note', () => {
		for (let note = 0; note <= 127; ++note) expect(parsePitch(noteName(note))).toBe(note);
	});

	it('is nothing outside 0 to 127, or without a letter and an octave', () => {
		for (const text of ['', 'E', 'H4', '4E', 'G#9', 'Cb-1', '128', '-1', '6.5', 'E4 E5']) {
			expect(parsePitch(text), text).toBeNull();
		}
	});
});

describe('a length', () => {
	it('is typed as a note value, dotted or not, bars, ticks, or several of them added', () => {
		expect(parseLength('1/8', PPQ)).toBe(240);
		expect(parseLength('3/16', PPQ)).toBe(360);
		expect(parseLength('1/8.', PPQ)).toBe(360);
		expect(parseLength('1/4..', PPQ)).toBe(840);
		expect(parseLength('1 bar', PPQ)).toBe(1920);
		expect(parseLength('2 Bars', PPQ)).toBe(3840);
		expect(parseLength('1.5 bars', PPQ)).toBe(2880);
		expect(parseLength('1 bar + 1/4', PPQ)).toBe(2400);
		expect(parseLength('1 bar 1/4', PPQ)).toBe(2400);
		expect(parseLength('5/4', PPQ)).toBe(2400);
	});

	it('reads a triplet as three in the time of two', () => {
		expect(parseLength('1/8T', PPQ)).toBe(PPQ / 3);
		expect(parseLength('1/4t', PPQ)).toBe((PPQ * 2) / 3);
		expect(parseLength('1/16T', PPQ)).toBe(PPQ / 6);
		expect(parseLength('1 bar + 1/8T', PPQ)).toBe(PPQ * 4 + PPQ / 3);
	});

	it('is bars when it is a bare number, as the fields read, and ticks only when it says so', () => {
		expect(parseLength('8', PPQ)).toBe(8 * 1920);
		expect(parseLength('1.5', PPQ)).toBe(2880);
		expect(parseLength('.25', PPQ)).toBe(480);
		expect(parseLength('2 + 1/4', PPQ)).toBe(4320);
		expect(parseLength('240 ticks', PPQ)).toBe(240);
		expect(parseLength('1900 ticks', PPQ)).toBe(1900);
		expect(parseLength('7 ticks', PPQ)).toBe(7);
		expect(parseLength('1 tick', PPQ)).toBe(1);
	});

	it('reads back as it was written, as a note value or in bars', () => {
		for (const ticks of [
			1,
			7,
			30,
			80,
			160,
			240,
			320,
			360,
			400,
			480,
			640,
			1440,
			1900,
			1920,
			2400,
			3840,
			4800,
			1920 + 100
		]) {
			expect(parseLength(noteValue(ticks, PPQ), PPQ), noteValue(ticks, PPQ)).toBe(ticks);
			expect(parseLength(barLength(ticks, PPQ), PPQ), barLength(ticks, PPQ)).toBe(ticks);
		}
	});

	it('is nothing that is no whole number of ticks, or less than the least it can be', () => {
		for (const text of ['', 'x', '1/0', '1/7', '1/8 +', 'bar', '-240', '1/8x', '1/8tt', '0']) {
			expect(parseLength(text, PPQ), text).toBeNull();
		}
		expect(parseLength('0', PPQ, 0)).toBe(0); // A ramp of nothing is a step
		expect(parseLength('0.0001', PPQ)).toBeNull(); // Not a whole tick
		expect(parseLength('1/128', 96)).toBe(3);
		expect(parseLength('1/256', 96)).toBeNull();
	});

	it("reads in bars for a clip or a window, with what's left as a note value", () => {
		expect(barLength(1920, PPQ)).toBe('1 bar');
		expect(barLength(3840, PPQ)).toBe('2 bars');
		expect(barLength(2400, PPQ)).toBe('1 bar + 1/4');
		expect(barLength(4800, PPQ)).toBe('2 bars + 1/2');
		expect(barLength(2020, PPQ)).toBe('1 bar + 100 ticks');
		expect(barLength(960, PPQ)).toBe('1/2');
		expect(barLength(1000, PPQ)).toBe('1000 ticks');
	});

	it('is chosen from note values and bars that the ppq holds', () => {
		expect(noteLengths(PPQ)).toEqual([
			'1/32',
			'1/16T',
			'1/16',
			'1/8T',
			'1/8',
			'1/4T',
			'3/16',
			'1/4',
			'3/8',
			'1/2',
			'3/4',
			'1 bar',
			'2 bars'
		]);
		expect(noteLengths(2)).toEqual(['1/8', '1/4', '3/8', '1/2', '3/4', '1 bar', '2 bars']);
		expect(barLengths(PPQ)).toEqual(['1/4', '1/2', '1 bar', '2 bars', '3 bars', '4 bars', '8 bars', '16 bars']);
		for (const text of [...noteLengths(PPQ), ...barLengths(PPQ)]) expect(parseLength(text, PPQ), text).not.toBeNull();
	});
});

describe('a field', () => {
	it('takes a position as bar.beat.tick or a bar, as the top bar does, and says what to type otherwise', () => {
		const read = readPosition(Bars.of(PPQ));
		expect(read('2.3.120')).toBe(1920 + 960 + 120);
		expect(read('3')).toBe(3840);
		expect(read(Bars.of(PPQ).position(1234))).toBe(1234);
		expect(read('1.5')).toBe("“1.5” isn't a position. Type bar.beat.tick, as 3.2.000, or a bar.");
	});

	it("refuses a position past its clip's end, and says where the end is", () => {
		const read = readPosition(Bars.of(PPQ), 1920);
		expect(read('1.4.479')).toBe(1919);
		expect(read('2')).toBe("“2” is past the clip's end, at 2.1.000. Type a position before it.");
	});

	it('says what a pitch or a length is typed as', () => {
		expect(readPitch('E4')).toBe(64);
		expect(readPitch('H2')).toBe("“H2” isn't a pitch. Type a note, as E4, F#3 or Bb2, or a MIDI number from 0 to 127.");
		expect(readLength(PPQ)('1/8')).toBe(240);
		expect(readLength(PPQ)(' long ')).toBe(
			"“long” isn't a length. Type a note value, as 1/8 or 3/16, bars, as 2, or ticks, as 240 ticks."
		);
		expect(readLength(PPQ, 0)('0')).toBe(0);
	});
});
