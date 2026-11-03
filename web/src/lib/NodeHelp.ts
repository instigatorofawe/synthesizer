// What the graph editor says about each node type: a name a person would look for, a group, a line on what it does, other
// words for it, and each input's unit and range. The compiler's catalog says only names and defaults, and changing it would
// be a compiler change for nothing an image holds, so this table lives here and NodeHelpTest holds it to the catalog.
//
// Every range is one docs/Format.md or docs/Design.md gives, as the clamp a kernel applies. An input whose range isn't written
// down has none here, rather than a guess.

export const GROUPS = [
	'Notes and values',
	'Sources',
	'Filters',
	'Modulation',
	'Delay and stereo',
	'Math',
	'Patch ports'
] as const;

export type Group = (typeof GROUPS)[number];

// A bound is a number in the input's unit, or words for one that depends on something else, such as the sample rate.
export interface InputHelp {
	unit?: string;
	min?: number;
	max?: number | string;
}

export interface NodeHelp {
	name: string;
	group: Group;
	description: string;
	synonyms: string[];
	inputs: Record<string, InputHelp>;
}

const SECONDS = { unit: 's', min: 0.0001, max: 60 }; // Env and Follow clamp their times to this
const NOTE = { unit: 'MIDI note', min: -48, max: 200 }; // KMtoF, KRatio and Sample2 clamp a note to this
const LINE = { unit: 's', max: 'its max' }; // A delay line holds what its max declares, section 5 of Design.md

