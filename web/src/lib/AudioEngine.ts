// The main thread's handle on the worklet.
import { LiveReports } from '#lib/LiveReports.ts';
import type { CompileReport, ProgramReport } from '#lib/Request.ts';

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
	SetLoop: 9
} as const;

export interface EngineState {
	tick: number;
	playing: boolean;
	voices: number;
	generation: number;
	liveId: number;
	error: number;
	loading: boolean;
	guardTrips: number;
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
	'not enough memory for this program'
];

// The master and up to seven tracks, from the compiler's report. Registers change between generations, so these are
// worked out again for each image and never kept.
export function tapTargets(program: ProgramReport): TapTarget[] {
	const targets: TapTarget[] = [{ slot: 0, label: 'Master', step: program.master.step, bus: program.master.bus, channel: 0 }];
	for (const track of program.tracks.slice(0, 7)) {
		targets.push({
			slot: targets.length,
			label: track.name || `Track ${track.id}`,
			step: track.step,
			bus: track.bus,
			channel: 0
		});
	}
	return targets;
}

export class AudioEngine {
	state: EngineState = {
		tick: 0,
		playing: false,
		voices: 0,
		generation: 0,
		liveId: 0,
		error: 0,
		loading: false,
		guardTrips: 0
	};
	onState: (state: EngineState) => void = () => {};
	onTap: (slot: number, block: TapBlock) => void = () => {};
	onTargets: (targets: TapTarget[]) => void = () => {};

	private context: AudioContext | null = null;
	private node: AudioWorkletNode | null = null;
	private ready: Promise<void> | null = null;
	private reports = new LiveReports();

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
		}
	}

	// After a swap the new program's registers differ, so taps are re-sent from the report for the image now live.
	private applyTargets() {
		const program = this.reports.take(this.state.liveId)?.programs[0];
		if (!program) return;
		const targets = tapTargets(program);
		for (const t of targets) {
			this.send({ kind: EventKind.SetTap, param: t.slot, target: t.step, note: t.bus, channel: t.channel });
		}
		this.onTargets(targets);
	}

	load(image: Uint8Array, report: CompileReport, program = 0) {
		const bytes = image.slice().buffer;
		this.node?.port.postMessage({ type: 'load', image: bytes, program, id: this.reports.add(report) }, [bytes]);
	}

	private send(event: Record<string, number>) {
		this.node?.port.postMessage({ type: 'event', ...event });
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
	noteOn(track: number, note: number, velocity = 100) {
		this.send({ kind: EventKind.NoteOn, target: track, note, velocity });
	}
	noteOff(track: number, note: number) {
		this.send({ kind: EventKind.NoteOff, target: track, note });
	}
	setParam(track: number, param: number, value: number) {
		this.send({ kind: EventKind.SetParam, target: track, param, value });
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
