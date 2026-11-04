// The page's session with the engine: which image plays, compiling the song and the patch heard on its own as they change,
// loading what compiled, the transport, the loop and solo. The page says what each image is made of and when it changes, and
// draws what this holds, so the rules for which image plays and when are tested here rather than only end to end.
//
// The engine plays one image at a time: the song, which is the open timeline or example, or the Patch view's patch on its
// own, for a patch no track plays. What the page touches decides which: the transport and the timeline's editors want the
// song, and the keys in the Patch view want wherever that patch is heard.
import type { Loop } from '#lib/Arrangement.svelte';
import { AudioEngine, type EngineState, type SongControls, type TapTarget } from '#lib/AudioEngine.ts';
import { Compiler, type Compiled } from '#lib/Compiler.ts';
import type { CompileReport } from '#lib/Request.ts';
import type { Timeline } from '#lib/Schema.ts';
import { Ring } from '#lib/ScopeMath.ts';
import { mixWrites, settlingWrites, soloed, trackKey, type PatchLike } from '#lib/TimelineEdit.ts';

export type Source = 'song' | 'alone';

// What the session asks of the page.
export interface SessionHost {
	songRequest(): { request: string; doc?: Timeline } | null; // The song's compile request, and the document it came from
	aloneRequest(): string | null; // What plays on its own, while something does
	assetsArriving(): boolean; // Recordings on their way, whose arrival schedules a compile again
	openKey(): string; // Which song is open, so a compile of the last one is dropped
	patches(): PatchLike[]; // The patches a song's settling reads defaults from
	songRefused(): void; // The song compiled with errors
}

// The engine and the compiler, as the session uses them, so a test can stand in for both.
export type Engine = Pick<
	AudioEngine,
	| 'start'
	| 'load'
	| 'play'
	| 'stop'
	| 'locate'
	| 'setLoop'
	| 'noteOn'
	| 'noteOff'
	| 'setMix'
	| 'setParam'
	| 'setInsertParam'
	| 'close'
	| 'onState'
	| 'onTap'
	| 'onTargets'
	| 'onRejected'
	| 'onLive'
>;
export type Compiles = Pick<Compiler, 'compile' | 'close'>;

// How long an edit waits for the next before it compiles, so a run of keys or a drag compiles once.
export const COMPILE_WAIT_MS = 250;

export class EngineSession<E extends Engine = AudioEngine> {
	readonly engine: E;
	readonly rings = Array.from({ length: 8 }, () => new Ring(48000));

	started = $state(false);
	engineState = $state<EngineState | null>(null);
	targets = $state<TapTarget[]>([]);
	rejected = $state('');
	want = $state<Source>('song');
	live = $state<Source | null>(null); // Which the image now playing is, once one is
	songTick = $state(0); // Where the song was when a patch on its own took over

	song = $state.raw<Compiled | null>(null);
	goodSong = $state.raw<Compiled | null>(null);
	alone = $state.raw<Compiled | null>(null);
	goodAlone = $state.raw<Compiled | null>(null);
	liveSong = $state.raw<CompileReport | null>(null); // The song's image that is playing, once one is
	// An edit not yet compiled, and an image sent to the engine that isn't playing yet. The light says so until both are done,
	// so what is heard is known to be the newest edit.
	compiling = $state<Record<Source, boolean>>({ song: false, alone: false });
	compiles = $state(0); // Sent to the compiler since the page opened, so a test can tell an edit's compile has started
	loading = $state.raw<CompileReport | null>(null);
	readonly busy = $derived(this.compiling.song || this.compiling.alone || this.loading !== null);
	liveAlone = $state.raw<CompileReport | null>(null); // The image of the patch on its own that is playing, once one is
	// Whether what is heard is what is on screen: none until an image of what is wanted plays; the newest once nothing is on its
	// way and the image playing is the newest compile of what is wanted, and it compiled; older otherwise, as after a refused
	// edit, while an edit compiles, or when the engine refused the newest image. The light says so, and tests wait on it.
	readonly heard = $derived.by((): 'none' | 'older' | 'newest' => {
		if (!this.started || this.live === null || this.live !== this.want) return 'none';
		const newest = this.want === 'song' ? this.song : this.alone;
		const playing = this.want === 'song' ? this.liveSong : this.liveAlone;
		return !this.busy && newest?.report.ok && playing === newest.report ? 'newest' : 'older';
	});

