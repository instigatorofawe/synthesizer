// The standard set's General MIDI tables, as examples/MakeInstruments.py writes them: which built-in patch plays each GM
// program and percussion key, the four parameters every instrument of the set takes, the keys that stop one another, and
// the effects a file's reverb and chorus sends reach. MIDI import plays a file through these, and a drum track takes its
// kit from them.
import table from '../../../examples/Instruments/GeneralMidi.json';

export interface GmProgram {
	program: number; // As a file sends it, 0 to 127
	name: string; // GM's name for it
	family: string;
	instrument: string | null; // The set's instrument that plays it, or null while the set has none
}

export interface GmDrum {
	note: number;
	name: string;
	instrument: string | null;
}

export interface GeneralMidi {
	prefix: string; // A set's patch is the built-in patch with this before its name
	params: { bend: number; wheel: number; expression: number; pressure: number };
	programs: GmProgram[];
	drums: GmDrum[];
	chokes: Record<string, number[]>;
	effects: { reverb: string | null; chorus: string | null };
}

export const GM: GeneralMidi = table;

// The percussion channel, counted from 0 as a file's bytes count it (GM calls it channel 10).
export const DRUM_CHANNEL = 9;

export const setPatch = (instrument: string) => `${GM.prefix}${instrument}`;

// The built-in patch that plays a program, or null.
export function programPatch(program: number): string | null {
	const instrument = GM.programs[program]?.instrument;
	return instrument ? setPatch(instrument) : null;
}

// The built-in patch that plays a percussion key, or null for a key GM gives no sound or the set has none for yet.
export function drumPatch(note: number): string | null {
	const instrument = GM.drums.find((drum) => drum.note === note)?.instrument;
	return instrument ? setPatch(instrument) : null;
}

export interface KitKey {
	note: number;
	name: string;
	slot: number;
}

// The standard kit as a drum track holds it: its slots, a patch for each sound, and every key that has one, with GM's name
// for the key and the slot it plays. `keys` limits it to those, so a file's kit holds only the sounds it plays.
export function standardKit(keys?: Iterable<number>): { slots: string[]; kit: KitKey[] } {
	const wanted = keys ? new Set(keys) : null;
	const slots: string[] = [];
	const kit: KitKey[] = [];
	for (const drum of GM.drums) {
		if (!drum.instrument || (wanted && !wanted.has(drum.note))) continue;
		const patch = setPatch(drum.instrument);
		let slot = slots.indexOf(patch);
		if (slot < 0) slot = slots.push(patch) - 1;
		kit.push({ note: drum.note, name: drum.name, slot });
	}
	return { slots, kit };
}
