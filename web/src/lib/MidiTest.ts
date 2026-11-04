import { describe, expect, it } from 'vitest';
import { MidiError, readMidi } from '#lib/Midi.ts';
import {
	bend,
	cc,
	key,
	keyPressure,
	meta,
	meter,
	midiFile,
	name,
	off,
	on,
	pressure,
	program,
	running,
	sysex,
	tempo,
	track
} from '#lib/MidiWriter.ts';

const refusal = (bytes: Uint8Array) => {
	try {
		readMidi(bytes);
	} catch (error) {
		if (error instanceof MidiError) return error.message;
		throw error;
	}
	return null;
};

describe('reading a Standard MIDI File', () => {
	it('reads a format 0 file: its timing, and each event at its tick', () => {
		const file = readMidi(
			midiFile(0, 96, [
				track([
					name(0, 'Song'),
					tempo(0, 100),
					meter(0, 6, 8),
					key(0, -3, true),
					program(0, 2, 40),
					on(0, 2, 60, 90),
					cc(48, 2, 7, 80),
					pressure(50, 2, 30),
					bend(60, 2, -8192),
					bend(70, 2, 8191),
					keyPressure(80, 2, 60, 12),
					off(96, 2, 60)
				])
			])
		);
		expect(file.format).toBe(0);
		expect(file.timing).toEqual({ kind: 'ppq', ppq: 96 });
		expect(file.tracks).toHaveLength(1);
		expect(file.tracks[0].events).toEqual([
			{ tick: 0, kind: 'name', text: 'Song' },
			{ tick: 0, kind: 'tempo', perQuarter: 600000 },
			{ tick: 0, kind: 'meter', beats: 6, unit: 8 },
			{ tick: 0, kind: 'key', fifths: -3, minor: true },
			{ tick: 0, kind: 'program', channel: 2, program: 40 },
			{ tick: 0, kind: 'on', channel: 2, key: 60, velocity: 90 },
			{ tick: 48, kind: 'controller', channel: 2, controller: 7, value: 80 },
			{ tick: 50, kind: 'pressure', channel: 2, value: 30 },
			{ tick: 60, kind: 'bend', channel: 2, value: -8192 },
			{ tick: 70, kind: 'bend', channel: 2, value: 8191 },
			{ tick: 80, kind: 'keyPressure', channel: 2, key: 60, value: 12 },
			{ tick: 96, kind: 'off', channel: 2, key: 60, velocity: 64 }
		]);
		expect(file.tracks[0].end).toBe(96);
	});

	it('reads every track of a format 1 file, each from its own tick 0', () => {
		const file = readMidi(
			midiFile(1, 480, [
				track([tempo(0, 120), tempo(960, 60)]),
				track([on(0, 0, 60), off(480, 0, 60)]),
				track([on(240, 1, 64), off(720, 1, 64)])
			])
		);
		expect(file.format).toBe(1);
		expect(file.tracks.map((t) => t.events.map((e) => [e.tick, e.kind]))).toEqual([
			[
				[0, 'tempo'],
				[960, 'tempo']
			],
			[
				[0, 'on'],
				[480, 'off']
			],
			[
				[240, 'on'],
				[720, 'off']
			]
		]);
	});

	it('refuses format 2, saying why, and anything that is not a MIDI file', () => {
		expect(refusal(midiFile(2, 480, [track([on(0, 0, 60)]), track([on(0, 0, 62)])]))).toMatch(
			/format 2 file, whose tracks are separate sequences/
		);
		expect(refusal(midiFile(3, 480, [track([])]))).toMatch(/format 3/);
		expect(refusal(new TextEncoder().encode('RIFF....WAVEfmt '))).toMatch(/isn't a Standard MIDI File/);
		expect(refusal(new Uint8Array())).toMatch(/isn't a Standard MIDI File/);
		expect(refusal(midiFile(0, 0, [track([])]))).toMatch(/0 ticks/);
		expect(refusal(midiFile(1, 480, []))).toMatch(/no tracks/);
	});

	it('runs a message on from the status before it, across meta events and system exclusive', () => {
		const file = readMidi(
			midiFile(0, 480, [
				track([
					on(0, 3, 60, 100),
					running(0, 64, 101), // Another note-on on channel 4
					running(240, 60, 0), // A note-on at velocity 0, which is a note-off
					meta(240, 0x01, [0x41]), // A text event between doesn't stop the status running
					sysex(240, [0x7e, 0x7f, 0x09, 0x01, 0xf7]),
					running(480, 64, 0)
				])
			])
		);
		expect(file.tracks[0].events).toEqual([
			{ tick: 0, kind: 'on', channel: 3, key: 60, velocity: 100 },
			{ tick: 0, kind: 'on', channel: 3, key: 64, velocity: 101 },
			{ tick: 240, kind: 'off', channel: 3, key: 60, velocity: 0 },
			{ tick: 480, kind: 'off', channel: 3, key: 64, velocity: 0 }
		]);
		expect(file.skipped).toEqual({ sysex: 1, metas: 1 });
	});

	it('refuses data with no status to run on from, and a message cut short', () => {
		expect(refusal(midiFile(0, 480, [track([running(0, 60, 100)])]))).toMatch(/no status/);
		expect(refusal(midiFile(0, 480, [track([{ tick: 0, bytes: [0x90, 60] }], null)]))).toMatch(
			/ends in the middle of an event in track 1/
		);
		expect(refusal(midiFile(0, 480, [track([{ tick: 0, bytes: [0x90, 60, 0x90, 62, 100] }])]))).toMatch(
			/cut short by another/
		);
		expect(refusal(midiFile(0, 480, [track([{ tick: 0, bytes: [0xf8] }])]))).toMatch(/f8, which no file holds/);
	});

	it('skips system exclusive and the meta events a song has no place for, and counts them', () => {
		const file = readMidi(
			midiFile(0, 480, [
				track([
					sysex(0, [0x41, 0x10, 0x42, 0x12, 0xf7]),
					{ tick: 0, bytes: [0xf7, 2, 0x01, 0x02] }, // An escape, which carries bytes as they are
					meta(0, 0x02, [0x43]), // Copyright
					meta(0, 0x06, [0x41]), // A marker
					meta(0, 0x7f, [0x00, 0x00, 0x41]), // A sequencer's own
					meta(0, 0x21, [0x00]), // A port
					on(0, 0, 60),
					off(10, 0, 60)
				])
			])
		);
		expect(file.skipped).toEqual({ sysex: 2, metas: 4 });
		expect(file.tracks[0].events.map((e) => e.kind)).toEqual(['on', 'off']);
	});

	it('stops a track at its End of Track, and ends one without one at its last event', () => {
		const ended = track([on(0, 0, 60), off(100, 0, 60)], 400);
		const after = [0x00, 0x90, 62, 100]; // Bytes past the End of Track, which are no part of the track
		const chunk = [...ended.slice(0, 4), 0, 0, 0, ended.length - 8 + after.length, ...ended.slice(8), ...after];
		const file = readMidi(midiFile(1, 480, [chunk, track([on(0, 0, 64), off(50, 0, 64)], null)]));
		expect(file.tracks[0].events).toHaveLength(2);
		expect(file.tracks[0].end).toBe(400);
		expect(file.tracks[1].end).toBe(50);
	});

	it('names a track in UTF-8, or in Latin-1 when its bytes are not UTF-8', () => {
		const file = readMidi(
			midiFile(1, 480, [track([name(0, ' Flûte ')]), track([meta(0, 0x03, [0x46, 0x6c, 0xfb, 0x74, 0x65])])])
		);
		expect(file.tracks.map((t) => t.events[0])).toEqual([
			{ tick: 0, kind: 'name', text: 'Flûte' },
			{ tick: 0, kind: 'name', text: 'Flûte' }
		]);
	});

	it('reads SMPTE timing as frames a second and ticks a frame', () => {
		const smpte = (fps: number, perFrame: number) => ((256 - fps) << 8) | perFrame;
		expect(readMidi(midiFile(0, smpte(25, 40), [track([])])).timing).toEqual({
			kind: 'smpte',
			fps: 25,
			perFrame: 40
		});
		expect(readMidi(midiFile(0, smpte(29, 80), [track([])])).timing).toEqual({
			kind: 'smpte',
			fps: 29.97,
			perFrame: 80
		});
		expect(refusal(midiFile(0, smpte(26, 40), [track([])]))).toMatch(/SMPTE timing/);
	});

	it('passes over chunks of other types, reads a chunk cut short as far as it goes, and opens an RMID file', () => {
		const alien = [...new TextEncoder().encode('XFIH'), 0, 0, 0, 3, 1, 2, 3];
		const notes = track([on(0, 0, 60), off(10, 0, 60)]);
		const file = readMidi(midiFile(1, 480, [alien, notes]));
		expect(file.tracks).toHaveLength(1);

		const long = [...notes.slice(0, 4), 0, 0, 0x10, 0, ...notes.slice(8)]; // Says it is 4096 bytes long
		expect(readMidi(midiFile(1, 480, [long])).tracks[0].events).toHaveLength(2);

		const smf = midiFile(0, 480, [notes]);
		const le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
		const ascii = (text: string) => [...new TextEncoder().encode(text)];
		const rmid = new Uint8Array([
			...ascii('RIFF'),
			...le(4 + 8 + smf.length),
			...ascii('RMID'),
			...ascii('data'),
			...le(smf.length),
			...smf
		]);
		expect(readMidi(rmid).tracks[0].events).toHaveLength(2);
	});
});