export const NODE_HELP: Record<string, NodeHelp> = {
	note: {
		name: 'Note',
		group: 'Notes and values',
		description: 'The note that started this voice: its pitch, velocity and gate.',
		synonyms: ['midi', 'key', 'keyboard', 'pitch', 'velocity', 'gate', 'trigger'],
		inputs: {}
	},
	param: {
		name: 'Parameter',
		group: 'Notes and values',
		description: "A value from the patch's parameters, which a timeline's lanes and controls change.",
		synonyms: ['knob', 'control', 'macro', 'automation', 'slider'],
		inputs: {}
	},
	const: {
		name: 'Constant',
		group: 'Notes and values',
		description: 'A fixed number.',
		synonyms: ['number', 'value', 'fixed'],
		inputs: {}
	},
	osc: {
		name: 'Oscillator',
		group: 'Sources',
		description: 'A sine, saw, square or triangle wave. At a few Hz it is an LFO that runs at audio rate.',
		synonyms: [
			'vco',
			'lfo',
			'wave',
			'sine',
			'saw',
			'sawtooth',
			'square',
			'pulse',
			'pwm',
			'triangle',
			'tone',
			'fm',
			'sync'
		],
		inputs: {
			freq: { unit: 'Hz', max: 'half the sample rate' },
			width: { min: 0, max: 1 },
			phase: { unit: 'turns', min: -64, max: 64 },
			sync: {},
			feedback: { min: -1, max: 1 }
		}
	},
	noise: {
		name: 'Noise',
		group: 'Sources',
		description: 'White noise, the same each time a note plays.',
		synonyms: ['white noise', 'hiss', 'random'],
		inputs: {}
	},
	sample: {
		name: 'Sampler',
		group: 'Sources',
		description: 'Plays a recording, or one of a set chosen by the note and velocity.',
		synonyms: ['sample', 'recording', 'wav', 'audio file', 'playback', 'zones', 'multisample'],
		inputs: {
			ratio: { unit: '×', min: 0, max: 256 },
			note: NOTE,
			start: { min: 0, max: 1 }
		}
	},
	biquad: {
		name: 'Filter',
		group: 'Filters',
		description: 'A low-pass, high-pass or band-pass filter with resonance.',
		synonyms: [
			'lowpass',
			'low-pass',
			'highpass',
			'high-pass',
			'bandpass',
			'band-pass',
			'lpf',
			'hpf',
			'vcf',
			'eq',
			'resonance'
		],
		inputs: {
			in: {},
			cutoff: { unit: 'Hz', min: 10, max: '0.45 × sample rate' },
			q: { min: 0.1, max: 30 }
		}
	},
	comb: {
		name: 'Comb filter',
		group: 'Filters',
		description: 'A delay with damped feedback: a resonator for plucked strings and reverbs.',
		synonyms: ['resonator', 'karplus-strong', 'plucked string', 'reverb', 'freeverb'],
		inputs: {
			in: {},
			time: LINE,
			feedback: { min: -0.995, max: 0.995 },
			damp: { min: 0, max: 0.99 }
		}
	},
	allpass: {
		name: 'All-pass filter',
		group: 'Filters',
		description: 'Smears a signal in time without changing its level, for phasers and reverbs.',
		synonyms: ['all-pass', 'diffusion', 'phaser', 'reverb', 'schroeder'],
		inputs: {
			in: {},
			time: LINE,
			feedback: { min: -0.995, max: 0.995 }
		}
	},
	env: {
		name: 'Envelope',
		group: 'Modulation',
		description: "Attack, decay, sustain and release, following the note's gate.",
		synonyms: ['adsr', 'eg', 'contour', 'amp envelope'],
		inputs: {
			attack: SECONDS,
			decay: SECONDS,
			sustain: { min: 0, max: 1 },
			release: SECONDS
		}
	},
	lfo: {
		name: 'LFO',
		group: 'Modulation',
		description: 'A slow sine, read once a frame, for vibrato, tremolo and sweeps.',
		synonyms: ['low frequency oscillator', 'low-frequency oscillator', 'vibrato', 'tremolo', 'wobble', 'sweep'],
		inputs: {
			rate: { unit: 'Hz', min: 0, max: 1000 },
			depth: {}
		}
	},
	follow: {
		name: 'Follower',
		group: 'Modulation',
		description: 'Follows the peak level of a signal, for ducking and auto-wah.',
		synonyms: ['envelope follower', 'peak', 'level', 'detector', 'sidechain', 'ducking', 'compressor'],
		inputs: {
			in: {},
			release: SECONDS
		}
	},
	snap: {
		name: 'Snap',
		group: 'Modulation',
		description: 'Reads audio once a frame, so that it can drive an input read once a frame.',
		synonyms: ['control rate', 'k-rate', 'audio to control', 'downsample'],
		inputs: { in: {} }
	},
	delay: {
		name: 'Delay',
		group: 'Delay and stereo',
		description: 'Plays its input back later, up to its max. With feedback it echoes.',
		synonyms: ['echo', 'delay line', 'haas', 'flanger', 'chorus', 'slapback'],
		inputs: {
			in: {},
			time: LINE
		}
	},
	pan: {
		name: 'Pan',
		group: 'Delay and stereo',
		description: 'Places a mono signal between left and right.',
		synonyms: ['stereo', 'panner', 'balance', 'position', 'spread'],
		inputs: {
			in: {},
			position: { min: -1, max: 1 }
		}
	},
	add: {
		name: 'Add',
		group: 'Math',
		description: 'a plus b: mixes two signals, or offsets one.',
		synonyms: ['mix', 'mixer', 'sum', 'plus', 'offset', 'bias'],
		inputs: { a: {}, b: {} }
	},
	mul: {
		name: 'Multiply',
		group: 'Math',
		description: 'a times b: a level, an amplifier, or ring modulation.',
		synonyms: ['vca', 'amp', 'amplifier', 'gain', 'volume', 'level', 'times', 'ring modulation'],
		inputs: { a: {}, b: {} }
	},
	math: {
		name: 'Math',
		group: 'Math',
		description: 'Min, max, abs, clip, floor, divide, compare or select.',
		synonyms: [
			'min',
			'max',
			'abs',
			'clip',
			'clamp',
			'floor',
			'divide',
			'compare',
			'select',
			'if',
			'threshold',
			'quantize'
		],
		inputs: { a: {}, b: {}, c: {} }
	},
	mtof: {
		name: 'Note to Hz',
		group: 'Math',
		description: 'Turns a MIDI note number into a frequency.',
		synonyms: ['frequency', 'pitch', 'hz', 'midi to frequency', 'tuning', 'keyboard tracking'],
		inputs: { in: NOTE }
	},
	ratio: {
		name: 'Note to ratio',
		group: 'Math',
		description: 'Turns a note into how fast to play a recording, from its root key.',
		synonyms: ['transpose', 'pitch ratio', 'playback rate', 'semitones'],
		inputs: { in: NOTE }
	},
	shape: {
		name: 'Waveshaper',
		group: 'Math',
		description: 'Bends a signal through a curve, for saturation and wavefolding.',
		synonyms: ['distortion', 'saturation', 'drive', 'overdrive', 'fold', 'curve', 'chebyshev'],
		inputs: { in: { min: -1, max: 1 } }
	},
	in: {
		name: 'Audio in',
		group: 'Patch ports',
		description: 'What an insert is given to process, left and right.',
		synonyms: ['input', 'insert', 'effect input', 'stereo in'],
		inputs: {}
	},
	out: {
		name: 'Output',
		group: 'Patch ports',
		description: "Where the patch's sound leaves, left and right.",
		synonyms: ['speaker', 'master', 'stereo out', 'audio out'],
		inputs: { l: {}, r: {} }
	},
	inlet: {
		name: 'Inlet',
		group: 'Patch ports',
		description: 'An input this patch takes when another uses it as a subpatch.',
		synonyms: ['subpatch input', 'port', 'input'],
		inputs: {}
	},
	outlet: {
		name: 'Outlet',
		group: 'Patch ports',
		description: 'An output this patch gives when another uses it as a subpatch.',
		synonyms: ['subpatch output', 'port', 'output'],
		inputs: { in: {} }
	},
	subpatch: {
		name: 'Subpatch',
		group: 'Patch ports',
		description: 'Another patch from the library, used here as one node.',
		synonyms: ['module', 'macro', 'group', 'nested', 'abstraction', 'reuse'],
		inputs: {}
	}
};

