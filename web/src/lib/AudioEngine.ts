// The main thread's handle on the worklet.
import { pulseTicks, type Bars } from '#lib/TimeSignature.ts';
import { LiveReports } from '#lib/LiveReports.ts';
import type { CompileReport, NodesReport, ProgramReport } from '#lib/Request.ts';

// Matches EventKind in Synth.hpp.
const EventKind = {
	NoteOn: 0,
	NoteOff: 1,
	SetParam: 2,
	SetInsertParam: 3,
	SetMix: 4,
	SetTap: 5,
	Play: 6,
	Stop: 7,
	Locate: 8,
	SetLoop: 9,
	SetProbe: 10
} as const;

const TAP_SLOTS = 8;
const NO_TARGET = 0xffff; // Out of range for any step, so the engine turns the slot off

export interface EngineState {
	tick: number;
	playing: boolean;
	voices: number;
	generation: number;
	liveId: number;
	error: number;
	loading: boolean;
	guardTrips: number;
	limited: number; // The lowest gain the limiter used since the last state, or 1 if it turned nothing down
	time: number; // Seconds of audio rendered since audio started, however long that took
	recording: number; // 0 with no take, 1 while a bar is counted in, 2 while a take runs
	countIn: number; // The beats of the count-in still to come
	clicks: number; // Clicks the worklet has begun since audio started
}

// A key the worklet stamped while a take ran: where the song was when it was heard going down or up (Recording.ts).
export interface PlayedKey {
	on: boolean;
	note: number;
	tick: number;
	elapsed: number;
}

export interface TapBlock {
	samples: Float32Array;
	start: number;
	dropped: number;
	generation: number;
}

export interface TapTarget {
	slot: number;
	label: string;
	step: number;
	bus: number;
	channel: number;
	chain?: string; // The compiler's name for the bus this reads. A probe has none.
}

// A node output someone asked to watch. Registers change with every compile, so this names the node, and each image's
// sidecar says where that is now.
export interface Probe {
	node: number;
	port: string;
	label: string;
}

// Which of a Program's voices a probe follows: a track, by its place in the image, and one of its patch slots.
export interface ProbedVoice {
	track: number;
	slot: number;
}

export interface ProbeTarget {
	slot: number;
	label: string;
	step: number;
	operand: number;
}

export const LOAD_ERRORS = [
	'',
	'bad manifest',
	'bad chunk header',
	'chunk hash mismatch',
	'image needs a chunk the receiver does not have',
	'too many chunks',
	'bad table',
	'bad asset',
	'bad patch',
	'bad program',
	'not enough memory for this program',
	'image needs a newer engine',
	'image was compiled for another frame size'
];

// The master, then tracks, then mixer buses, as far as the slots go. Registers change between generations, so these are worked
// out again for each image and never kept.
export function tapTargets(program: ProgramReport): TapTarget[] {
	const { master } = program;
	const targets: TapTarget[] = [
		{ slot: 0, label: 'Master', step: master.step, bus: master.bus, channel: 0, chain: 'master' }
	];
	const add = (label: string, chain: string, { step, bus }: { step: number; bus: number }) => {
		if (targets.length < TAP_SLOTS) targets.push({ slot: targets.length, label, step, bus, channel: 0, chain });
	};
	for (const track of program.tracks) add(track.name || `Track ${track.id}`, `track:${track.id}`, track);
	for (const bus of program.buses) add(String(bus.id), `bus:${bus.id}`, bus);
	return targets;
}

// Probes from `first` up, as far as the slots go. A probe whose node compiled away, or that has nothing to read, is left out,
// and comes back by itself if a later image has it.
export function probeTargets(nodes: NodesReport | undefined, probes: Probe[], first: number): ProbeTarget[] {
	const targets: ProbeTarget[] = [];
	for (const probe of probes) {
		const slot = first + targets.length;
		if (slot >= TAP_SLOTS) break;
		const port = nodes?.[probe.node]?.ports[probe.port];
		if (port?.operand === undefined || port.step === undefined || port.step < 0) continue;
		targets.push({ slot, label: probe.label, step: port.step, operand: port.operand });
	}
	return targets;
}