	// Tracks soloed in the song that is open, which play while every other track is muted. Solo is a way of listening to the
	// song rather than part of it, so it is never saved: it goes into what is compiled and heard, and so into Export WAV, which
	// writes what is heard. A song opened starts with none.
	solo = $state.raw<ReadonlySet<number>>(new Set());

	// The loop is the editor's, not the song's: it isn't saved, and another song starts without one. The top bar turns it on and
	// off, and the arrangement's strip shows it, draws it and moves it. Until one is drawn it is the whole song, which follows the
	// song as it grows, so null stands for that.
	loop = $state.raw<Loop | null>(null);
	looping = $state(false);

	// Where the playhead is: the engine's while the song plays, and otherwise where the song was left.
	readonly tick = $derived(this.live === 'song' ? (this.engineState?.tick ?? 0) : this.songTick);
	// The song's length, so Play at its end starts it again.
	readonly length = $derived(this.goodSong?.report.programs[0]?.length_ticks ?? 0);
	readonly songPlaying = $derived(this.live === 'song' && !!this.engineState?.playing);

	readonly #host: SessionHost;
	readonly #makeCompiler: () => Compiles;
	#compiler: Compiles | undefined;
	#starting = false;
	#waiting: (() => void)[] = []; // Sent when what is wanted goes live
	#newest: (() => void)[] = []; // Play and playhead moves, sent once the song's newest edit plays or is refused
	#songRan = false; // Whether the song was playing when a patch on its own took over: that one runs the transport too
	#loopSent = false;
	readonly #sent: Record<Source, string> = { song: '', alone: '' };
	readonly #timers: Partial<Record<Source, ReturnType<typeof setTimeout>>> = {};
	readonly #waitingOut: Record<Source, boolean> = { song: false, alone: false }; // An edit waiting out COMPILE_WAIT_MS
	readonly #inFlight: Record<Source, number> = { song: 0, alone: 0 }; // Compiles sent and not yet answered
	readonly #sourceOf = new WeakMap<CompileReport, Source>();
	readonly #compiledFrom = new WeakMap<CompileReport, Timeline>(); // Which document each song report came from
	readonly #keyOf = new WeakMap<CompileReport, string>(); // Which song each song report was compiled for

	constructor(host: SessionHost, want: Source, engine?: E, makeCompiler: () => Compiles = () => new Compiler()) {
		this.#host = host;
		this.want = want;
		this.engine = engine ?? (new AudioEngine() as unknown as E);
		this.#makeCompiler = makeCompiler;
		const e = this.engine;
		e.onState = (s) => {
			this.engineState = s;
			// A shared LFO waits for the transport, and a patch on its own has no Play button.
			if (this.live === 'alone' && this.want === 'alone' && s.generation !== 0 && !s.playing) e.play();
		};
		e.onTap = (slot, block) => this.rings[slot].push(block.samples, block.start, block.generation);
		e.onTargets = (t) => (this.targets = t);
		e.onRejected = (reason) => {
			this.rejected = reason;
			this.loading = null;
			this.#sendNewest();
		};
		e.onLive = (report) => {
			if (report === this.loading) this.loading = null;
			const source = this.#sourceOf.get(report) ?? null;
			// An image of a song no longer open is not the song wanted: it takes no Play or keys, and the song's own comes.
			this.live = source === 'song' && this.#keyOf.get(report) !== this.#host.openKey() ? null : source;
			if (this.live === 'alone') this.liveAlone = report;
			if (this.live === 'song') {
				this.liveSong = report;
				this.#settle(report);
			}
			if (this.live === this.want) {
				const ready = this.#waiting;
				this.#waiting = [];
				for (const send of ready) send();
			}
			this.#sendNewest();
		};
	}

	// What the timeline's editors send. Notes and moves of the playhead bring the song back; a control dragged while a patch
	// plays on its own has nothing to move, and settles when its edit compiles.
	readonly controls: SongControls = {
		noteOn: (track, note, velocity) => this.use('song', () => this.engine.noteOn(track, note, velocity)),
		noteOff: (track, note) => this.use('song', () => this.engine.noteOff(track, note)),
		locate: (tick) => this.use('song', () => this.#whenNewest(() => this.engine.locate(tick))),
		setLoop: (start, end) => this.setLoop(end > start ? { start, end } : null, end > start),
		setMix: (register, value) => this.#songHeard() && this.engine.setMix(register, value),
		setParam: (track, param, value) => this.#songHeard() && this.engine.setParam(track, param, value),
		setInsertParam: (insert, param, value) => this.#songHeard() && this.engine.setInsertParam(insert, param, value)
	};

	#songHeard() {
		return this.live === 'song' && this.want === 'song';
	}