export const helpOf = (type: string): NodeHelp | undefined => NODE_HELP[type];

export const friendlyName = (type: string) => NODE_HELP[type]?.name ?? type;

// A number as the inspector shows it. The catalog's defaults are single-precision floats printed as doubles, so 0.01 arrives as
// 0.009999999776482582, and six significant digits is more than any field here means.
export const shown = (value: number) => String(Number(value.toPrecision(6)));

// An input's range in words, without its unit, which the inspector shows beside the input's name.
export function rangeText(help: InputHelp | undefined): string {
	const bound = (value: number | string) => (typeof value === 'number' ? shown(value) : value);
	if (help?.min !== undefined && help.max !== undefined) return `${bound(help.min)} to ${bound(help.max)}`;
	if (help?.max !== undefined) return `up to ${bound(help.max)}`;
	if (help?.min !== undefined) return `from ${bound(help.min)}`;
	return '';
}

export interface Match {
	type: string;
	help: NodeHelp;
	score: number; // Lower is closer
}

const words = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

// How closely one word of a query matches a node: its name or compiler name, then another word for it, then its description.
function scoreWord(word: string, type: string, help: NodeHelp): number | null {
	const name = words(help.name);
	if (name === word || type === word) return 0;
	if (name.startsWith(word) || type.startsWith(word)) return 1;
	if (name.split(' ').some((part) => part.startsWith(word))) return 2;
	const synonyms = help.synonyms.map(words);
	if (synonyms.includes(word)) return 3;
	if (synonyms.some((synonym) => synonym.split(' ').some((part) => part.startsWith(word)))) return 4;
	if (words(help.description).includes(word)) return 5;
	return null;
}

function score(query: string, type: string, help: NodeHelp): number | null {
	const whole = words(query);
	if (!whole) return 0;
	if (words(help.name) === whole) return 0;
	if (help.synonyms.some((synonym) => words(synonym) === whole)) return 3;
	let worst = 0;
	for (const word of whole.split(' ')) {
		const found = scoreWord(word, type, help);
		if (found === null) return null;
		worst = Math.max(worst, found);
	}
	return worst;
}

// The node types a search finds, under their groups. The group with the closest match comes first, so the first option is the
// best one. Within a group the closest come first, and then this table's order, which runs roughly as a signal does.
export function searchNodes(query: string, types: string[]): { group: Group; matches: Match[] }[] {
	const order = Object.keys(NODE_HELP);
	const found: Match[] = [];
	for (const type of types) {
		const help = NODE_HELP[type];
		if (!help) continue;
		const s = score(query, type, help);
		if (s !== null) found.push({ type, help, score: s });
	}
	found.sort((a, b) => a.score - b.score || order.indexOf(a.type) - order.indexOf(b.type));
	const groups: { group: Group; matches: Match[] }[] = [];
	for (const match of found) {
		const group = groups.find((candidate) => candidate.group === match.help.group);
		if (group) group.matches.push(match);
		else groups.push({ group: match.help.group, matches: [match] });
	}
	if (!words(query)) groups.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
	for (const group of groups)
		group.matches.sort((a, b) => a.score - b.score || order.indexOf(a.type) - order.indexOf(b.type));
	return groups;
}
