<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount, untrack } from 'svelte';
	import {
		AudioEngine,
		LOAD_ERRORS,
		tapTargets,
		type EngineState,
		type Probe,
		type SongControls,
		type TapTarget
	} from '#lib/AudioEngine.ts';
	import Browser from '#lib/Browser.svelte';
	import BundleDialog from '#lib/BundleDialog.svelte';
	import { Compiler, type Compiled } from '#lib/Compiler.ts';
	import { downloadBytes, downloadImage } from '#lib/Download.ts';
	import { renderWav } from '#lib/Render.ts';
	import { nodeOfError } from '#lib/GraphEdit.ts';
	import Meter from '#lib/Meter.svelte';
	import PatchPanel from '#lib/PatchPanel.svelte';
	import ReportPanel from '#lib/ReportPanel.svelte';
	import { buildRequest, missingAssets, reachable, type AssetEntry, type CompileReport } from '#lib/Request.ts';
	import { referencedPatches, timelineSchema, type Graph, type Param, type Timeline } from '#lib/Schema.ts';
	import { Ring } from '#lib/ScopeMath.ts';
	import Splitter from '#lib/Splitter.svelte';
	import { BEATS_PER_BAR, patchUses, replacePatch, settlingWrites, tempoAt, type PatchUse } from '#lib/TimelineEdit.ts';
	import TimelineEditor from '#lib/TimelineEditor.svelte';
	import {
		actionOn,
		draftKey,
		edited,
		graphError,
		hearing,
		isInsert,
		parseGraph,
		stay,
		withDrafts,
		withParams,
		type Draft
	} from '#lib/Workspace.ts';

	let { data, form } = $props();

	// The engine plays one image at a time: the song, which is the open timeline or example, or the patch on screen on its own,
	// for a patch no track plays. What the page touches decides which: the transport and the timeline's editors want the song,
	// and the patch panel's keys want wherever that patch is heard.
	type Source = 'song' | 'alone';

	// ------------------------------------------------------------------------------------------------------- what is open

	const search = $derived(page.url.search);
	const recipe = $derived(data.open?.kind === 'recipe' ? data.open : null);
	const saved = $derived(data.open?.kind === 'timeline' ? data.open : null);
	const openKey = $derived(recipe ? `recipe:${recipe.entry.name}` : saved ? `timeline:${saved.id}` : '');

	// Unsaved edits to any patch or timeline, kept while other things are opened, and saved together.
	let drafts = $state.raw<Record<string, Draft>>({});
	const dirty = $derived(new Set(Object.keys(drafts)));
	const library = $derived(withDrafts(data.library.patches, drafts));

	const savedTimelineText = $derived(saved ? JSON.stringify(saved.doc, null, 1) : '');
	const timelineDraft = $derived(saved ? drafts[draftKey('timeline', saved.id)] : undefined);
	const timelineName = $derived(timelineDraft?.name ?? saved?.name ?? '');
	const timelineText = $derived(timelineDraft?.text ?? savedTimelineText);
	const timelineParsed = $derived.by((): { value: unknown; error: string } => {
		if (!saved) return { value: null, error: '' };
		try {
			return { value: JSON.parse(timelineText), error: '' };
		} catch (e) {
			return { value: null, error: (e as Error).message };
		}
	});
	// What the editors draw: the text, as long as it makes a document. Text that doesn't leaves the last drawing alone.
	const drawnTimelines = new Map<string, Timeline>();
	const timelineDoc = $derived.by((): Timeline | null => {
		if (!saved) return null;
		const checked = timelineSchema.safeParse(timelineParsed.value);
		if (checked.success) {
			drawnTimelines.set(saved.id, checked.data);
			return checked.data;
		}
		return drawnTimelines.get(saved.id) ?? timelineSchema.parse(saved.doc);
	});
	const songDoc = $derived(recipe ? recipe.timeline : timelineDoc);
	const songPatches = $derived(recipe ? recipe.patches : library);

	// The patch above is the one asked for, and otherwise the chosen track's.
	let selectedTrack = $state<number | null>(null);
	const askedPatch = $derived(page.url.searchParams.get('patch'));
	const askedPart = $derived(page.url.searchParams.get('part'));
	const trackSlot = $derived.by(() => {
		const track = songDoc?.tracks.find((t) => t.id === selectedTrack) ?? songDoc?.tracks[0];
		return track?.slots[0] ?? null;
	});
	const shown = $derived.by(() => {
		if (askedPatch !== null) {
			const patch = library.find((p) => p.id === askedPatch);
			return patch ? { patch, example: false } : null;
		}
		if (recipe) {
			const id = askedPart ?? trackSlot;
			const patch = recipe.patches.find((p) => p.id === id) ?? recipe.patches[0];
			return patch ? { patch, example: true } : null;
		}
		const patch = trackSlot === null ? undefined : library.find((p) => p.id === trackSlot);
		return patch ? { patch, example: false } : null;
	});
	const savedPatch = $derived(
		shown && !shown.example ? data.library.patches.find((p) => p.id === shown.patch.id) : undefined
	);
	const shownBuiltin = $derived(savedPatch?.builtin ?? false);
	// What Duplicate copies: the patch on screen, or for an example's patch, the built-in one it is in every library as.
	const duplicateId = $derived(
		!shown ? null : shown.example ? (recipe?.builtins[shown.patch.id] ?? null) : savedPatch ? savedPatch.id : null
	);
	const savedPatchText = $derived(savedPatch ? JSON.stringify(savedPatch.graph, null, 1) : '');
	const patchDraft = $derived(savedPatch ? drafts[draftKey('patch', savedPatch.id)] : undefined);
	const patchName = $derived(shown?.patch.name ?? '');
	const patchText = $derived(
		patchDraft?.text ?? (savedPatch ? savedPatchText : shown ? JSON.stringify(shown.patch.graph, null, 1) : '')
	);

	const bundle = $derived(data.library.bundles.find((b) => b.id === page.url.searchParams.get('bundle')));

	// ------------------------------------------------------------------------------------------------------------ editing

	function put(key: string, draft: Draft | null) {
		const { [key]: _, ...rest } = drafts;
		drafts = draft ? { ...rest, [key]: draft } : rest;
	}

	function timelineEdited(change: { name?: string; text?: string }) {
		if (!saved) return;
		const key = draftKey('timeline', saved.id);
		const base = {
			kind: 'timeline' as const,
			id: saved.id,
			revision: saved.revision,
			name: saved.name,
			text: savedTimelineText
		};
		put(key, edited(base, drafts[key], change));
	}

	function patchEdited(change: { name?: string; text?: string; graph?: Graph }) {
		if (!savedPatch || savedPatch.builtin) return;
		const key = draftKey('patch', savedPatch.id);
		const base = {
			kind: 'patch' as const,
			id: savedPatch.id,
			revision: savedPatch.revision,
			name: savedPatch.name,
			text: savedPatchText
		};
		const text = change.graph ? JSON.stringify(change.graph, null, 1) : change.text;
		const graph = change.graph ?? (text === undefined ? undefined : (parseGraph(text) ?? undefined));
		put(
			key,
			edited(base, drafts[key], {
				...(change.name === undefined ? {} : { name: change.name }),
				...(text === undefined ? {} : { text }),
				...(graph ? { graph } : {})
			})
		);
	}

	// A save sends every draft, and a draft edited while it was on its way stays, on the revision the save made.
	const saving: SubmitFunction = ({ formData }) => {
		const sending = Object.values(drafts);
		formData.set(
			'edits',
			JSON.stringify(sending.map(({ kind, id, revision, name, text }) => ({ kind, id, revision, name, text })))
		);
		return async ({ result, update }) => {
			await update({ reset: false });
			if (result.type !== 'success') return;
			const revisions = (result.data?.revisions ?? {}) as Record<string, number>;
			const next = { ...drafts };
			for (const draft of sending) {
				const key = draftKey(draft.kind, draft.id);
				if (next[key] === draft) delete next[key];
				else if (next[key] && revisions[key] !== undefined) next[key] = { ...next[key], revision: revisions[key] };
			}
			drafts = next;
		};
	};

	// A copy of a built-in patch takes its place in the timeline open below, as an unsaved edit, so that changing it is heard
	// where it plays. Either way the copy opens above.
	const duplicating: SubmitFunction = () => {
		return async ({ result, update }) => {
			await update({ reset: false });
			if (result.type !== 'success') return;
			const made = result.data?.duplicated as { from: string; to: string } | undefined;
			if (!made) return;
			const original = data.library.patches.find((p) => p.id === made.from);
			if (original?.builtin && saved && timelineDoc && referencedPatches(timelineDoc).includes(made.from)) {
				timelineEdited({ text: JSON.stringify(replacePatch(timelineDoc, made.from, made.to), null, 1) });
			}
			open({ patch: made.to, part: null });
		};
	};

	// ------------------------------------------------------------------------------------------------------- recordings

	// The library's load carries the recordings of what someone made or uses, and a built-in patch's arrive from /assets once
	// it is opened or put in an edit. Until they do, nothing compiles, so a compile never misses one that is on its way.
	let fetchedAssets = $state.raw<AssetEntry[]>([]);
	let fetchingAssets = $state(0);
	let assetProblem = $state('');
	const requestedAssets = new Set<string>();
	const assets = $derived.by(() => {
		const held = new Set(data.library.assets.map((asset) => asset.id));
		return [...data.library.assets, ...fetchedAssets.filter((asset) => !held.has(asset.id))];
	});
	const neededAssets = $derived(
		missingAssets(
			[...(timelineDoc ? referencedPatches(timelineDoc) : []), ...(shown && !shown.example ? [shown.patch.id] : [])],
			library,
			assets
		)
	);
	$effect(() => {
		const wanted = neededAssets.filter((id) => !requestedAssets.has(id));
		if (wanted.length) untrack(() => void fetchAssets(wanted));
	});

	async function fetchAssets(ids: string[]) {
		for (const id of ids) requestedAssets.add(id);
		fetchingAssets++;
		try {
			const response = await fetch(`/assets?${new URLSearchParams(ids.map((id) => ['id', id]))}`);
			if (!response.ok) throw new Error(`the server said ${response.status}`);
			fetchedAssets = [...fetchedAssets, ...((await response.json()) as AssetEntry[])];
			assetProblem = '';
		} catch (e) {
			for (const id of ids) requestedAssets.delete(id); // So the next edit that needs them asks again
			assetProblem = `Recordings didn't load: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			fetchingAssets--;
		}
	}

	// A deleted patch or timeline takes its draft with it.
	$effect(() => {
		const known = new Set([
			...data.library.patches.map((p) => draftKey('patch', p.id)),
			...data.library.timelines.map((t) => draftKey('timeline', t.id))
		]);
		untrack(() => {
			const gone = Object.keys(drafts).filter((key) => !known.has(key));
			if (gone.length) drafts = Object.fromEntries(Object.entries(drafts).filter(([key]) => known.has(key)));
		});
	});

	// ---------------------------------------------------------------------------------------------------------- the engine

	const engine = new AudioEngine();
	const rings = Array.from({ length: 8 }, () => new Ring(48000));
	let started = $state(false);
	let starting = false;
	let engineState = $state<EngineState | null>(null);
	let targets = $state<TapTarget[]>([]);
	let rejected = $state('');
	let want = $state<Source>(untrack(() => (data.open ? 'song' : 'alone')));
	let live = $state<Source | null>(null); // Which the image now playing is, once one is
	let waiting: (() => void)[] = []; // Sent when what is wanted goes live
	let songTick = 0; // Where the song was when a patch on its own took over

	let compiler: Compiler | undefined;
	let rendering = $state<number | null>(null); // How far a WAV export has got
	let renderProblem = $state('');
	let song = $state.raw<Compiled | null>(null);
	let goodSong = $state.raw<Compiled | null>(null);
	let alone = $state.raw<Compiled | null>(null);
	let goodAlone = $state.raw<Compiled | null>(null);
	const sent: Record<Source, string> = { song: '', alone: '' };
	const timers: Partial<Record<Source, ReturnType<typeof setTimeout>>> = {};
	// An edit not yet compiled, and an image sent to the engine that isn't playing yet. The status bar says so until both are
	// done, so what is heard is known to be the newest edit.
	const asked: Record<Source, number> = { song: 0, alone: 0 };
	let compiling = $state<Record<Source, boolean>>({ song: false, alone: false });
	let loading = $state.raw<CompileReport | null>(null);
	const busy = $derived(compiling.song || compiling.alone || loading !== null);
	const sourceOf = new WeakMap<CompileReport, Source>();
	const compiledFrom = new WeakMap<CompileReport, Timeline>(); // Which document each song report came from

	// A library patch shown beside an example isn't in it, whatever its id: an example's ids are its own.
	const hears = $derived(
		hearing(
			recipe && !shown?.example ? null : songDoc,
			goodSong?.report.programs[0] ?? null,
			shown?.patch ?? null,
			selectedTrack,
			shown !== null && !shown.example
		)
	);
	// A patch no track plays is compiled on its own too, so its errors and what compiled away show even when it can't be played.
	const aloneWanted = $derived(
		shown !== null &&
			!shown.example &&
			(hears.kind === 'alone' || (isInsert(shown.patch.graph) && !goodSong?.report.sidecar?.[shown.patch.id]))
	);

	function songRequest(): { request: string; doc?: Timeline } | null {
		if (recipe) return { request: JSON.stringify(recipe.project) };
		if (!saved || timelineParsed.value === null) return null;
		// A document that doesn't fit the schema goes whole, so that the compiler is what says what's wrong with it.
		const checked = timelineSchema.safeParse(timelineParsed.value);
		const reached = checked.success
			? reachable(referencedPatches(checked.data), library, assets)
			: { patches: library, assets };
		const programs = [{ id: saved.id, name: timelineName, timeline: timelineParsed.value as Timeline }];
		return {
			request: buildRequest(reached.patches, reached.assets, programs),
			doc: checked.success ? checked.data : undefined
		};
	}

	// One track that plays the patch, kept by `live` though it has no notes, or for an insert, the master's only insert.
	function aloneRequest(): string | null {
		if (!aloneWanted || !shown) return null;
		const id = shown.patch.id;
		const timeline = isInsert(shown.patch.graph)
			? { master: { inserts: [{ id: 1, patch: id }] } }
			: { tracks: [{ id: 1, name: patchName, voices: 8, slots: [id] }] };
		const reached = reachable([id], library, assets);
		return buildRequest(
			reached.patches,
			reached.assets,
			[{ id: 'preview', name: 'Preview', timeline: timeline as never }],
			{
				live: true
			}
		);
	}

	function schedule(source: Source) {
		clearTimeout(timers[source]);
		asked[source]++;
		compiling[source] = true;
		timers[source] = setTimeout(() => compile(source), 250);
	}

	// The song as it last compiled, rendered to its end and its tail, then downloaded.
	async function exportWav() {
		const compiled = goodSong;
		const program = compiled?.report.programs[0];
		if (!compiled || !program || rendering !== null) return;
		rendering = 0;
		renderProblem = '';
		try {
			const wav = await renderWav(compiled.image, program.length_ticks, (fraction) => (rendering = fraction));
			downloadBytes(wav, `${recipe?.entry.name ?? (timelineName || 'song')}.wav`, 'audio/wav');
		} catch (error) {
			renderProblem = error instanceof Error ? error.message : String(error);
		} finally {
			rendering = null;
		}
	}

	// Sends an image to the engine, which plays it once it has loaded.
	function load(compiled: Compiled) {
		rejected = '';
		loading = compiled.report;
		engine.load(compiled.image, compiled.report);
	}

	async function compile(source: Source) {
		if (fetchingAssets > 0) return; // Their arrival schedules this again
		const mine = asked[source];
		const done = () => {
			if (asked[source] === mine) compiling[source] = false;
		};
		const request = source === 'alone' ? aloneRequest() : null;
		const built: { request: string; doc?: Timeline } | null =
			source === 'song' ? songRequest() : request ? { request } : null;
		if (!built || built.request === sent[source]) return done();
		sent[source] = built.request;
		const from = openKey;
		compiler ??= new Compiler();
		const result = await compiler.compile(built.request, source);
		if (!result || (source === 'song' && from !== openKey)) return done();
		sourceOf.set(result.report, source);
		if (source === 'song') {
			if (built.doc) compiledFrom.set(result.report, built.doc);
			song = result;
			if (result.report.ok) goodSong = result;
		} else {
			alone = result;
			if (result.report.ok) goodAlone = result;
		}
		if (result.report.ok && started && want === source) load(result);
		done();
	}

	// Another song resets what belonged to the last one, and the transport goes back to its start.
	let shownSong = '';
	$effect(() => {
		const key = openKey;
		untrack(() => {
			if (key === shownSong) return;
			const first = shownSong === '';
			shownSong = key;
			if (first) return;
			song = goodSong = null;
			sent.song = '';
			songTick = 0;
			selectedTrack = null;
			if (started && want === 'song') {
				engine.stop();
				engine.locate(0);
				engine.setLoop(0, 0);
			}
		});
	});

	// Another patch on screen: its probes go, and a patch heard on its own waits for its own image.
	let shownPatchId: string | null = null;
	$effect(() => {
		const id = shown?.patch.id ?? null;
		untrack(() => {
			if (id === shownPatchId) return;
			shownPatchId = id;
			probes = [];
			alone = goodAlone = null;
			sent.alone = '';
			if (live === 'alone') live = null;
		});
	});

	// What each image is made of. Reading it here is what runs these again when any of it changes, and an image whose request
	// hasn't changed isn't compiled again.
	$effect(() => {
		void [recipe, saved, timelineText, timelineName, library, assets, fetchingAssets];
		schedule('song');
	});
	$effect(() => {
		void [aloneWanted, shown, patchName, library, assets, fetchingAssets];
		schedule('alone');
	});

	// Makes `source` the image playing, then sends `then` once it is.
	function use(source: Source, then?: () => void) {
		if (want !== source) {
			if (live === 'song' && engineState) songTick = engineState.tick;
			want = source;
			waiting = source === 'song' ? [() => engine.locate(songTick)] : [];
			const good = source === 'song' ? goodSong : goodAlone;
			if (started && good) load(good);
		}
		if (then) {
			if (live === want) then();
			else waiting.push(then);
		}
		if (!started) void start();
	}

	async function start() {
		if (starting) return;
		starting = true;
		await engine.start();
		started = true;
		const good = want === 'song' ? goodSong : goodAlone;
		if (good) load(good);
	}

	function settle(report: CompileReport) {
		const doc = compiledFrom.get(report);
		const program = report.programs[0];
		if (!doc || !program) return;
		const { mix, params, inserts } = settlingWrites(doc, program, library);
		for (const { register, value } of mix) engine.setMix(register, value);
		for (const { track, param, value } of params) engine.setParam(track, param, value);
		for (const { insert, param, value } of inserts) engine.setInsertParam(insert, param, value);
	}

	// The song's length, so Play at its end starts it again.
	const length = $derived(goodSong?.report.programs[0]?.length_ticks ?? 0);

	function play() {
		use('song', () => {
			if (engineState && length > 0 && engineState.tick >= length && !engineState.playing) engine.locate(0);
			engine.play();
		});
	}

	// What the timeline's editors send. Notes and moves of the playhead bring the song back; a control dragged while a patch plays
	// on its own has nothing to move, and settles when its edit compiles.
	const controls: SongControls = {
		noteOn: (track, note, velocity) => use('song', () => engine.noteOn(track, note, velocity)),
		noteOff: (track, note) => use('song', () => engine.noteOff(track, note)),
		locate: (tick) => use('song', () => engine.locate(tick)),
		setLoop: (start, end) => engine.setLoop(start, end),
		setMix: (register, value) => live === 'song' && want === 'song' && engine.setMix(register, value),
		setParam: (track, param, value) => live === 'song' && want === 'song' && engine.setParam(track, param, value),
		setInsertParam: (insert, param, value) =>
			live === 'song' && want === 'song' && engine.setInsertParam(insert, param, value)
	};

	function patchNote(note: number, on: boolean) {
		const heard = hears;
		if (heard.kind === 'song')
			use('song', () => (on ? engine.noteOn(heard.track, note) : engine.noteOff(heard.track, note)));
		else if (heard.kind === 'alone') use('alone', () => (on ? engine.noteOn(0, note) : engine.noteOff(0, note)));
	}

	function patchParam(param: Param, value: number) {
		if (hears.kind === 'song' && live === 'song') engine.setParam(hears.track, param.id, value);
		else if (hears.kind === 'alone' && live === 'alone') engine.setParam(0, param.id, value);
	}

	// ------------------------------------------------------------------------------------------------------ probes, scopes

	let probes = $state<Probe[]>([]);
	const songTargets = $derived(live === 'song' ? targets : []);
	const maxProbes = $derived(
		hears.kind === 'none'
			? 0
			: Math.max(0, 8 - (hears.kind === 'alone' ? 2 : goodSong ? tapTargets(goodSong.report.programs[0]).length : 8))
	);

	// A probe follows the voice where keys are heard.
	$effect(() => {
		const id = shown?.patch.id;
		const voice =
			live === 'song' && hears.kind === 'song' ? { track: hears.track, slot: hears.slot } : { track: 0, slot: 0 };
		const list = probes;
		if (id) untrack(() => engine.setProbes(id, list, voice));
	});

	const patchScopes = $derived.by(() => {
		const found: { slot: number; label: string; ring: Ring }[] = [];
		const chain =
			live === 'alone' && hears.kind === 'alone'
				? 'master'
				: live === 'song' && hears.kind === 'song'
					? `track:${hears.id}`
					: null;
		const output = targets.find((t) => chain && t.chain === chain);
		if (output)
			found.push({
				slot: output.slot,
				label: hears.kind === 'alone' ? `${patchName} on its own` : output.label,
				ring: rings[output.slot]
			});
		for (const t of targets) if (!t.chain) found.push({ slot: t.slot, label: t.label, ring: rings[t.slot] });
		return found;
	});
	const masterRing = $derived.by(() => {
		const master = targets.find((t) => t.chain === 'master');
		return master ? rings[master.slot] : null;
	});

	// --------------------------------------------------------------------------------------------------------- the page

	const songErrors = $derived(song?.report.ok === false ? (song.report.errors ?? []) : []);
	const aloneErrors = $derived(aloneWanted && alone?.report.ok === false ? (alone.report.errors ?? []) : []);
	const errors = $derived(
		[...songErrors, ...aloneErrors].filter(
			(problem, index, all) =>
				all.findIndex((other) => other.where === problem.where && other.message === problem.message) === index
		)
	);
	const patchErrors = $derived.by(() => {
		const found = new Map<number, string>();
		for (const problem of errors) {
			const node = shown ? nodeOfError(problem.where, shown.patch.id) : null;
			if (node !== null) found.set(node, problem.message);
		}
		return found;
	});
	const inSong = $derived(shown ? goodSong?.report.sidecar?.[shown.patch.id] !== undefined : false);
	const patchNodes = $derived(
		shown ? (goodSong?.report.sidecar?.[shown.patch.id] ?? goodAlone?.report.sidecar?.[shown.patch.id]) : undefined
	);
	const patchFailed = $derived(inSong ? song?.report.ok === false : alone?.report.ok === false);
	const patchProblem = $derived(shown && !shown.example ? graphError(patchText) : '');

	function usedAs(use: PatchUse) {
		if (use.kind === 'insert') return `an insert on ${use.chain}`;
		const slot = use.track.slots.length > 1 ? `, slot ${use.slot + 1}` : '';
		return `the voice of ${use.track.name || `track ${use.track.id}`}${slot}`;
	}
	const exampleUse = $derived.by(() => {
		if (!recipe || !shown?.example) return '';
		const uses = patchUses(recipe.timeline, shown.patch.id);
		const what = `${shown.patch.name} is ${uses.length ? uses.map(usedAs).join(' and ') : 'not used by the timeline'}.`;
		return hears.kind === 'none' && uses.length ? `${what} Probes follow a voice, so an insert can't be probed.` : what;
	});

	const ppq = $derived(songDoc?.ppq ?? 480);
	const tick = $derived(live === 'song' ? (engineState?.tick ?? 0) : songTick);
	const position = $derived(
		`${Math.floor(tick / (ppq * BEATS_PER_BAR)) + 1}.${Math.floor((tick % (ppq * BEATS_PER_BAR)) / ppq) + 1}`
	);
	// To a tenth of a bpm, which a ramp needs and a held tempo doesn't show.
	const tempo = $derived(songDoc ? Math.round(tempoAt(songDoc.tempo, tick) * 10) / 10 : undefined);

	function open(change: Record<string, string | null>, replace = false) {
		void goto(withParams(search, change), { reset: false, replace });
	}

	// Choosing a track shows its patch, so a patch asked for by name gives way. The track an editor opens on doesn't count.
	function trackChosen(id: number | null, first: boolean) {
		selectedTrack = id;
		if (!first && (askedPatch !== null || askedPart !== null)) open({ patch: null, part: null }, true);
	}

	function patchOpened(id: string) {
		open(recipe ? { part: id, patch: null } : { patch: id, part: null });
	}

	let browserOpen = $state(true);
	let patchHeight = $state<number | null>(null); // Once dragged. Until then it is a share of the window.
	let upperHeight = $state(0);
	let active = $state<'patch' | 'timeline'>('timeline');
	let saveForm: HTMLFormElement;

	function resize(pixels: number) {
		patchHeight = Math.max(90, Math.min(1400, (patchHeight ?? upperHeight) + pixels));
		localStorage.setItem('modsynth.patch', String(patchHeight));
	}

	function unresize() {
		patchHeight = null;
		localStorage.removeItem('modsynth.patch');
	}

	function toggleBrowser() {
		browserOpen = !browserOpen;
		localStorage.setItem('modsynth.browser', browserOpen ? 'open' : 'closed');
	}

	function keydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key === 's') {
			event.preventDefault();
			if (dirty.size) saveForm.requestSubmit();
		}
	}

	function leaving(event: BeforeUnloadEvent) {
		if (dirty.size) event.preventDefault();
	}

	$effect(() => {
		if (form?.exported) downloadImage(form.exported.image, `${form.exported.name}.msimg`);
	});

	onMount(() => {
		const height = Number(localStorage.getItem('modsynth.patch'));
		if (height > 0) patchHeight = height;
		browserOpen = localStorage.getItem('modsynth.browser') !== 'closed';
		engine.onState = (s) => {
			engineState = s;
			// A shared LFO waits for the transport, and a patch on its own has no Play button.
			if (live === 'alone' && s.generation !== 0 && !s.playing) engine.play();
		};
		engine.onTap = (slot, block) => rings[slot].push(block.samples, block.start);
		engine.onTargets = (t) => (targets = t);
		engine.onRejected = (reason) => {
			rejected = reason;
			loading = null;
		};
		engine.onLive = (report) => {
			if (report === loading) loading = null;
			live = sourceOf.get(report) ?? null;
			if (live === 'song') settle(report);
			if (live === want) {
				const ready = waiting;
				waiting = [];
				for (const send of ready) send();
			}
		};
	});

	onDestroy(() => {
		for (const timer of Object.values(timers)) clearTimeout(timer);
		compiler?.close();
		engine.close();
	});