// What the timeline's editors send while a song plays. The editor page hands them these rather than the engine, because the
// engine may be playing a patch on its own just then.
export type SongControls = Pick<
	AudioEngine,
	'noteOn' | 'noteOff' | 'locate' | 'setLoop' | 'setMix' | 'setParam' | 'setInsertParam'
>;

export class AudioEngine {
	state: EngineState = {
		tick: 0,
		playing: false,
		voices: 0,
		generation: 0,
		liveId: 0,
		error: 0,
		loading: false,
		guardTrips: 0,
		limited: 1,
		time: 0,
		recording: 0,
		countIn: 0,
		clicks: 0
	};
	onState: (state: EngineState) => void = () => {};
	onTap: (slot: number, block: TapBlock) => void = () => {};
	onTargets: (targets: TapTarget[]) => void = () => {};
	onRejected: (reason: string) => void = () => {}; // An image the engine would not take, so the old one is still playing
	onLive: (report: CompileReport) => void = () => {}; // An image has just become the one playing
	onPlayed: (key: PlayedKey) => void = () => {}; // A key stamped while a take runs
	onTakeEnd: (at: { tick: number; elapsed: number }) => void = () => {}; // Where the song was as a take ended

	private context: AudioContext | null = null;
	private node: AudioWorkletNode | null = null;
	private ready: Promise<void> | null = null;
	private reports = new LiveReports();
	private live: CompileReport | null = null;
	private probes: Probe[] = [];
	private probed = ''; // The patch whose nodes those are
	private voice: ProbedVoice = { track: 0, slot: 0 };

	// The rate the audio runs at, which the browser chose: the device's own. 0 until audio has started.
	get sampleRate() {
		return this.context?.sampleRate ?? 0;
	}

	// Must be called from a user gesture, because browsers keep an AudioContext suspended until then.
	start(): Promise<void> {
		this.ready ??= this.connect();
		return this.ready;
	}

	private async connect() {
		const context = new AudioContext({ latencyHint: 'interactive' });
		this.context = context;
		await context.audioWorklet.addModule('/worklet/Processor.js');
		const node = new AudioWorkletNode(context, 'modsynth', { numberOfOutputs: 1, outputChannelCount: [2] });
		this.node = node;
		node.connect(context.destination);
		await new Promise<void>((resolve) => {
			node.port.onmessage = (e) => {
				if (e.data.type === 'ready') resolve();
				this.receive(e.data);
			};
		});
		await context.resume();
	}

	private receive(message: { type: string } & Record<string, unknown>) {
		if (message.type === 'state') {
			this.state = message as unknown as EngineState;
			this.applyTargets();
			this.onState(this.state);
		} else if (message.type === 'load-rejected') {
			// The worklet explains an image it won't start. One the engine fails while loading comes as the engine's error.
			const error = LOAD_ERRORS[message.error as number] || 'image has no program to play';
			this.onRejected((message.reason as string | undefined) ?? error);
		} else if (message.type === 'tap') {
			const buffer = message.buffer as ArrayBuffer;
			const samples = new Float32Array(buffer);
			this.onTap(message.slot as number, {
				samples,
				start: message.start as number,
				dropped: message.dropped as number,
				generation: message.generation as number
			});
			this.node?.port.postMessage({ type: 'tap-return', buffer }, [buffer]);
		} else if (message.type === 'played') {
			this.onPlayed(message as unknown as PlayedKey);
		} else if (message.type === 'take-end') {
			this.onTakeEnd(message as unknown as { tick: number; elapsed: number });
		}
	}

	// After a swap the new program's registers differ, so taps are re-sent from the report for the image now live.
	private applyTargets() {
		const report = this.reports.take(this.state.liveId);
		if (!report) return;
		this.live = report;
		this.sendTargets();
		this.onLive(report);
	}

