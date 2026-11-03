<script lang="ts">
	import { applyAction, deserialize, enhance, type SubmitFunction } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
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
	import Browser, { type Section } from '#lib/Browser.svelte';
	import BrowserRail from '#lib/BrowserRail.svelte';
	import BundleDialog from '#lib/BundleDialog.svelte';
	import { Compiler, type Compiled } from '#lib/Compiler.ts';
	import { downloadBytes, downloadImage } from '#lib/Download.ts';
	import { renderWav } from '#lib/Render.ts';
	import { nodeOfError } from '#lib/GraphEdit.ts';
	import { History } from '#lib/History.ts';
	import Keyboard from '#lib/Keyboard.svelte';
	import Meter from '#lib/Meter.svelte';
	import PatchPanel from '#lib/PatchPanel.svelte';
	import ReportPanel from '#lib/ReportPanel.svelte';
	import { buildRequest, missingAssets, reachable, type AssetEntry, type CompileReport } from '#lib/Request.ts';
	import { referencedPatches, timelineSchema, type Graph, type Param, type Timeline } from '#lib/Schema.ts';
	import { Ring } from '#lib/ScopeMath.ts';
	import { label, matches, typingIn } from '#lib/Shortcuts.ts';
	import {
		BEATS_PER_BAR,
		mixWrites,
		patchUses,
		replacePatch,
		settlingWrites,
		soloed,
		tempoAt,
		trackKey,
		type PatchUse
	} from '#lib/TimelineEdit.ts';
	import TimelineEditor from '#lib/TimelineEditor.svelte';
	import ViewTabs from '#lib/ViewTabs.svelte';
	import {
		actionOn,
		draftKey,
		edited,
		graphError,
		hearing,
		isInsert,
		parseGraph,
		stay,
		trackAlone,
		viewOf,
		withDrafts,
		withParams,
		withView,
		type Draft,
		type View
	} from '#lib/Workspace.ts';

	let { data, form } = $props();

	// The engine plays one image at a time: the song, which is the open timeline or example, or the Patch view's patch on its
	// own, for a patch no track plays. What the page touches decides which: the transport and the timeline's editors want the
	// song, and the keys in the Patch view want wherever that patch is heard.
	type Source = 'song' | 'alone';

	// ------------------------------------------------------------------------------------------------------- what is open

	// The address as the address bar has it. A change of view, or of the patch the Patch view shows, moves it without a
	// navigation, since the server reads neither, so it can be newer than the address the page was loaded from.
	const address = $derived(page.shallow?.url ?? page.url);
	const search = $derived(address.search);
	// One of the two views fills the page. The other stays as it was left, with its scroll, zoom and choices, out of sight.
	const view = $derived(viewOf(search));
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
	const songName = $derived(recipe?.entry.name ?? timelineName);
	const songPatches = $derived(recipe ? recipe.patches : library);

	// The Patch view shows the patch asked for, and otherwise the chosen track's.
	let selectedTrack = $state<number | null>(null);
	const askedPatch = $derived(address.searchParams.get('patch'));
	const askedPart = $derived(address.searchParams.get('part'));
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

	const bundle = $derived(data.library.bundles.find((b) => b.id === address.searchParams.get('bundle')));

	// ------------------------------------------------------------------------------------------------------------ editing

	function put(key: string, draft: Draft | null) {
		const { [key]: _, ...rest } = drafts;
		drafts = draft ? { ...rest, [key]: draft } : rest;
	}

	// Each patch and timeline keeps its own undo history while others are open, of its text, so that an edit made in its JSON
	// is undone as one made in its editor is. How an edit came about decides what that history makes of it: one keystroke of a
	// run typed into the JSON joins the others, the run ends when the field is left, and a step undone or redone isn't an edit.
	type How = 'edit' | 'typing' | 'history';
	const history = new History<string>();

	// Puts an edit to a document's text in its history.
	function remember(key: string, now: string, next: string | undefined, how: How) {
		if (how === 'history' || next === undefined) return;
		if (next !== now) history.record(key, now, how === 'typing');
		else if (how === 'edit') history.end(key); // A field left, with nothing more typed into it
	}

	// Undo and Redo for the timeline open and the patch on screen, for any button or key that acts on one. An example and a
	// built-in patch can't be changed, so they have none.
	const timelineHistory = $derived(
		saved
			? history.of(draftKey('timeline', saved.id), {
					now: () => timelineText,
					apply: (text) => timelineEdited({ text }, 'history')
				})
			: null
	);
	const patchHistory = $derived(
		savedPatch && !savedPatch.builtin
			? history.of(draftKey('patch', savedPatch.id), {
					now: () => patchText,
					apply: (text) => patchEdited({ text }, 'history')
				})
			: null
	);

	function timelineEdited(change: { name?: string; text?: string }, how: How = 'edit') {
		if (!saved) return;
		const key = draftKey('timeline', saved.id);
		remember(key, timelineText, change.text, how);
		if (change.text === timelineText && change.name === undefined) return;
		const base = {
			kind: 'timeline' as const,
			id: saved.id,
			revision: saved.revision,
			name: saved.name,
			text: savedTimelineText
		};
		put(key, edited(base, drafts[key], change));
	}

	function patchEdited(change: { name?: string; text?: string; graph?: Graph }, how: How = 'edit') {
		if (!savedPatch || savedPatch.builtin) return;
		const key = draftKey('patch', savedPatch.id);
		const text = change.graph ? JSON.stringify(change.graph, null, 1) : change.text;
		remember(key, patchText, text, how);
		if (text === patchText && change.name === undefined) return;
		const base = {
			kind: 'patch' as const,
			id: savedPatch.id,
			revision: savedPatch.revision,
			name: savedPatch.name,
			text: savedPatchText
		};
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

	// A copy of a built-in patch takes its place in the open timeline, as an unsaved edit, so that changing it is heard where
	// it plays. Either way the copy is what the Patch view shows next.
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
			open({ patch: made.to, part: null }, false, 'patch');
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

	// A deleted patch or timeline takes its draft and its history with it.
	$effect(() => {
		const known = new Set([
			...data.library.patches.map((p) => draftKey('patch', p.id)),
			...data.library.timelines.map((t) => draftKey('timeline', t.id))
		]);
		untrack(() => {
			const gone = Object.keys(drafts).filter((key) => !known.has(key));
			if (gone.length) drafts = Object.fromEntries(Object.entries(drafts).filter(([key]) => known.has(key)));
			history.keep(known);
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
	let songTick = $state(0); // Where the song was when a patch on its own took over

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

	// Tracks soloed in the song that is open, which play while every other track is muted. Solo is a way of listening to the
	// song rather than part of it, so it is never saved: it goes into what is compiled and heard, and so into Export WAV, which
	// writes what is heard. A song opened starts with none.
	let solo = $state.raw<ReadonlySet<number>>(new Set());

	function toggleSolo(id: number) {
		const next = new Set(solo);
		if (!next.delete(id)) next.add(id);
		solo = next;
		// Heard at once through the mix registers, as a Mute is, until the compile that follows puts it in the image.
		const program = goodSong?.report.programs[0];
		if (!songDoc || !program) return;
		const heard = soloed(songDoc, next);
		for (const track of songDoc.tracks) {
			for (const { register, value } of mixWrites(heard, program, trackKey(track.id))) controls.setMix(register, value);
		}
	}

	// A soloed track that is deleted is soloed no more, so a track made later with its id doesn't start soloed.
	$effect(() => {
		const ids = new Set(songDoc?.tracks.map((track) => track.id));
		untrack(() => {
			if ([...solo].some((id) => !ids.has(id))) solo = new Set([...solo].filter((id) => ids.has(id)));
		});
	});

	// In the Song view the keys play the chosen track. While the song's image leaves it out, because it has no notes yet, they
	// play it on its own instead, as the Patch view plays a patch no track plays, so a new track sounds before its first note.
	const aloneTrack = $derived.by(() => {
		if (view !== 'song' || !saved || !songDoc || selectedTrack === null) return null;
		if (goodSong?.report.programs[0]?.tracks.some((t) => t.id === selectedTrack)) return null;
		return trackAlone(soloed(songDoc, solo), selectedTrack);
	});

	// A patch no track plays is compiled on its own too, so its errors and what compiled away show even when it can't be played.
	const aloneWanted = $derived(
		aloneTrack !== null ||
			(shown !== null &&
				!shown.example &&
				(hears.kind === 'alone' || (isInsert(shown.patch.graph) && !goodSong?.report.sidecar?.[shown.patch.id])))
	);

	function songRequest(): { request: string; doc?: Timeline } | null {
		if (recipe) {
			const [first, ...rest] = recipe.project.programs;
			const programs = [{ ...first, timeline: soloed(first.timeline as Timeline, solo) }, ...rest];
			return { request: JSON.stringify({ ...recipe.project, programs }) };
		}
		if (!saved || timelineParsed.value === null) return null;
		// A document that doesn't fit the schema goes whole, so that the compiler is what says what's wrong with it.
		const checked = timelineSchema.safeParse(timelineParsed.value);
		const reached = checked.success
			? reachable(referencedPatches(checked.data), library, assets)
			: { patches: library, assets };
		const timeline = checked.success ? soloed(timelineParsed.value as Timeline, solo) : timelineParsed.value;
		const programs = [{ id: saved.id, name: timelineName, timeline: timeline as Timeline }];
		return {
			request: buildRequest(reached.patches, reached.assets, programs),
			doc: checked.success ? soloed(checked.data, solo) : undefined
		};
	}

	// One track that plays the patch, kept by `live` though it has no notes, or for an insert, the master's only insert. In
	// the Song view, the chosen track as it is, with nothing placed.
	function aloneRequest(): string | null {
		if (aloneTrack) {
			const reached = reachable(referencedPatches(aloneTrack), library, assets);
			const programs = [{ id: 'preview', name: 'Preview', timeline: aloneTrack }];
			return buildRequest(reached.patches, reached.assets, programs, { live: true });
		}
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

	// Another song resets what belonged to the last one, and the transport goes back to its start. The chosen track is the new
	// timeline editor's to say, which it does as it opens, and that can come before this runs, so it isn't reset here.
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
			solo = new Set();
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

	// What the keys play on its own went from a patch to a track, or to another track: the image there was is no longer it.
	let aloneKey = '';
	$effect(() => {
		const key = aloneTrack ? `track:${aloneTrack.tracks[0].id}` : `patch:${shown?.patch.id ?? ''}`;
		untrack(() => {
			if (key === aloneKey) return;
			aloneKey = key;
			alone = goodAlone = null;
			sent.alone = '';
			if (live === 'alone') live = null;
		});
	});

	// What each image is made of. Reading it here is what runs these again when any of it changes, and an image whose request
	// hasn't changed isn't compiled again.
	$effect(() => {
		void [recipe, saved, timelineText, timelineName, library, assets, fetchingAssets, solo];
		schedule('song');
	});
	$effect(() => {
		void [aloneWanted, aloneTrack, shown, patchName, library, assets, fetchingAssets];
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

	const songPlaying = $derived(live === 'song' && !!engineState?.playing);

	// Stop, and pressed again once stopped, back to the start, as most DAWs do. A laptop may have no Home key.
	function stop() {
		if (songPlaying) engine.stop();
		else toStart();
	}

	// Back to the start of the song. A patch heard on its own keeps the engine, and the song starts there when it comes back.
	function toStart() {
		songTick = 0;
		if (live === 'song') engine.locate(0);
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

	// The top bar's keys play what the view on screen is about: the chosen track in the Song view, and in the Patch view its
	// patch, wherever it is heard. A track the image leaves out, because it has no notes yet, is played on its own.
	const chosenIndex = $derived(goodSong?.report.programs[0]?.tracks.find((t) => t.id === selectedTrack)?.index ?? null);
	const chosenName = $derived(songDoc?.tracks.find((t) => t.id === selectedTrack)?.name ?? '');
	const keysPlay = $derived(view === 'song' ? chosenIndex !== null || aloneTrack !== null : hears.kind !== 'none');
	const keysWhere = $derived.by(() => {
		if (view === 'song') {
			const name = chosenName || `track ${selectedTrack}`;
			if (chosenIndex !== null) return `Keys play ${name}.`;
			if (aloneTrack) return `Keys play ${name}, on its own until it has notes.`;
			if (selectedTrack === null) return 'Choose a track for the keys to play.';
			return songDoc?.tracks.find((t) => t.id === selectedTrack)?.slots.length
				? 'This track has no notes yet, so keys are silent.'
				: 'This track has no patch to play.';
		}
		if (hears.kind === 'song') return `Keys play ${patchName} on ${hears.name}, in the song.`;
		return hears.kind === 'alone' ? `Keys play ${patchName} on its own.` : hears.why;
	});

	// Where each key held down went, so it is let go there though the view or the chosen track changed meanwhile.
	const sounding = new Map<number, { source: Source; track: number }>();

	function keyNote(note: number, on: boolean) {
		if (!on) {
			const held = sounding.get(note);
			sounding.delete(note);
			// A note whose image has since given way to another went with it.
			if (held && want === held.source) use(held.source, () => engine.noteOff(held.track, note));
			return;
		}
		const heard = hears;
		const to: { source: Source; track: number } | null =
			view === 'song'
				? chosenIndex === null
					? aloneTrack
						? { source: 'alone', track: 0 }
						: null
					: { source: 'song', track: chosenIndex }
				: heard.kind === 'song'
					? { source: 'song', track: heard.track }
					: heard.kind === 'alone'
						? { source: 'alone', track: 0 }
						: null;
		if (!to) return;
		sounding.set(note, to);
		use(to.source, () => engine.noteOn(to.track, note));
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

	// Changes what the address says, and with it what the page shows. None of it is anything the server loads, so this moves
	// the address without a navigation, which would also move focus. A change of view is a step Back can undo.
	function open(change: Record<string, string | null>, replace = false, next: View = view) {
		void goto(withView(withParams(search, change), next), { shallow: true, replace });
	}

	function show(next: View) {
		if (next !== view) open({}, false, next);
	}

	// Choosing a track makes its patch the one the Patch view shows, so a patch asked for by name gives way. The track an editor
	// opens on doesn't count.
	function trackChosen(id: number | null, first: boolean) {
		selectedTrack = id;
		if (!first && (askedPatch !== null || askedPart !== null)) open({ patch: null, part: null }, true);
	}

	function patchOpened(id: string) {
		open(recipe ? { part: id, patch: null } : { patch: id, part: null }, false, 'patch');
	}

	// New patch for this track. The patch is saved at once, as the browser's New patch is, and the library loads again so it's
	// in it. Then the timeline editor puts it on the track, which is an unsaved edit like any other, and opens it.
	async function newPatchForTrack(name: string): Promise<string | null> {
		const body = new FormData();
		body.set('name', name);
		const response = await fetch(actionOn(search, 'createPatch'), {
			method: 'POST',
			body,
			headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
		});
		const result = deserialize(await response.text());
		const id = result.type === 'success' ? result.data?.created : undefined;
		if (typeof id !== 'string') {
			if (result.type === 'failure') await applyAction(result);
			return null;
		}
		await invalidateAll();
		return id;
	}

	// The browser sits beside the views on a wide screen, and folds to a rail of icons when asked. Below 1400 px there isn't the
	// room, so it is always the rail there, and opens over the views until something in it is chosen.
	const WIDE = 1400;
	let windowWidth = $state<number | undefined>(undefined);
	const wide = $derived(windowWidth === undefined || windowWidth >= WIDE);
	let browserOpen = $state(true); // On a wide screen, as last left
	let browserOver = $state(false); // On a narrow one
	let reveal = $state<Section | null>(null);
	const browserShown = $derived(wide ? browserOpen : browserOver);
	let saveForm: HTMLFormElement;

	function toggleBrowser(section: Section | null = null) {
		reveal = section;
		if (!wide) {
			browserOver = section !== null || !browserOver;
			return;
		}
		browserOpen = section !== null || !browserOpen;
		localStorage.setItem('modsynth.browser', browserOpen ? 'open' : 'closed');
	}

	// Over the views, the browser goes once it has done its job, or when the page is used instead.
	$effect(() => {
		void address.href;
		untrack(() => (browserOver = false));
	});

	function outsideBrowser(event: PointerEvent) {
		const target = event.target as Element;
		if (browserOver && !target.closest('.side, .rail, .menu')) browserOver = false;
	}

	// Undo and Redo, the top bar's and the keys, act on what the view on screen edits.
	const undoable = $derived(view === 'patch' ? patchHistory : timelineHistory);

	// A key a field takes, Mod+Z undoing what was typed into it among them, is the field's. So is one in a dialog.
	const keptBy = (target: EventTarget | null) => typingIn(target) || !!(target as Element | null)?.closest?.('dialog');

	// Keys that move around the page: ` flips views, B folds the browser, and Esc closes a browser open over the views. They
	// come before the window's keys, which leave a key alone once it has been used here.
	function pageKeys(event: KeyboardEvent) {
		if (event.repeat || keptBy(event.target)) return;
		if (matches(event, 'flip')) {
			event.preventDefault();
			show(view === 'song' ? 'patch' : 'song');
		} else if (matches(event, 'browser')) {
			event.preventDefault();
			toggleBrowser();
		} else if (matches(event, 'escape') && browserOver) {
			browserOver = false;
		}
	}

	function keydown(event: KeyboardEvent) {
		if (matches(event, 'save')) {
			event.preventDefault();
			if (dirty.size) saveForm.requestSubmit();
			return;
		}
		if (event.defaultPrevented || keptBy(event.target)) return;
		if (matches(event, 'play')) {
			event.preventDefault(); // Or a button with focus is pressed, and the roll scrolls
			if (event.repeat) return;
			if (songPlaying) engine.stop();
			else if (songDoc) play();
		} else if (matches(event, 'start')) {
			event.preventDefault();
			toStart();
		} else if (undoable && (matches(event, 'undo') || matches(event, 'redo'))) {
			event.preventDefault();
			if (matches(event, 'undo')) undoable.undo();
			else undoable.redo();
		}
	}

	// Some browsers press a button when Space comes back up, so that is the transport's too.
	function keyup(event: KeyboardEvent) {
		if (matches(event, 'play') && !keptBy(event.target)) event.preventDefault();
	}

	function leaving(event: BeforeUnloadEvent) {
		if (dirty.size) event.preventDefault();
	}

	$effect(() => {
		if (form?.exported) downloadImage(form.exported.image, `${form.exported.name}.msimg`);
	});

	onMount(() => {
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
<svelte:window onkeydown={keydown} onkeyup={keyup} onbeforeunload={leaving} bind:innerWidth={windowWidth} />
<svelte:document onkeydown={pageKeys} />

<div class="workspace" onpointerdowncapture={outsideBrowser} role="presentation">
	<header class="topbar">
		<button
			type="button"
			class="icon menu"
			aria-label="Browser"
			aria-pressed={browserShown}
			title={`Show or hide the browser (${label('browser')})`}
			onclick={() => toggleBrowser()}
		>
			<span aria-hidden="true">☰</span>
		</button>
		<ViewTabs {view} song={songName} patch={patchName} onview={show} />
		{#if !started}
			<button type="button" onclick={() => use(want)}>Start audio</button>
		{/if}
		<button type="button" class="play" onclick={play} disabled={!songDoc} title="Play (Space)"
			><span aria-hidden="true">▶ </span>Play</button
		>
		<button type="button" onclick={stop} disabled={!started} title="Stop. Pressed again, back to the start (Home)"
			><span aria-hidden="true">■ </span>Stop</button
		>
		<div class="readout" title="Bar and beat">
			<span class="big">{position}</span>
			<span class="muted">tick <span data-testid="tick">{tick}</span></span>
		</div>
		{#if tempo}<span class="readout muted" data-testid="tempo">{tempo} BPM</span>{/if}
		<div class="undo" role="group" aria-label="Undo and redo">
			<button
				type="button"
				class="icon"
				aria-label="Undo"
				title={`Undo the last edit to the ${view === 'song' ? 'song' : 'patch'} (${label('undo')})`}
				disabled={!undoable?.canUndo}
				onclick={() => undoable?.undo()}><span aria-hidden="true">↶</span></button
			>
			<button
				type="button"
				class="icon"
				aria-label="Redo"
				title={`Redo the last edit undone in the ${view === 'song' ? 'song' : 'patch'} (${label('redo')})`}
				disabled={!undoable?.canRedo}
				onclick={() => undoable?.redo()}><span aria-hidden="true">↷</span></button
			>
		</div>
		<Keyboard disabled={!keysPlay} where={keysWhere} onnote={keyNote} />
		<div class="master"><Meter ring={masterRing} label="Master level" /></div>
		<span class="grow"></span>
		{#if dirty.size}<span class="muted unsaved" data-testid="unsaved">{dirty.size} unsaved</span>{/if}
		<form method="POST" action={actionOn(search, 'save')} use:enhance={saving} bind:this={saveForm}>
			<button disabled={!dirty.size} title={`Save every unsaved patch and timeline (${label('save')})`}>Save</button>
		</form>
	</header>

	<div class="body" class:pinned={wide && browserOpen} class:unmeasured={windowWidth === undefined}>
		{#if windowWidth === undefined || (wide && browserOpen)}
			<div class="side">{@render browser()}</div>
		{/if}
		{#if windowWidth === undefined || !(wide && browserOpen)}
			<BrowserRail open={browserShown} onopen={(section) => toggleBrowser(section)} />
		{/if}
		{#if !wide && browserOver}
			<div class="side over">{@render browser()}</div>
		{/if}

		<main class="views">
			<div id="song-view" class="view" class:hidden={view !== 'song'} inert={view !== 'song'}>
				{#if songDoc}
					{#key openKey}
						<TimelineEditor
							doc={songDoc}
							patches={songPatches}
							program={goodSong?.report.programs[0] ?? null}
							errors={songErrors}
							{tick}
							playing={live === 'song' && !!engineState?.playing}
							targets={songTargets}
							{rings}
							engine={controls}
							history={timelineHistory}
							readonly={recipe !== null}
							active={view === 'song'}
							tabs={[
								{ id: 'json', label: 'JSON', content: json },
								{ id: 'image', label: 'Image', content: image }
							]}
							{heading}
							examples={data.examples}
							{solo}
							onchange={(next) => timelineEdited({ text: JSON.stringify(next, null, 1) })}
							ontrack={trackChosen}
							onopen={patchOpened}
							onnewpatch={newPatchForTrack}
							onsolo={toggleSolo}
							onkey={keyNote}
						/>
					{/key}
				{:else}
					<p class="muted empty">
						No timeline is open. Choose one or an example in the browser, or make a new one there.
					</p>
				{/if}
			</div>

			<div id="patch-view" class="view" class:hidden={view !== 'patch'} inert={view !== 'patch'}>
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
					active={view === 'patch'}
					song={songName}
					onsong={() => show('song')}
					onname={(name) => patchEdited({ name })}
					ongraph={(graph) => patchEdited({ graph })}
					ontext={(text, typing) => patchEdited({ text }, typing ? 'typing' : 'edit')}
					history={patchHistory}
					onprobes={(next) => (probes = next)}
					onparam={patchParam}
					onpart={(id) => open({ part: id, patch: null }, false, 'patch')}
				/>
			</div>
		</main>
	</div>

	<footer class="statusbar">
		<div class="status" aria-live="polite" aria-busy={busy} data-testid="status">
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
		</div>
		{#if live === 'alone' || (want === 'alone' && started)}
			<span class="alone" data-testid="playing-alone">Playing {patchName || 'a patch'} on its own</span>
		{/if}
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

{#snippet browser()}
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
		shownPatch={view === 'patch' ? (shown?.patch.id ?? null) : null}
		{reveal}
	/>
{/snippet}

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
				oninput={(e) => timelineEdited({ text: e.currentTarget.value }, 'typing')}
				onchange={(e) => timelineEdited({ text: e.currentTarget.value })}></textarea>
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
	/* One line for both views, which fits a 1280 px screen: long names give way first. */
	.topbar {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.3rem 0.6rem;
		background: var(--panel);
		border-bottom: 1px solid var(--line);
		font-size: 0.82rem;
		min-width: 0;
		white-space: nowrap;
	}
	.topbar > :global(*) {
		flex: none;
	}
	.topbar > :global(.views) {
		flex: 0 1 auto;
	}
	.topbar button {
		padding: 0.2rem 0.6rem;
	}
	.topbar .icon {
		font-size: 1rem;
		line-height: 1;
		padding: 0.15rem 0.45rem;
	}
	.undo {
		display: flex;
		gap: 0.2rem;
	}
	.play {
		border-color: #238636;
	}
	.readout {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		padding: 0.1rem 0.5rem;
		background: #0d1117;
		border: 1px solid var(--line);
		border-radius: 5px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.big {
		font-size: 1rem;
		min-width: 2.2rem;
	}
	.master {
		width: 72px;
	}
	.grow {
		flex: 1 1 0;
		min-width: 0;
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
	/* The browser beside the views, or its rail. Before the page knows how wide the window is, the width decides. */
	.body {
		position: relative;
		display: grid;
		grid-template-columns: 32px minmax(0, 1fr);
		min-height: 0;
	}
	.body.pinned {
		grid-template-columns: 250px minmax(0, 1fr);
	}
	.body.unmeasured > :global(.rail) {
		display: none;
	}
	@media (max-width: 1399.98px) {
		.body.unmeasured {
			grid-template-columns: 32px minmax(0, 1fr);
		}
		.body.unmeasured > .side {
			display: none;
		}
		.body.unmeasured > :global(.rail) {
			display: flex;
		}
	}
	.side {
		min-height: 0;
		min-width: 0;
	}
	/* On a narrow screen the browser opens over the views, beside its rail, rather than pushing them aside. */
	.side.over {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 32px;
		width: 250px;
		z-index: 20;
		box-shadow: 6px 0 18px #0009;
	}
	/* Both views take the same place, and the one not shown keeps its layout, so its scroll and sizes are there to come back to. */
	.views {
		display: grid;
		min-height: 0;
		min-width: 0;
	}
	.view {
		grid-area: 1 / 1;
		min-height: 0;
		min-width: 0;
	}
	#song-view {
		padding: 0 0.6rem 0.4rem;
	}
	.view.hidden {
		visibility: hidden;
	}
	.empty {
		padding: 2rem;
		text-align: center;
	}
	.statusbar {
		display: flex;
		gap: 0.6rem;
		align-items: center;
		max-height: 5.5rem;
		overflow-y: auto;
		padding: 0.2rem 0.6rem;
		background: var(--panel);
		border-top: 1px solid var(--line);
		font-size: 0.78rem;
		min-height: 1.6rem;
	}
	.status {
		flex: 1;
		display: flex;
		gap: 0.6rem;
		align-items: center;
		flex-wrap: wrap;
		min-width: 0;
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
