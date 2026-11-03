<script lang="ts">
	import { applyAction, deserialize, enhance, type SubmitFunction } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount, tick as rendered, untrack } from 'svelte';
	import {
		AudioEngine,
		LOAD_ERRORS,
		tapTargets,
		type EngineState,
		type PlayedKey,
		type Probe,
		type SongControls,
		type TapTarget
	} from '#lib/AudioEngine.ts';
	import type { Loop } from '#lib/Arrangement.svelte';
	import Browser, { type Section } from '#lib/Browser.svelte';
	import BrowserRail from '#lib/BrowserRail.svelte';
	import BundleDialog from '#lib/BundleDialog.svelte';
	import CompileLight from '#lib/CompileLight.svelte';
	import { Compiler, type Compiled } from '#lib/Compiler.ts';
	import DocumentMenu from '#lib/DocumentMenu.svelte';
	import { downloadBytes, downloadImage } from '#lib/Download.ts';
	import { renderWav } from '#lib/Render.ts';
	import { nodeOfError } from '#lib/GraphEdit.ts';
	import { History } from '#lib/History.ts';
	import Keyboard from '#lib/Keyboard.svelte';
	import Meter from '#lib/Meter.svelte';
	import { friendlyName } from '#lib/NodeHelp.ts';
	import PatchPanel from '#lib/PatchPanel.svelte';
	import { placeOf, placeWords, sizeOf, type Names, type Problem } from '#lib/Problems.ts';
	import ReportPanel from '#lib/ReportPanel.svelte';
	import { buildRequest, missingAssets, reachable, type AssetEntry, type CompileReport } from '#lib/Request.ts';
	import { referencedPatches, timelineSchema, type Graph, type Param, type Timeline } from '#lib/Schema.ts';
	import { Ring } from '#lib/ScopeMath.ts';
	import { label, matches, typingIn } from '#lib/Shortcuts.ts';
	import { newTake, recordNote, snapPlayed, type Stamp, type Take } from '#lib/Recording.ts';
	import {
		BEATS_PER_BAR,
		mixWrites,
		patchUses,
		position,
		replacePatch,
		settlingWrites,
		soloed,
		tempoAt,
		trackKey,
		type PatchUse
	} from '#lib/TimelineEdit.ts';
	import TimelineEditor from '#lib/TimelineEditor.svelte';
	import { gliding, parseBpm, parsePosition, shownTempo, tempoTyped, tempoWords, wholeSong } from '#lib/Transport.ts';
	import { playedBy, playedOn, usedBy } from '#lib/UsedBy.ts';
	import ViewTabs from '#lib/ViewTabs.svelte';
	import {
		actionOn,
		draftKey,
		edited,
		graphError,
		hearing,
		isInsert,
		parseGraph,
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
	// What Edit a copy or Duplicate copies: the patch on screen, or for an example's patch, the built-in one it is in every
	// library as.
	const duplicateId = $derived(
		!shown ? null : shown.example ? (recipe?.builtins[shown.patch.id] ?? null) : savedPatch ? savedPatch.id : null
	);
	// Edit a copy puts the copy where the original plays. For an example's patch, or a built-in one the example plays, that is
	// the example's copy in the library, which comes with the patch's copy if it isn't there yet.
	const copyInto = $derived(
		recipe && duplicateId && (shown?.example || Object.values(recipe.builtins).includes(duplicateId))
			? { name: recipe.entry.name, inLibrary: recipe.inLibrary !== null }
			: null
	);
	// What each timeline with unsaved edits plays now: the open one as drawn, and another as its text says, or as saved while
	// that text isn't a timeline. The Patch view's "used by" counts them so, which agrees with what the keys play.
	const draftPlays = new WeakMap<Draft, string[] | null>();
	const nowPlaying = $derived.by(() => {
		const now = new Map<string, { name: string; patches: string[] }>();
		for (const draft of Object.values(drafts)) {
			if (draft.kind !== 'timeline') continue;
			const drawn = saved?.id === draft.id ? timelineDoc : null;
			if (!drawn && !draftPlays.has(draft)) draftPlays.set(draft, playedBy(draft.text));
			const patches = drawn ? referencedPatches(drawn) : draftPlays.get(draft);
			const listed = data.library.timelines.find((t) => t.id === draft.id);
			now.set(draft.id, { name: draft.name, patches: patches ?? listed?.patches ?? [] });
		}
		return now;
	});
	const shownUsers = $derived(savedPatch ? usedBy(savedPatch.id, library, data.library.timelines, nowPlaying) : []);
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

	// Edit a copy, and Duplicate. A copy of a built-in patch takes its place on every track and insert of the open timeline that
	// played it, as an unsaved edit, so changing it is heard where it plays and Undo in the Song view takes it back. From an
	// example, which can't change, that timeline is the example's copy in the library, which opens in the Song view on the track
	// the keys played the original on. Either way the copy is what the Patch view shows next.
	const duplicating: SubmitFunction = () => {
		const preferred = selectedTrack; // The track chosen, which the keys play the patch on if it plays it
		return async ({ result, update }) => {
			const made =
				result.type === 'success'
					? (result.data?.duplicated as { from: string; to: string; timeline?: string | null } | undefined)
					: undefined;
			if (!made?.timeline) await update({ reset: false });
			if (!made) return;
			if (made.timeline) {
				await copyInLibrary(made.from, made.to, made.timeline, preferred);
				return;
			}
			const original = data.library.patches.find((p) => p.id === made.from);
			if (original?.builtin && saved && timelineDoc) swapIn(made.from, made.to);
			void open({ patch: made.to, part: null }, false, 'patch');
		};
	};

	// Puts a copy in place of the original in the open timeline, as one edit. Says whether it played the original at all.
	function swapIn(from: string, to: string): boolean {
		if (!timelineDoc || !referencedPatches(timelineDoc).includes(from)) return false;
		timelineEdited({ text: JSON.stringify(replacePatch(timelineDoc, from, to), null, 1) });
		return true;
	}

	// An example's patch copied: the example's copy in the library opens, with the patch's copy in place of the original, on
	// the track the keys played it on, and the Patch view shows the copy. The library loads again, so the copy, the timeline
	// and the copy's recordings are all there before anything compiles.
	async function copyInLibrary(from: string, to: string, timeline: string, preferred: number | null) {
		const opening = withParams(search, { timeline, recipe: null, part: null, patch: null });
		await goto(withView(opening, 'patch'), { refreshAll: true });
		await rendered();
		if (saved?.id !== timeline || !timelineDoc) return;
		const track = playedOn(timelineDoc, from, preferred);
		if (!swapIn(from, to)) {
			const original = data.library.patches.find((p) => p.id === from)?.name ?? from;
			const listed = data.library.timelines.filter((t) => t.id === timeline);
			say(
				usedBy(from, library, listed, nowPlaying).length
					? `The copy is on no track: ${timelineName} plays ${original} only inside another patch.`
					: `The copy is on no track: ${timelineName} no longer plays ${original}.`
			);
		}
		// Choosing a track shows its patch in the Patch view, so the copy is asked for once the track is chosen.
		if (track !== null) {
			songEditor?.reveal({ track, clip: timelineDoc.tracks.find((t) => t.id === track)?.placements[0]?.clip });
			await rendered();
		}
		await open({ patch: to, part: null }, true, 'patch');
	}

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
	let compiles = $state(0); // Sent to the compiler since the page opened, so a test can tell an edit's compile has started
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
		// While a take runs the image keeps every track, as the keys' own image does, so a track recorded into from nothing
		// plays in the song from its first note.
		return {
			request: buildRequest(reached.patches, reached.assets, programs, { live: keepTracks }),
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
		compiles++;
		const from = openKey;
		compiler ??= new Compiler();
		const result = await compiler.compile(built.request, source);
		if (!result || (source === 'song' && from !== openKey)) return done();
		sourceOf.set(result.report, source);
		if (source === 'song') {
			if (built.doc) compiledFrom.set(result.report, built.doc);
			song = result;
			if (result.report.ok) goodSong = result;
			else if (take && takePhase === 'arming') {
				take = null;
				say("The song doesn't compile, so it can't be recorded into. The light says what's wrong.");
			}
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
			if (take) endTake();
			take = null;
			song = goodSong = liveSong = null;
			sent.song = '';
			songTick = 0;
			solo = new Set();
			loop = null;
			looping = false;
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
		void [recipe, saved, timelineText, timelineName, library, assets, fetchingAssets, solo, keepTracks];
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
			for (const ring of rings) ring.mark(); // Meters hold the loudest since Play
			engine.play();
		});
	}

	const songPlaying = $derived(live === 'song' && !!engineState?.playing);

	// Stop, and pressed again once stopped, back to the start, as most DAWs do. A laptop may have no Home key.
	function stop() {
		if (take) {
			endTake();
			engine.stop();
		} else if (songPlaying) engine.stop();
		else toStart();
	}

	// Back to the start of the song. A patch heard on its own keeps the engine, and the song starts there when it comes back.
	function toStart() {
		songTick = 0;
		if (live === 'song') engine.locate(0);
	}

	// The playhead moved by the top bar's position: shown there at once, and where the song starts if a patch on its own is
	// playing now.
	function moveTo(at: number) {
		songTick = at;
		controls.locate(at);
	}

	// The loop is the editor's, not the song's: it isn't saved, and another song starts without one. The top bar turns it on and
	// off, and the arrangement's strip shows it, draws it and moves it. Until one is drawn it is the whole song, which follows the
	// song as it grows, so null stands for that.
	let loop = $state.raw<Loop | null>(null);
	let looping = $state(false);
	let loopSent = false;

	function setLoop(next: Loop | null, on: boolean) {
		loop = next;
		looping = on;
	}

	const toggleLoop = () => setLoop(loop, !looping);

	// What the engine loops, sent again with each new image, which can be in a new engine. A loop drawn before audio starts
	// reaches the engine this way too.
	$effect(() => {
		void targets;
		const range = looping && songDoc ? (loop ?? wholeSong(songDoc)) : null;
		untrack(() => {
			if (range) engine.setLoop(range.start, range.end);
			else if (loopSent) engine.setLoop(0, 0);
			loopSent = range !== null;
		});
	});

	// What the timeline's editors send. Notes and moves of the playhead bring the song back; a control dragged while a patch plays
	// on its own has nothing to move, and settles when its edit compiles.
	const controls: SongControls = {
		noteOn: (track, note, velocity) => use('song', () => engine.noteOn(track, note, velocity)),
		noteOff: (track, note) => use('song', () => engine.noteOff(track, note)),
		locate: (tick) => use('song', () => engine.locate(tick)),
		setLoop: (start, end) => setLoop(end > start ? { start, end } : null, end > start),
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
			if (take && take.track === selectedTrack) return `Keys play ${name}, and the take records them.`;
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
	const sounding = new Map<number, { source: Source; track: number; stamped: boolean }>();

	// While step entry is on, the keys in the Song view also write into the clip in the roll, which they can do on a track
	// that is silent because it has no notes yet.
	let songEditor = $state<ReturnType<typeof TimelineEditor>>();
	let stepWriting = $state(false);

	function keyNote(note: number, on: boolean, at?: number) {
		// What is written doesn't change what is heard. A key let go goes to step entry whatever the view, since it may have
		// started a chord there, which waits for it. While a take runs, the take writes what is played instead.
		if (!on || (view === 'song' && stepWriting && !take)) songEditor?.stepKey(note, on);
		soundNote(note, on, at);
	}

	// Plays a note where the view on screen is heard, which is all the roll's audition of a track the image leaves out asks
	// for: it mustn't reach step entry, which would write it.
	function soundNote(note: number, on: boolean, at?: number) {
		if (!on) {
			const held = sounding.get(note);
			sounding.delete(note);
			// A note whose image has since given way to another went with it. One a take heard go down, it hears come up.
			const stamp = held?.stamped ? (at ?? performance.now()) : undefined;
			if (held && want === held.source) use(held.source, () => engine.noteOff(held.track, note, stamp));
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
		// A take records the keys that play its track, from the count-in on, and stamps them with when they were pressed.
		const stamped = at !== undefined && takePhase === 'started' && to.source === 'song' && to.track === takeIndex;
		sounding.set(note, { ...to, stamped });
		use(to.source, () => engine.noteOn(to.track, note, 100, stamped ? at : undefined));
	}

	// ----------------------------------------------------------------------------------------------------------- recording

	// Record, or Shift+R, records with snap, as Live and Logic do: a bar is counted in with a click unless the song is playing
	// already, and then what the keys play into the chosen track is written as it is played, each note's start and length snapped
	// to the roll's Snap, at the Vel velocity. Pressed again it stops recording and the song plays on, and Stop or Space stops
	// both. A take is one undo step. The rules are Recording.ts's, and the timing the worklet's, which stamps each key with where
	// the song was when what was playing then was heard, so latency moves nothing.
	type Taking = { track: number; key: string; grid: number; velocity: number; write: Take; held: Map<number, Stamp> };
	let take = $state.raw<Taking | null>(null);
	let takePhase = $state<'arming' | 'started' | 'ending'>('arming');
	let shownClip: string | null = null; // The clip the take last wrote into, which the roll shows
	let liveSong = $state.raw<CompileReport | null>(null); // The song's image that is playing, once one is
	const keepTracks = $derived(take !== null);
	const takeIndex = $derived(
		take ? (goodSong?.report.programs[0]?.tracks.find((t) => t.id === take!.track)?.index ?? null) : null
	);
	const takeTrack = $derived(timelineDoc?.tracks.find((t) => t.id === selectedTrack));
	const recordWhy = $derived.by(() => {
		if (recipe)
			return "An example can't be recorded into. Add it to the library from its ▾ menu to record into a copy.";
		if (view !== 'song') return 'Recording writes into the chosen track, in the Song view.';
		if (!saved || !timelineDoc) return 'Open a timeline to record into.';
		if (!takeTrack) return 'Choose a track to record into.';
		if (!takeTrack.slots.length) return 'This track has no patch to play.';
		return '';
	});
	const recordState = $derived.by(() => {
		if (!take) return 'off';
		if (takePhase === 'arming') return 'arming';
		const now = engineState?.recording ?? 0;
		return now === 1 ? 'counting' : now === 2 ? 'recording' : 'arming';
	});
	const recordTitle = $derived.by(() => {
		const key = label('record');
		if (recordState === 'counting') return `Counting in. Record (${key}) again, Stop or Space stops.`;
		if (recordState === 'recording')
			return `Recording. Record (${key}) again stops recording, and Stop or Space stops both.`;
		if (recordWhy && !take) return `Record (${key}). ${recordWhy}`;
		return (
			`Record (${key}): a bar counted in, then what the keys play is written into the chosen track, snapped to ` +
			'Snap at the Vel velocity. A loop records round it, each pass adding to the clip.'
		);
	});

	function record() {
		if (take) return endTake();
		if (recordWhy || !saved || selectedTrack === null) return;
		const settings = songEditor?.takeSettings() ?? { grid: ppq / 4, velocity: 100 };
		const key = draftKey('timeline', saved.id);
		history.end(key); // A take is a step of its own
		shownClip = null;
		takePhase = 'arming';
		take = { track: selectedTrack, key, ...settings, write: newTake(selectedTrack), held: new Map() };
		use('song');
	}

	// The take starts once an image that plays its track is playing: at once for a track with notes, and for one without,
	// once the image that keeps every track has compiled.
	$effect(() => {
		const ready =
			take !== null &&
			takePhase === 'arming' &&
			live === 'song' &&
			!!liveSong?.programs[0]?.tracks.some((t) => t.id === take!.track);
		if (ready) untrack(beginTake);
	});

	function beginTake() {
		if (!take || !songDoc) return;
		const doc = songDoc;
		takePhase = 'started';
		songEditor?.stopStepping();
		if (engineState?.playing) {
			engine.record(doc.ppq, BEATS_PER_BAR, 0, engineState.tick);
			return;
		}
		// With a loop on, the take starts at its start, so the first pass is a whole one.
		const start = looping ? (loop ?? wholeSong(doc)).start : tick;
		if (start !== engineState?.tick) engine.locate(start);
		for (const ring of rings) ring.mark(); // Meters hold the loudest since the take began, as they do since Play
		engine.record(doc.ppq, BEATS_PER_BAR, tempoAt(doc.tempo, start), start);
	}

	// Recording stops. The worklet says where the song was when it did, for the notes still held, and then the take is done.
	function endTake() {
		if (!take) return;
		if (takePhase === 'arming') {
			take = null;
			return;
		}
		if (takePhase === 'started') engine.stopRecording();
		takePhase = 'ending';
	}

	function takeEnded(at: Stamp) {
		const ending = take;
		if (!ending) return;
		for (const [note, on] of ending.held) writeTaken(ending, note, on, at);
		history.end(ending.key);
		take = null;
	}

	function keyStamped(key: PlayedKey) {
		const t = take;
		if (!t || takePhase === 'arming') return;
		if (key.on) {
			t.held.set(key.note, { tick: key.tick, elapsed: key.elapsed });
			return;
		}
		const on = t.held.get(key.note);
		if (!on) return;
		t.held.delete(key.note);
		writeTaken(t, key.note, on, key);
	}

	// A note played, snapped and written where the take is: one edit of a run, which undoes in one step with the take's others.
	function writeTaken(t: Taking, note: number, on: Stamp, off: Stamp) {
		if (!saved || !timelineDoc || draftKey('timeline', saved.id) !== t.key) return;
		const round = looping ? (loop ?? wholeSong(timelineDoc)) : null;
		const snapped = snapPlayed({ note, vel: t.velocity, on, off }, t.grid, round);
		if (!snapped) return;
		const done = recordNote(timelineDoc, t.write, snapped);
		if (!done) return;
		t.write = done.take;
		timelineEdited({ text: JSON.stringify(done.doc, null, 1) }, 'typing');
		if (done.clip !== shownClip) {
			shownClip = done.clip;
			const clip = done.clip;
			void rendered().then(() => songEditor?.reveal({ track: t.track, clip }));
		}
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

	// ---------------------------------------------------------------------------------------------- the compile light

	// What the light lists. Each problem says where it is in words, and its link goes there: a node's opens the Patch view with the
	// node chosen, and a track's, a clip's or the mix's opens the Song view with it chosen.
	let nodeAsked = $state.raw<{ node: number } | null>(null);

	const names: Names = {
		patch: (id) => (songPatches.find((p) => p.id === id) ?? library.find((p) => p.id === id))?.name,
		node: (patch, id) => {
			const graph = (songPatches.find((p) => p.id === patch) ?? library.find((p) => p.id === patch))?.graph;
			const node = graph?.nodes.find((n) => n.id === id);
			return node ? `${friendlyName(node.type)} ${node.id}` : undefined;
		},
		track: (id) => songDoc?.tracks.find((t) => t.id === id)?.name
	};

	async function openSong(place: { track?: number | null; clip?: string | null; tab?: string }) {
		await show('song');
		songEditor?.reveal(place);
	}

	function openNode(patch: string, node: number | null) {
		if (node !== null) nodeAsked = { node };
		if (shown?.patch.id === patch) void show('patch');
		else patchOpened(patch);
	}

	function goTo(where: string): (() => void) | undefined {
		const place = placeOf(where);
		if (!place) return undefined;
		if (place.kind === 'patch') return () => openNode(place.patch, place.node);
		return () => void openSong({ track: place.track, clip: place.clip, tab: place.mix ? 'mixer' : undefined });
	}

	const warnings = $derived(song?.report.ok ? (song.report.programs[0]?.warnings ?? []) : []);
	const problems = $derived.by((): Problem[] => {
		const list: Problem[] = [];
		if (assetProblem) list.push({ key: 'assets', severity: 'error', place: 'Recordings', message: assetProblem });
		if (rejected) {
			const message = `The engine refused this image: ${rejected}.`;
			list.push({ key: 'rejected', severity: 'error', place: 'Engine', message, testid: 'load-rejected' });
		}
		const loadError = engineState ? LOAD_ERRORS[engineState.error] : '';
		if (loadError) list.push({ key: 'load', severity: 'error', place: 'Engine', message: loadError });
		if (timelineParsed.error) {
			const go = () => void openSong({ tab: 'json' });
			list.push({ key: 'timeline-json', severity: 'error', place: 'Timeline JSON', message: timelineParsed.error, go });
		}
		if (patchProblem) {
			const go = () => void show('patch');
			list.push({ key: 'graph-json', severity: 'error', place: 'Graph JSON', message: patchProblem, go });
		}
		for (const { where, message } of errors) {
			const place = placeWords(where, names);
			list.push({
				key: `${where} ${message}`,
				severity: 'error',
				place,
				message,
				testid: 'compile-error',
				go: goTo(where)
			});
		}
		warnings.forEach(({ where, message }, index) => {
			const place = placeWords(where, names);
			list.push({ key: `warning ${index}`, severity: 'warning', place, message, go: goTo(where) });
		});
		if (engineState?.guardTrips) {
			const message = `A voice made a value that isn't a number ${engineState.guardTrips} times, and its guard silenced it.`;
			list.push({ key: 'guards', severity: 'warning', place: 'Engine', message });
		}
		return list;
	});
	const imageSize = $derived(
		goodSong ? sizeOf(goodSong.report.image_bytes) : goodAlone ? sizeOf(goodAlone.report.image_bytes) : ''
	);

	// ------------------------------------------------------------------------------------------------------------ messages

	// Short messages over the foot of the page: what an action did, or why it didn't. One that says something went wrong stays
	// until it is shut or the next action, and the rest go after a few seconds. A screen reader hears each, and hears how many
	// problems the light shows once an edit has compiled, when that changes.
	let note = $state<string | null>(null);
	let noteTimer: ReturnType<typeof setTimeout> | undefined;
	let shutForm = $state.raw<unknown>(null); // The action result whose message was shut

	function say(text: string) {
		note = text;
		clearTimeout(noteTimer);
		noteTimer = setTimeout(() => (note = null), 4000);
	}

	$effect(() => {
		const result = form;
		untrack(() => {
			if (result?.saved) say('Saved.');
		});
	});
	const formProblem = $derived(form?.message && shutForm !== form ? form.message : '');

	const problemCount = $derived.by(() => {
		if (busy) return null;
		const errorCount = problems.filter((problem) => problem.severity === 'error').length;
		if (errorCount) return `${errorCount} ${errorCount === 1 ? 'problem' : 'problems'}`;
		return problems.length ? `${problems.length} ${problems.length === 1 ? 'warning' : 'warnings'}` : 'No problems';
	});
	let heard = $state('');
	$effect(() => {
		const now = problemCount;
		if (now !== null) untrack(() => (heard = now));
	});

	// The menu's Rename goes to the name, in the Song view's toolbar.
	let nameField = $state<HTMLInputElement>();
	async function rename() {
		await show('song');
		await rendered();
		nameField?.select();
	}

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

	// The position and the tempo are fields. Typing a position moves the playhead, and typing a tempo changes the tempo in effect
	// at the playhead, the one change of the song's that is playing there. While one is typed into, the playhead moving on
	// doesn't overwrite what is typed. An example can't change, so neither can be typed into there.
	let typedPosition = $state<string | null>(null);
	let typedTempo = $state<string | null>(null);
	const positionText = $derived(typedPosition ?? position(tick, ppq));
	const tempoText = $derived(typedTempo ?? (songDoc ? String(shownTempo(songDoc.tempo, tick, false)) : ''));
	const tempoTitle = $derived(songDoc ? tempoWords(songDoc.tempo, tick, ppq) : 'The tempo, once a song is open');
	const glide = $derived(songDoc ? gliding(songDoc.tempo, tick) : null);

	// Enter or leaving the field sends what was typed, and Esc puts back what was there.
	function fieldKeys(event: KeyboardEvent & { currentTarget: HTMLInputElement }, cancel: () => void) {
		if (event.key === 'Enter') {
			event.preventDefault();
			event.currentTarget.blur();
		} else if (matches(event, 'escape')) {
			event.preventDefault();
			cancel();
			event.currentTarget.blur();
		}
	}

	function positionTyped() {
		const text = typedPosition;
		typedPosition = null;
		if (text === null || !songDoc || recipe) return;
		const at = parsePosition(text, ppq);
		if (at === null) say(`“${text.trim()}” isn't a position. Type bar.beat.tick, as 3.2.000, or a bar.`);
		else if (at !== tick) moveTo(at);
	}

	function tempoEntered() {
		const text = typedTempo;
		typedTempo = null;
		if (text === null || !saved || !timelineDoc) return;
		const bpm = parseBpm(text);
		if (bpm === null) say(`“${text.trim()}” isn't a tempo. Type beats a minute, from 1 to 1000.`);
		else timelineEdited({ text: JSON.stringify(tempoTyped(timelineDoc, tick, bpm), null, 1) });
	}

	// Changes what the address says, and with it what the page shows. None of it is anything the server loads, so this moves
	// the address without a navigation, which would also move focus. A change of view is a step Back can undo.
	function open(change: Record<string, string | null>, replace = false, next: View = view) {
		return goto(withView(withParams(search, change), next), { shallow: true, replace });
	}

	async function show(next: View) {
		if (next !== view) await open({}, false, next);
	}

	// Choosing a track makes its patch the one the Patch view shows, so a patch asked for by name gives way. The track an editor
	// opens on doesn't count.
	function trackChosen(id: number | null, first: boolean) {
		selectedTrack = id;
		if (!first && (askedPatch !== null || askedPart !== null)) void open({ patch: null, part: null }, true);
	}

	function patchOpened(id: string) {
		void open(recipe ? { part: id, patch: null } : { patch: id, part: null }, false, 'patch');
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
			void show(view === 'song' ? 'patch' : 'song');
		} else if (matches(event, 'browser')) {
			event.preventDefault();
			toggleBrowser();
		} else if (matches(event, 'escape') && browserOver) {
			event.preventDefault(); // Esc closes one thing at a time, and the browser over the views is the nearest
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
			if (take) stop();
			else if (songPlaying) engine.stop();
			else if (songDoc) play();
		} else if (view === 'song' && matches(event, 'record')) {
			event.preventDefault();
			if (!event.repeat) record();
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
		engine.onTap = (slot, block) => rings[slot].push(block.samples, block.start, block.generation);
		engine.onTargets = (t) => (targets = t);
		engine.onRejected = (reason) => {
			rejected = reason;
			loading = null;
		};
		engine.onPlayed = keyStamped;
		engine.onTakeEnd = takeEnded;
		engine.onLive = (report) => {
			if (report === loading) loading = null;
			live = sourceOf.get(report) ?? null;
			if (live === 'song') liveSong = report;
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
		clearTimeout(noteTimer);
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
		<ViewTabs
			{view}
			song={songName}
			patch={patchName}
			alone={live === 'alone' || (want === 'alone' && started)}
			menu={recipe || saved ? songMenu : undefined}
			onview={show}
		/>
		{#if !started}
			<button
				type="button"
				title="Browsers make no sound until the page is clicked or a key pressed, so audio starts with this, Play or a key"
				onclick={() => use(want)}>Start audio</button
			>
		{/if}
		<div class="transport" role="group" aria-label="Transport">
			<button type="button" class="icon play" aria-label="Play" onclick={play} disabled={!songDoc} title="Play (Space)"
				><span aria-hidden="true">▶</span></button
			>
			<button
				type="button"
				class="icon"
				aria-label="Stop"
				onclick={stop}
				disabled={!started}
				title="Stop. Pressed again, back to the start (Home)"><span aria-hidden="true">■</span></button
			>
			<button
				type="button"
				class="icon"
				aria-label="Loop"
				aria-pressed={looping}
				onclick={toggleLoop}
				disabled={!songDoc}
				title="Loop, over what the strip under the arrangement's bar numbers shows"
				><span aria-hidden="true">⟲</span></button
			>
			<button
				type="button"
				class="icon record"
				aria-label="Record"
				aria-pressed={take !== null}
				data-testid="record"
				data-state={recordState}
				onclick={record}
				disabled={!take && recordWhy !== ''}
				title={recordTitle}
				>{#if recordState === 'counting'}<span class="count">{engineState?.countIn}</span>{:else}<span
						aria-hidden="true">●</span
					>{/if}</button
			>
		</div>
		<input
			class="field position"
			aria-label="Position"
			title={recipe
				? 'Where the playhead is, as bar.beat.tick'
				: 'Where the playhead is, as bar.beat.tick. Type a place, as 3.2.000 or a bar, to move it there.'}
			data-testid="position"
			spellcheck="false"
			autocomplete="off"
			value={positionText}
			readonly={recipe !== null}
			disabled={!songDoc}
			onfocus={(event) => {
				if (recipe) return;
				typedPosition = position(tick, ppq);
				event.currentTarget.select();
			}}
			oninput={(event) => (typedPosition = event.currentTarget.value)}
			onkeydown={(event) => fieldKeys(event, () => (typedPosition = null))}
			onblur={positionTyped}
		/>
		<label class="tempo" title={tempoTitle}>
			<input
				class="field bpm"
				aria-label="Tempo"
				data-testid="tempo"
				inputmode="decimal"
				spellcheck="false"
				autocomplete="off"
				value={tempoText}
				readonly={recipe !== null}
				disabled={!songDoc}
				onfocus={(event) => {
					if (recipe || !songDoc) return;
					typedTempo = String(shownTempo(songDoc.tempo, tick, true));
					event.currentTarget.value = typedTempo;
					event.currentTarget.select();
				}}
				oninput={(event) => (typedTempo = event.currentTarget.value)}
				onkeydown={(event) => fieldKeys(event, () => (typedTempo = null))}
				onblur={tempoEntered}
			/>
			<span class="muted">BPM</span>
			{#if glide}<span class="glide" aria-hidden="true">{glide === 'up' ? '↗' : '↘'}</span>{/if}
		</label>
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
		<Keyboard
			disabled={!keysPlay && !stepWriting}
			writing={stepWriting && !take}
			recording={recordState === 'counting' || recordState === 'recording'}
			where={keysWhere}
			onnote={keyNote}
		/>
		<div class="master"><Meter ring={masterRing} label="Master level" limiter={engineState} /></div>
		<span class="grow"></span>
		<CompileLight {busy} {problems} size={imageSize} details={engineDetails} />
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
							bind:this={songEditor}
							id={openKey}
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
							{loop}
							{looping}
							onloop={setLoop}
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
							onwriting={(writing) => (stepWriting = writing)}
							onsolo={toggleSolo}
							onkey={(note, on) => started && soundNote(note, on)}
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
					users={shownUsers}
					example={copyInto}
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
					onsong={() => void show('song')}
					onname={(name) => patchEdited({ name })}
					ongraph={(graph) => patchEdited({ graph })}
					ontext={(text, typing) => patchEdited({ text }, typing ? 'typing' : 'edit')}
					choose={nodeAsked}
					onprobes={(next) => (probes = next)}
					onparam={patchParam}
					onpart={(id) => void open({ part: id, patch: null }, false, 'patch')}
				/>
			</div>
		</main>
	</div>

	<div class="messages" role="status" aria-live="polite">
		{#if rendering !== null}<p class="message">Rendering the WAV, {Math.round(rendering * 100)}%</p>{/if}
		{#if renderProblem}
			<p class="message bad">
				WAV export: {renderProblem}
				<button type="button" aria-label="Dismiss" onclick={() => (renderProblem = '')}>×</button>
			</p>
		{/if}
		{#if formProblem}
			<p class="message bad">
				{formProblem}
				<button type="button" aria-label="Dismiss" onclick={() => (shutForm = form)}>×</button>
			</p>
		{/if}
		{#if note}<p class="message">{note}</p>{/if}
		<span class="unseen">{heard}</span>
	</div>
</div>

{#if bundle}
	{#key bundle.id}
		<BundleDialog
			{bundle}
			timelines={data.library.timelines}
			{search}
			report={form?.exported?.report ?? null}
			onclose={() => void open({ bundle: null })}
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

<!-- The song's name, at the start of the Song view's toolbar, as the patch's is at the start of the Patch view's. What is done
	 to the song as a whole is in the Song tab's ▾ menu. -->
{#snippet heading()}
	{#if recipe}
		<span class="kind">Example</span>
		<strong class="songname" title={recipe.entry.listen_for}>{recipe.entry.name}</strong>
		<span class="muted listen">{recipe.entry.listen_for}</span>
	{:else if saved}
		<span class="kind">Timeline</span>
		<input
			bind:this={nameField}
			class="songname"
			aria-label="Timeline name"
			value={timelineName}
			oninput={(e) => timelineEdited({ name: e.currentTarget.value })}
		/>
		{#if timelineDraft}<span class="dot" title="Unsaved changes">•</span>{/if}
	{/if}
	{#if saved && !recipe}<span class="divider"></span>{/if}
{/snippet}

{#snippet songMenu()}
	<DocumentMenu
		{search}
		timeline={saved && !recipe ? { id: saved.id } : null}
		example={recipe ? { name: recipe.entry.name, inLibrary: recipe.inLibrary ?? null } : null}
		{rendering}
		canRender={goodSong !== null}
		onrename={() => void rename()}
		onwav={() => void exportWav()}
	/>
{/snippet}

<!-- Under the light's list: where the playhead is and what the engine is doing. -->
{#snippet engineDetails()}
	<p class="engine muted">
		The playhead is at tick <span data-testid="tick">{tick}</span>.
		{#if engineState}
			<span
				data-testid="state"
				data-playing={engineState.playing}
				data-time={engineState.time}
				data-recording={engineState.recording}
				data-clicks={engineState.clicks}
			>
				<span data-testid="voices">{engineState.voices}</span> voices sounding, in image
				<span data-testid="generation">{engineState.generation}</span> since audio started, which has rendered
				{engineState.time.toFixed(1)} s.
			</span>
		{:else}
			Audio starts with Play, a key, or Start audio.
		{/if}
		Edits have compiled <span data-testid="compiles">{compiles}</span> times since the page opened.
	</p>
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
		grid-template-rows: auto minmax(0, 1fr);
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
	.undo,
	.transport {
		display: flex;
		gap: 0.2rem;
	}
	.play {
		border-color: #238636;
	}
	.icon[aria-pressed='true'] {
		color: var(--text);
		background: #1f6feb33;
		border-color: var(--accent);
	}
	/* Record is red, and while a take runs it is lit, with the beats left while a bar is counted in. */
	.record {
		color: #f85149;
		min-width: 1.9rem;
	}
	.record:disabled {
		color: var(--muted);
	}
	.icon.record[aria-pressed='true'] {
		color: #fff;
		background: #da3633;
		border-color: #f85149;
	}
	.record[data-state='arming'],
	.record[data-state='counting'] {
		animation: blink 0.5s steps(2, jump-none) infinite alternate;
	}
	.record .count {
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}
	@keyframes blink {
		to {
			background: #da363366;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.record[data-state] {
			animation: none;
		}
	}
	/* The position and the tempo read as a display does, and are typed into as fields. */
	.field {
		padding: 0.1rem 0.4rem;
		background: #0d1117;
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.field:read-only {
		color: var(--muted);
	}
	.position {
		width: 4.6rem;
		font-size: 0.95rem;
	}
	.tempo {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}
	.bpm {
		width: 3.4rem;
	}
	.glide {
		color: var(--accent);
	}
	.master {
		width: 80px;
	}
	.grow {
		flex: 1 1 0;
		min-width: 0;
	}
	.engine {
		margin: 0.3rem 0 0;
		font-size: 0.75rem;
	}
	/* Over the foot of the page, out of the way of what it is over unless it says something. */
	.messages {
		position: fixed;
		left: 50%;
		bottom: 0.8rem;
		transform: translateX(-50%);
		z-index: 50;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3rem;
		pointer-events: none;
	}
	.message {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0;
		padding: 0.35rem 0.8rem;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 6px;
		box-shadow: 0 4px 14px #00000080;
		font-size: 0.82rem;
		pointer-events: auto;
	}
	.message.bad {
		border-color: #f8514999;
		background: #2a1416;
	}
	.message button {
		padding: 0 0.35rem;
		border: 0;
		background: transparent;
	}
	.unseen {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
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
