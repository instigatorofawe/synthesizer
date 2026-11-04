// Standard MIDI Files, read into each track's events at the file's own ticks, for MidiImport.ts to make a timeline of. Format 0
// (one track) and format 1 (tracks that play together) are read. Format 2, whose tracks are separate sequences played one
// after another, is refused: a song plays its tracks at once, so nothing could be made of it that the file meant.
//
// What a timeline has no place for is read past rather than refused: system exclusive messages, which talk to one maker's
// synthesizer, and every meta event but the five a timeline uses (tempo, time signature, key signature, track name and end of
// track). The file says how many it skipped, for the import to report. A file that isn't MIDI, or whose bytes stop making
// sense part way, is refused with what was wrong and where, since a guess at the rest would play something the file never said.

export class MidiError extends Error {}

// What a tick is: a fraction of a quarter note, which the tempo says the length of, or a fraction of a frame of SMPTE time
// code, which is a fixed length of time whatever the tempo says. 29.97 is the drop-frame rate NTSC video runs at.
export type Timing = { kind: 'ppq'; ppq: number } | { kind: 'smpte'; fps: 24 | 25 | 29.97 | 30; perFrame: number };

export type MidiEvent = { tick: number } & (
	| { kind: 'on'; channel: number; key: number; velocity: number } // Velocity 1 to 127
	| { kind: 'off'; channel: number; key: number; velocity: number } // Velocity 0 for a note-on at velocity 0
	| { kind: 'keyPressure'; channel: number; key: number; value: number }
	| { kind: 'controller'; channel: number; controller: number; value: number }
	| { kind: 'program'; channel: number; program: number }
	| { kind: 'pressure'; channel: number; value: number }
	| { kind: 'bend'; channel: number; value: number } // -8192 to 8191, 0 at rest
	| { kind: 'tempo'; perQuarter: number } // Microseconds a quarter note lasts
	| { kind: 'meter'; beats: number; unit: number } // The signature's figures: `unit` is 4 for a quarter, 8 for an eighth
	| { kind: 'key'; fifths: number; minor: boolean } // Sharps above 0 and flats below, as a key signature's count
	| { kind: 'name'; text: string }
);

export interface MidiTrack {
	events: MidiEvent[]; // In the file's order, which is the order of their ticks
	end: number; // Where its End of Track is, or its last event if it has none
}

export interface MidiFile {
	format: 0 | 1;
	timing: Timing;
	tracks: MidiTrack[];
	skipped: { sysex: number; metas: number }; // What was read past
}

const SMPTE_RATES: Record<number, 24 | 25 | 29.97 | 30> = { 24: 24, 25: 25, 29: 29.97, 30: 30 };

// A track name is meant to be ASCII, and is often in whatever the writer's system used. UTF-8 is tried first, since it fails
// loudly on bytes it doesn't hold, and anything else is read as Latin-1, which takes every byte.
function text(bytes: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
	} catch {
		return String.fromCharCode(...bytes).trim();
	}
}

const ascii = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));

// A RIFF file of type RMID wraps a Standard MIDI File in its `data` chunk, as Windows once saved them.
function unwrapped(bytes: Uint8Array): Uint8Array {
	if (bytes.length < 12 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'RMID') return bytes;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let at = 12; at + 8 <= bytes.length;) {
		const size = view.getUint32(at + 4, true);
		if (ascii(bytes, at) === 'data') return bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
		at += 8 + size + (size & 1);
	}
	throw new MidiError('It is an RMID file with no MIDI data in it.');
}

function header(bytes: Uint8Array): { format: number; timing: Timing; length: number } {
	if (bytes.length < 14 || ascii(bytes, 0) !== 'MThd')
		throw new MidiError("It isn't a Standard MIDI File: those start with MThd.");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const length = view.getUint32(4);
	if (length < 6) throw new MidiError('Its header is too short to say what the file holds.');
	const format = view.getUint16(8);
	const division = view.getUint16(12);
	let timing: Timing;
	if (division & 0x8000) {
		// The high byte is the frame rate, negated, and the low byte the ticks in a frame.
		const fps = SMPTE_RATES[256 - (division >> 8)];
		const perFrame = division & 0xff;
		if (!fps || !perFrame)
			throw new MidiError(`Its SMPTE timing, ${division.toString(16)}, isn't one the standard has.`);
		timing = { kind: 'smpte', fps, perFrame };
	} else {
		if (!division) throw new MidiError('It says a quarter note is 0 ticks long.');
		timing = { kind: 'ppq', ppq: division };
	}
	return { format, timing, length };
}