</script>

<svelte:head><title>{recipe?.entry.name ?? (timelineName || 'modsynth')} · modsynth</title></svelte:head>
<svelte:window onkeydown={keydown} onbeforeunload={leaving} />

<div class="workspace">
	<header class="transport">
		<button
			type="button"
			class="icon"
			aria-label="Browser"
			aria-pressed={browserOpen}
			title="Show or hide the browser"
			onclick={toggleBrowser}
		>
			<span aria-hidden="true">☰</span>
		</button>
		<strong class="brand">modsynth</strong>
		{#if !started}
			<button type="button" onclick={() => use(want)}>Start audio</button>
		{/if}
		<button type="button" class="play" onclick={play} disabled={!songDoc}><span aria-hidden="true">▶ </span>Play</button
		>
		<button type="button" onclick={() => engine.stop()} disabled={!started}
			><span aria-hidden="true">■ </span>Stop</button
		>
		<div class="readout" title="Bar and beat">
			<span class="big">{position}</span>
			<span class="muted">tick <span data-testid="tick">{tick}</span></span>
		</div>
		{#if tempo}<span class="readout muted" data-testid="tempo">{tempo} BPM</span>{/if}
		<div class="master"><Meter ring={masterRing} label="Master level" /></div>
		{#if engineState}
			<span class="muted state" data-testid="state" data-playing={engineState.playing}>
				<span data-testid="voices">{engineState.voices}</span> voices, generation
				<span data-testid="generation">{engineState.generation}</span>
				{#if engineState.guardTrips}, {engineState.guardTrips} guard trips{/if}
				{#if engineState.limited < 1}, <span class="limiting" data-testid="limiting"
						>limiting {(20 * Math.log10(engineState.limited)).toFixed(1)} dB</span
					>{/if}
				{#if LOAD_ERRORS[engineState.error]}, {LOAD_ERRORS[engineState.error]}{/if}
			</span>
		{/if}
		{#if live === 'alone' || (want === 'alone' && started)}
			<span class="alone" data-testid="playing-alone">Playing {patchName || 'a patch'} on its own</span>
		{/if}
		<span class="grow"></span>
		{#if dirty.size}<span class="muted" data-testid="unsaved">{dirty.size} unsaved</span>{/if}
		<form method="POST" action={actionOn(search, 'save')} use:enhance={saving} bind:this={saveForm}>
			<button disabled={!dirty.size} title="Save every unsaved patch and timeline (Ctrl+S)">Save</button>
		</form>
	</header>

	<div class="body" class:closed={!browserOpen}>
		{#if browserOpen}
			<Browser
				{search}
				examples={data.examples}
				timelines={data.library.timelines}
				patches={library}
				samples={data.library.samples}
				bundles={data.library.bundles}
				{dirty}
				openTimeline={saved?.id ?? null}
				openRecipe={recipe?.entry.name ?? null}
				shownPatch={shown?.patch.id ?? null}
			/>
		{/if}

		<main class="panels">
			<div
				class="upper"
				class:active={active === 'patch'}
				style:height={patchHeight === null ? '40%' : `${patchHeight}px`}
				bind:clientHeight={upperHeight}
				onpointerdowncapture={() => (active = 'patch')}
				onfocusincapture={() => (active = 'patch')}
				role="presentation"
			>
				<PatchPanel
					patch={shown?.patch ?? null}
					name={patchName}
					graph={shown?.patch.graph ?? null}
					text={patchText}
					readonly={!shown || shown.example || shownBuiltin}
					builtin={shownBuiltin}
					duplicate={duplicateId}
					{duplicating}
					dirty={patchDraft !== undefined}
					users={savedPatch?.users ?? []}
					parts={recipe && shown?.example ? recipe.patches : []}
					use={exampleUse}
					{search}
					catalog={data.catalog}
					library={shown?.example ? songPatches : library}
					assets={shown?.example && recipe ? recipe.assets : data.library.samples}
					nodes={patchNodes}
					failed={patchFailed}
					errors={patchErrors}
					{probes}
					{maxProbes}
					hearing={hears}
					scopes={patchScopes}
					active={active === 'patch'}
					onname={(name) => patchEdited({ name })}
					ongraph={(graph) => patchEdited({ graph })}
					ontext={(text) => patchEdited({ text })}
					onprobes={(next) => (probes = next)}
					onnote={patchNote}
					onparam={patchParam}
					onpart={(id) => open({ part: id, patch: null })}
				/>
			</div>

			<Splitter label="Resize the patch editor" onmove={resize} onreset={unresize} />

			<div
				class="lower"
				class:active={active === 'timeline'}
				onpointerdowncapture={() => (active = 'timeline')}
				onfocusincapture={() => (active = 'timeline')}
				role="presentation"
			>
				{#if songDoc}
					{#key openKey}
						<TimelineEditor
							doc={songDoc}
							patches={songPatches}
							program={goodSong?.report.programs[0] ?? null}
							errors={songErrors}
							{tick}
							targets={songTargets}
							{rings}
							engine={controls}
							readonly={recipe !== null}
							active={active === 'timeline'}
							tabs={[
								{ id: 'json', label: 'JSON', content: json },
								{ id: 'image', label: 'Image', content: image }
							]}
							{heading}
							onchange={(next) => timelineEdited({ text: JSON.stringify(next, null, 1) })}
							ontrack={trackChosen}
							onopen={patchOpened}
						/>
					{/key}
				{:else}
					<p class="muted empty">
						No timeline is open. Choose one or an example in the browser, or make a new one there.
					</p>
				{/if}
			</div>
		</main>
	</div>

	<footer class="status" aria-live="polite" aria-busy={busy} data-testid="status">
		{#if busy}<span class="muted">Compiling…</span>{/if}
		{#if form?.message}<span class="problem">{form.message}</span>{/if}
		{#if form?.saved}<span class="muted">Saved.</span>{/if}
		{#if renderProblem}<span class="problem">WAV export: {renderProblem}</span>{/if}
		{#if assetProblem}<span class="problem">{assetProblem}</span>{/if}
		{#if rejected}<span class="problem" data-testid="load-rejected">The engine refused this image: {rejected}.</span
			>{/if}
		{#if timelineParsed.error}<span class="problem">Timeline JSON: {timelineParsed.error}</span>{/if}
		{#if patchProblem}<span class="problem">Graph JSON: {patchProblem}</span>{/if}
		{#each errors as problem (`${problem.where} ${problem.message}`)}
			<span class="problem" data-testid="compile-error"><code>{problem.where}</code> {problem.message}</span>
		{/each}
		{#if goodSong && !busy && !form?.message && !form?.saved && !rejected && !assetProblem && !errors.length && !timelineParsed.error && !patchProblem}
			<span class="muted">{(goodSong.report.image_bytes / 1024).toFixed(1)} KB image</span>
		{/if}
		{#if !started}<span class="muted">Audio starts with Play, a key, or Start audio.</span>{/if}
	</footer>
</div>

{#if bundle}
	{#key bundle.id}
		<BundleDialog
			{bundle}
			timelines={data.library.timelines}
			{search}
			report={form?.exported?.report ?? null}
			onclose={() => open({ bundle: null })}
		/>
	{/key}
{/if}

{#snippet heading()}
	{#if recipe}
		<span class="kind">Example</span>
		<strong class="songname" title={recipe.entry.listen_for}>{recipe.entry.name}</strong>
		<span class="muted listen">{recipe.entry.listen_for}</span>
		{#if recipe.inLibrary}
			<a href={withParams(search, { timeline: recipe.inLibrary, recipe: null, part: null, patch: null })}
				>Open in the library</a
			>
		{:else}
			<form method="POST" action={actionOn(search, 'addRecipe')} use:enhance>
				<input type="hidden" name="name" value={recipe.entry.name} />
				<button>Add to library</button>
			</form>
		{/if}
	{:else if saved}
		<span class="kind">Timeline</span>
		<input
			class="songname"
			aria-label="Timeline name"
			value={timelineName}
			oninput={(e) => timelineEdited({ name: e.currentTarget.value })}
		/>
		{#if timelineDraft}<span class="dot" title="Unsaved changes">•</span>{/if}
		<form method="POST" action={actionOn(search, 'exportTimeline')} use:enhance={stay}>
			<input type="hidden" name="id" value={saved.id} />
			<button title="Compile the saved version to an image file">Export saved version</button>
		</form>
		<form method="POST" action={actionOn(search, 'deleteTimeline')} use:enhance={stay}>
			<input type="hidden" name="id" value={saved.id} />
			<input type="hidden" name="back" value={search} />
			<button>Delete timeline</button>
		</form>
	{/if}
	{#if recipe || saved}
		<button
			type="button"
			disabled={!goodSong || rendering !== null}
			title="Render the song as it now compiles to a WAV file"
			onclick={exportWav}>{rendering === null ? 'Export WAV' : `Rendering ${Math.round(rendering * 100)}%`}</button
		>
	{/if}
	{#if saved && !recipe}<span class="divider"></span>{/if}
{/snippet}

{#snippet json()}
	<div class="json">
		{#if recipe}
			<textarea
				aria-label="Timeline JSON"
				spellcheck="false"
				readonly
				value={JSON.stringify(recipe.project.programs[0].timeline, null, 1)}></textarea>
		{:else}
			<p class="muted">Edits compile as you type, and audio crossfades to them without stopping.</p>
			<textarea
				aria-label="Timeline JSON"
				spellcheck="false"
				value={timelineText}
				oninput={(e) => timelineEdited({ text: e.currentTarget.value })}></textarea>
		{/if}
	</div>
{/snippet}

{#snippet image()}
	{#if goodSong}<ReportPanel report={goodSong.report} />{:else}<p class="muted">Nothing has compiled yet.</p>{/if}
{/snippet}

<style>
	.workspace {
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		height: 100vh;
		overflow: hidden;
	}
	.transport {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.6rem;
		background: var(--panel);
		border-bottom: 1px solid var(--line);
		font-size: 0.82rem;
		min-width: 0;
	}
	.transport button {
		padding: 0.2rem 0.6rem;
	}
	.icon {
		font-size: 1rem;
		line-height: 1;
	}
	.brand {
		margin-right: 0.6rem;
	}
	.play {
		border-color: #238636;
	}
	.readout {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		padding: 0.1rem 0.6rem;
		background: #0d1117;
		border: 1px solid var(--line);
		border-radius: 5px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.big {
		font-size: 1rem;
		min-width: 3.5rem;
	}
	.master {
		width: 110px;
	}
	.state {
		white-space: nowrap;
		font-size: 0.75rem;
	}
	.alone {
		font-size: 0.75rem;
		color: #d29922;
		white-space: nowrap;
	}
	.limiting {
		color: #d29922;
	}
	.body {
		display: grid;
		grid-template-columns: 250px minmax(0, 1fr);
		min-height: 0;
	}
	.body.closed {
		grid-template-columns: minmax(0, 1fr);
	}
	.panels {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}
	.upper {
		flex: none;
		min-height: 90px;
		max-height: calc(100% - 160px);
		border-top: 2px solid transparent;
	}
	.lower {
		flex: 1;
		min-height: 0;
		padding: 0 0.6rem 0.4rem;
		border-top: 2px solid transparent;
	}
	.upper.active,
	.lower.active {
		border-top-color: #1f6feb80;
	}
	.empty {
		padding: 2rem;
		text-align: center;
	}
	.status {
		display: flex;
		gap: 0.6rem;
		align-items: center;
		flex-wrap: wrap;
		max-height: 5.5rem;
		overflow-y: auto;
		padding: 0.2rem 0.6rem;
		background: var(--panel);
		border-top: 1px solid var(--line);
		font-size: 0.78rem;
		min-height: 1.6rem;
	}
	.status .problem {
		margin: 0;
		padding: 0.1rem 0.5rem;
	}
	.kind {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
	}
	.songname {
		font-weight: 600;
	}
	input.songname {
		width: 11rem;
		padding: 0.1rem 0.4rem;
	}
	.listen {
		max-width: 22rem;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: 0.75rem;
	}
	.dot {
		color: #d29922;
	}
	.divider {
		width: 1px;
		align-self: stretch;
		background: var(--line);
		margin: 0 0.2rem;
	}
	.json {
		display: flex;
		flex-direction: column;
		height: 100%;
	}
	.json p {
		margin: 0 0 0.3rem;
		font-size: 0.78rem;
	}
	.json textarea {
		flex: 1;
		min-height: 0;
		resize: none;
	}
</style>