	// ----------------------------------------------------------------------------------------------------------- compiling

	// An image's makings changed: it compiles once they stop changing for a moment.
	schedule(source: Source) {
		clearTimeout(this.#timers[source]);
		this.compiling[source] = true;
		this.#waitingOut[source] = true;
		this.#timers[source] = setTimeout(() => {
			this.#waitingOut[source] = false;
			void this.compile(source);
		}, COMPILE_WAIT_MS);
	}

	async compile(source: Source) {
		if (this.#host.assetsArriving()) return; // Their arrival schedules this again
		// The light goes out only once no edit waits and no compile is on its way: one still on its way may load an image after
		// this one, and a compile with nothing new to send, as Save schedules, mustn't put the light out under it.
		const done = () => {
			if (this.#waitingOut[source] || this.#inFlight[source] > 0) return;
			this.compiling[source] = false;
			this.#sendNewest();
		};
		const request = source === 'alone' ? this.#host.aloneRequest() : null;
		const built = source === 'song' ? this.#host.songRequest() : request ? { request } : null;
		if (!built || built.request === this.#sent[source]) return done();
		this.#sent[source] = built.request;
		this.compiles++;
		const from = this.#host.openKey();
		this.#compiler ??= this.#makeCompiler();
		this.#inFlight[source]++;
		const result = await this.#compiler.compile(built.request, source).finally(() => this.#inFlight[source]--);
		if (!result || (source === 'song' && from !== this.#host.openKey())) return done();
		this.#sourceOf.set(result.report, source);
		this.#keyOf.set(result.report, from);
		if (source === 'song') {
			if (built.doc) this.#compiledFrom.set(result.report, built.doc);
			this.song = result;
			if (result.report.ok) this.goodSong = result;
			else this.#host.songRefused();
		} else {
			this.alone = result;
			if (result.report.ok) this.goodAlone = result;
		}
		if (result.report.ok && this.started && this.want === source) this.#load(result);
		done();
	}

	// Sends an image to the engine, which plays it once it has loaded.
	#load(compiled: Compiled) {
		this.rejected = '';
		this.loading = compiled.report;
		this.engine.load(compiled.image, compiled.report);
	}

	// A song's image playing: the mix, the Controls and the inserts' values go to what the song holds there.
	#settle(report: CompileReport) {
		const doc = this.#compiledFrom.get(report);
		const program = report.programs[0];
		if (!doc || !program) return;
		const { mix, params, inserts } = settlingWrites(doc, program, this.#host.patches());
		for (const { register, value } of mix) this.engine.setMix(register, value);
		for (const { track, param, value } of params) this.engine.setParam(track, param, value);
		for (const { insert, param, value } of inserts) this.engine.setInsertParam(insert, param, value);
	}

	// Another song is open: what belonged to the last one goes, and the transport goes back to its start.
	songChanged() {
		this.song = this.goodSong = this.liveSong = null;
		this.#sent.song = '';
		this.songTick = 0;
		this.#songRan = false;
		if (this.live === 'song') this.live = null; // The last song's image takes no Play or keys while the new one compiles
		this.#newest = [];
		this.solo = new Set();
		this.loop = null;
		this.looping = false;
		if (this.started && this.want === 'song') {
			this.engine.stop();
			this.engine.locate(0);
			this.engine.setLoop(0, 0);
		}
	}

	// What plays on its own is another patch or track: the image there was is no longer it.
	aloneChanged() {
		this.alone = this.goodAlone = this.liveAlone = null;
		this.#sent.alone = '';
		if (this.live === 'alone') this.live = null;
	}

	// --------------------------------------------------------------------------------------------------------- what plays

	// Makes `source` the image playing, then sends `then` once it is.
	use(source: Source, then?: () => void) {
		if (this.want !== source) {
			if (this.want === 'song') this.#songRan = this.live === 'song' && !!this.engineState?.playing;
			if (this.live === 'song' && this.engineState) this.songTick = this.engineState.tick;
			this.want = source;
			this.#newest = [];
			// The image swaps under a running transport, and what played on its own ran it only for its LFOs. Stopped first,
			// the song comes back as it was left. That image may already be on its way out, so `live` can't say it was there.
			if (source === 'song' && !this.#songRan && this.engineState?.playing) this.engine.stop();
			this.#waiting = source === 'song' ? [() => this.engine.locate(this.songTick)] : [];
			const good = source === 'song' ? this.goodSong : this.goodAlone;
			if (this.started && good) this.#load(good);
		}
		if (then) {
			if (this.live === this.want) then();
			else this.#waiting.push(then);
		}
		if (!this.started) void this.start();
	}

	// The song is wanted again, as when nothing is heard on its own any more, and `then` once it plays. Unlike `use`, this
	// starts nothing, since there may be no click or key to start audio on, but audio on its way plays the song once it starts.
	wantSong(then?: () => void) {
		if (this.want === 'song') return;
		if (this.started || this.#starting) return this.use('song', then);
		this.want = 'song';
		this.#waiting = [];
	}

	// Audio starts. A browser lets it only in answer to a click or a key, so this is called from one.
	async start() {
		if (this.#starting) return;
		this.#starting = true;
		await this.engine.start();
		this.started = true;
		const good = this.want === 'song' ? this.goodSong : this.goodAlone;
		if (good) this.#load(good);
	}

	play() {
		this.use('song', () =>
			this.#whenNewest(() => {
				const at = this.engineState;
				if (at && this.length > 0 && at.tick >= this.length && !at.playing) this.engine.locate(0);
				for (const ring of this.rings) ring.mark(); // Meters hold the loudest since Play
				this.engine.play();
			})
		);
	}

	// Play and moves of the playhead wait for an edit on its way to the song, as they wait for the song's first image: in the
	// image before it, a note the edit put at or before the playhead would never start. A refused edit lets them go at once,
	// to the image that plays. Keys don't wait.
	#whenNewest(send: () => void) {
		if (this.#songSettling()) this.#newest.push(send);
		else send();
	}

	#songSettling() {
		return this.compiling.song || this.loading !== null;
	}

	#sendNewest() {
		if (this.#songSettling() || this.want !== 'song' || this.live !== 'song') return;
		const ready = this.#newest;
		this.#newest = [];
		for (const send of ready) send();
	}

	// Stop, and pressed again once stopped, back to the start, as most DAWs do.
	stopOrStart() {
		if (this.songPlaying) this.engine.stop();
		else this.toStart();
	}

	// Back to the start of the song. A patch heard on its own keeps the engine, and the song starts there when it comes back.
	toStart() {
		this.songTick = 0;
		if (this.live === 'song') this.engine.locate(0);
	}

	// The playhead moved by the top bar's position: shown there at once, and where the song starts if a patch on its own is
	// playing now.
	moveTo(at: number) {
		this.songTick = at;
		this.controls.locate(at);
	}

	setLoop(next: Loop | null, on: boolean) {
		this.loop = next;
		this.looping = on;
	}

	toggleLoop() {
		this.setLoop(this.loop, !this.looping);
	}

	// What the engine loops, sent again with each new image, which can be in a new engine. A loop drawn before audio starts
	// reaches the engine this way too.
	sendLoop(range: Loop | null) {
		if (range) this.engine.setLoop(range.start, range.end);
		else if (this.#loopSent) this.engine.setLoop(0, 0);
		this.#loopSent = range !== null;
	}

	// Solo on or off for a track, heard at once through the mix registers, as a Mute is, until the compile that follows puts it
	// in the image.
	toggleSolo(id: number, doc: Timeline | null) {
		const next = new Set(this.solo);
		if (!next.delete(id)) next.add(id);
		this.solo = next;
		const program = this.goodSong?.report.programs[0];
		if (!doc || !program) return;
		const heard = soloed(doc, next);
		for (const track of doc.tracks) {
			for (const { register, value } of mixWrites(heard, program, trackKey(track.id))) {
				this.controls.setMix(register, value);
			}
		}
	}

	// Tracks that are gone are soloed no more, so a track made later with one's id doesn't start soloed.
	keepSolo(ids: ReadonlySet<number>) {
		if ([...this.solo].some((id) => !ids.has(id))) this.solo = new Set([...this.solo].filter((id) => ids.has(id)));
	}

	close() {
		for (const timer of Object.values(this.#timers)) clearTimeout(timer);
		this.#compiler?.close();
		void this.engine.close();
	}
}