// One track's events, from its chunk's bytes.
function track(bytes: Uint8Array, index: number, skipped: MidiFile['skipped']): MidiTrack {
	const events: MidiEvent[] = [];
	const where = `track ${index}`;
	let at = 0;
	let tick = 0;
	let status = 0; // The last channel message's, which a message that leaves its own out runs on with
	const byte = () => {
		if (at >= bytes.length) throw new MidiError(`It ends in the middle of an event in ${where}.`);
		return bytes[at++];
	};
	const data = () => {
		const value = byte();
		if (value & 0x80)
			throw new MidiError(`In ${where}, a message is cut short by another at tick ${tick}, which no file should do.`);
		return value;
	};
	// A variable-length quantity: a number in as many bytes as it needs, seven bits in each, every byte but the last with its
	// top bit set. The standard allows four.
	const quantity = () => {
		let value = 0;
		for (let i = 0; i < 4; ++i) {
			const next = byte();
			value = value * 128 + (next & 0x7f);
			if (!(next & 0x80)) return value;
		}
		throw new MidiError(`In ${where}, a length or a time runs past the four bytes the standard allows.`);
	};
	const take = (length: number) => {
		if (at + length > bytes.length) throw new MidiError(`It ends in the middle of an event in ${where}.`);
		at += length;
		return bytes.subarray(at - length, at);
	};

	while (at < bytes.length) {
		tick += quantity();
		const first = byte();
		if (first === 0xff) {
			const type = byte();
			const body = take(quantity());
			if (type === 0x2f) return { events, end: tick };
			if (type === 0x51 && body.length >= 3) {
				const perQuarter = (body[0] << 16) | (body[1] << 8) | body[2];
				if (perQuarter > 0) events.push({ tick, kind: 'tempo', perQuarter });
			} else if (type === 0x58 && body.length >= 2) {
				// The lower figure is a power of two; one past 2^30 is no signature anything writes.
				if (body[1] <= 30) events.push({ tick, kind: 'meter', beats: body[0], unit: 2 ** body[1] });
			} else if (type === 0x59 && body.length >= 2) {
				events.push({ tick, kind: 'key', fifths: (body[0] << 24) >> 24, minor: body[1] === 1 });
			} else if (type === 0x03) {
				events.push({ tick, kind: 'name', text: text(body) });
			} else skipped.metas += 1;
			continue;
		}
		if (first === 0xf0 || first === 0xf7) {
			take(quantity());
			skipped.sysex += 1;
			continue;
		}
		if (first > 0xf0)
			throw new MidiError(`In ${where}, at tick ${tick}, there is a ${first.toString(16)}, which no file holds.`);
		if (first & 0x80) status = first;
		else if (status) at -= 1;
		else
			throw new MidiError(
				`In ${where}, a message at tick ${tick} has no status, and nothing before it to run on from.`
			);

		const channel = status & 0x0f;
		switch (status >> 4) {
			case 0x8:
				events.push({ tick, kind: 'off', channel, key: data(), velocity: data() });
				break;
			case 0x9: {
				const key = data();
				const velocity = data();
				events.push({ tick, kind: velocity ? 'on' : 'off', channel, key, velocity });
				break;
			}
			case 0xa:
				events.push({ tick, kind: 'keyPressure', channel, key: data(), value: data() });
				break;
			case 0xb:
				events.push({ tick, kind: 'controller', channel, controller: data(), value: data() });
				break;
			case 0xc:
				events.push({ tick, kind: 'program', channel, program: data() });
				break;
			case 0xd:
				events.push({ tick, kind: 'pressure', channel, value: data() });
				break;
			default: {
				const low = data();
				events.push({ tick, kind: 'bend', channel, value: ((data() << 7) | low) - 8192 });
			}
		}
	}
	return { events, end: tick };
}

export function readMidi(file: Uint8Array): MidiFile {
	const bytes = unwrapped(file);
	const head = header(bytes);
	if (head.format === 2)
		throw new MidiError(
			'It is a format 2 file, whose tracks are separate sequences played one after another, and a song plays its tracks at once. Formats 0 and 1 can be imported.'
		);
	if (head.format !== 0 && head.format !== 1)
		throw new MidiError(`It says it is format ${head.format}, which the standard doesn't have.`);

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const skipped = { sysex: 0, metas: 0 };
	const tracks: MidiTrack[] = [];
	// Chunks of other types are the standard's way of letting a file carry more, and are passed over. A chunk that says it is
	// longer than the file was cut short in copying, and is read as far as it goes.
	for (let at = 8 + head.length; at + 8 <= bytes.length;) {
		const length = view.getUint32(at + 4);
		const end = Math.min(bytes.length, at + 8 + length);
		if (ascii(bytes, at) === 'MTrk') tracks.push(track(bytes.subarray(at + 8, end), tracks.length + 1, skipped));
		at = end;
	}
	if (!tracks.length) throw new MidiError('It has no tracks.');
	return { format: head.format as 0 | 1, timing: head.timing, tracks, skipped };
}