	private sendTargets() {
		const program = this.live?.programs[0];
		if (!program) return;
		const buses = tapTargets(program);
		const probes = probeTargets(this.live?.sidecar?.[this.probed], this.probes, buses.length);
		for (const t of buses) {
			this.send({ kind: EventKind.SetTap, param: t.slot, target: t.step, note: t.bus, channel: t.channel });
		}
		for (const t of probes) {
			const { track, slot } = this.voice;
			this.send({
				kind: EventKind.SetProbe,
				param: t.slot,
				target: track,
				channel: slot,
				tick: t.step,
				tickEnd: t.operand
			});
		}
		for (let slot = buses.length + probes.length; slot < TAP_SLOTS; ++slot) {
			this.send({ kind: EventKind.SetTap, param: slot, target: NO_TARGET });
		}
		this.onTargets([...buses, ...probes.map(({ slot, label }) => ({ slot, label, step: 0, bus: 0, channel: 0 }))]);
	}

	setProbes(patch: string, probes: Probe[], voice: ProbedVoice = { track: 0, slot: 0 }) {
		this.probed = patch;
		this.probes = probes;
		this.voice = voice;
		this.sendTargets();
	}

	load(image: Uint8Array, report: CompileReport, program = 0) {
		const bytes = image.slice().buffer;
		this.node?.port.postMessage({ type: 'load', image: bytes, program, id: this.reports.add(report) }, [bytes]);
	}

	private send(event: Record<string, number>) {
		this.node?.port.postMessage({ type: 'event', ...event });
	}

	// When the audio that was coming out at `at`, a time on the page's clock such as an event's timeStamp, was made, on the
	// audio clock the worklet keeps. A key pressed in time with what is heard is in time with that, which is what puts a
	// recorded note where it was meant, however long the output's latency is.
	heardAt(at = performance.now()): number {
		const context = this.context;
		if (!context) return 0;
		const stamp = context.getOutputTimestamp?.();
		if (stamp?.contextTime && stamp.performanceTime) return stamp.contextTime + (at - stamp.performanceTime) / 1000;
		const latency = (context.outputLatency || 0) + (context.baseLatency || 0);
		return context.currentTime - latency + (at - performance.now()) / 1000;
	}

	// A take: a bar counted in at `bpm` before the song plays from `start`, or none if `bpm` is 0 or the song is playing, and
	// then each note sent with a time is stamped with where the song was when it was heard. The bar counted in is the one of
	// the song's meter at `start`, and the click follows `bars` through the take (TimeSignature.ts).
	record(bars: Bars, bpm: number, start: number) {
		const bar = bars.at(start);
		const ticks = bar.beat * bar.meter.beats;
		const pulses = Math.round(ticks / pulseTicks(bars.ppq, bar.meter));
		const meter = bars.segments();
		this.node?.port.postMessage({ type: 'record', ppq: bars.ppq, meter, ticks, pulses, beats: pulses, bpm, start });
	}

	stopRecording(at?: number) {
		this.node?.port.postMessage({ type: 'record-stop', heard: this.heardAt(at) });
	}

	play() {
		this.send({ kind: EventKind.Play });
	}
	stop() {
		this.send({ kind: EventKind.Stop });
	}
	locate(tick: number) {
		this.send({ kind: EventKind.Locate, tick });
	}
	setLoop(start: number, end: number) {
		this.send({ kind: EventKind.SetLoop, tick: start, tickEnd: end });
	}
	// A note given the time its key went down or up, on the page's clock, is stamped for a take.
	noteOn(track: number, note: number, velocity = 100, at?: number) {
		this.send({ kind: EventKind.NoteOn, target: track, note, velocity, ...this.stamp(at) });
	}
	noteOff(track: number, note: number, at?: number) {
		this.send({ kind: EventKind.NoteOff, target: track, note, ...this.stamp(at) });
	}
	private stamp(at: number | undefined): Record<string, number> {
		return at === undefined ? {} : { heard: this.heardAt(at) };
	}
	setParam(track: number, param: number, value: number) {
		this.send({ kind: EventKind.SetParam, target: track, param, value });
	}
	setInsertParam(insert: number, param: number, value: number) {
		this.send({ kind: EventKind.SetInsertParam, target: insert, param, value });
	}
	setMix(register: number, value: number) {
		this.send({ kind: EventKind.SetMix, param: register, value });
	}

	async close() {
		await this.context?.close();
		this.context = null;
		this.node = null;
		this.ready = null;
	}
}
