<script lang="ts">
	import { onMount, tick as settle, untrack, type Snippet } from 'svelte';
	import { on } from 'svelte/events';
	import Arrangement, { type Loop, type PlacementActions, type Selection } from '#lib/Arrangement.svelte';
	import type { SongControls, TapTarget } from '#lib/AudioEngine.ts';
	import { leavesFields } from '#lib/Fields.ts';
	import type { Undoable } from '#lib/History.ts';
	import Mixer from '#lib/Mixer.svelte';
	import type { ExampleGroup } from '#lib/PatchGroups.ts';
	import PatchPicker from '#lib/PatchPicker.svelte';
	import PianoRoll from '#lib/PianoRoll.svelte';
	import UnitField from '#lib/UnitField.svelte';
	import { barLength, barLengths, readLength, readPosition } from '#lib/Units.ts';
	import type { ProgramReport } from '#lib/Request.ts';
	import { ZOOM_KEY, dropGone, gone, keepZoom, keptZoom, rollViews, zoomKey, type RollView } from '#lib/RollView.ts';
	import type { Timeline } from '#lib/Schema.ts';
	import type { Ring } from '#lib/ScopeMath.ts';
	import { label, matches, modKey, typingIn } from '#lib/Shortcuts.ts';
	import { clampVelocity, type Cursor } from '#lib/StepEntry.ts';
	import {
		addClip,
		addPlayChange,
		addSlot,
		addTempo,
		addTrack,
		barOf,
		canGrow,
		drawLengths,
		duplicatePlacement,
		grids,
		laneChoices,
		makeUnique,
		mixWrites,
		noteValue,
		place,
		position,
		placementIndex,
		placementSpan,
		placeOfError,
		removeClip,
		removePlacement,
		removePlayChange,
		removeSlot,
		removeTempo,
		removeTrack,
		renameClip,
		setClip,
		setPlacement,
		setPlay,
		setPlayChange,
		setSlot,
		setTempo,
		tempoAt,
		setTrack,
		snapTick,
		soloed,
		stepLength,
		trackKey,
		windowOf,
		ticksPerBar,
		type Clip,
		type PatchLike
	} from '#lib/TimelineEdit.ts';
	import { TEMPLATE_BARS } from '#lib/Template.ts';
	import { landing, type SongPlace } from '#lib/Workspace.ts';

	let {
		id = '',
		doc,
		patches,
		program,
		errors,
		tick,
		playing = false,
		targets,
		rings,
		engine,
		history = null,
		loop = null,
		looping = false,
		readonly = false,
		active = true,
		tabs = [],
		heading,
		examples = [],
		solo = new Set(),
		asked = null,
		onchange,
		onloop = () => {},
		onplace = () => {},
		onopen = () => {},
		onnewpatch,
		onwriting = () => {},
		onsolo = () => {},
		ontempo = () => {},
		onkey,
		onsay = () => {},
		velocity = $bindable(100)
	}: {
		id?: string; // Which timeline this is, for what the editor keeps about it between visits, such as each clip's zoom
		doc: Timeline;
		patches: PatchLike[];
		program: ProgramReport | null;
		errors: { where: string; message: string }[];
		tick: number;
		playing?: boolean; // Whether the song is playing, which the arrangement and the roll follow
		targets: TapTarget[];
		rings: Ring[];
		engine: SongControls;
		history?: Undoable | null; // The timeline's undo, which the page keeps while other things are open
		loop?: Loop | null; // The loop, which the page keeps since the top bar turns it on and off. Null is the whole song.
		looping?: boolean;
		readonly?: boolean;
		active?: boolean; // Whether keys are for this editor, which they are while its view is on screen
		tabs?: { id: string; label: string; content: Snippet }[]; // More views of the document, after the notes and the mixer
		heading?: Snippet; // At the start of the toolbar
		examples?: ExampleGroup[]; // How the browser groups the examples, which the patch pickers group built-in patches by
		solo?: ReadonlySet<number>; // The tracks soloed, which the page keeps, since it is no part of the document
		asked?: SongPlace | null; // Where the address asks the editor to be, as it opens and again when Back or Forward move it
		onchange: (doc: Timeline) => void;
		onloop?: (loop: Loop | null, on: boolean) => void; // A loop set or changed here, and whether it is on
		// The chosen track, clip and tab, as the editor opens and whenever one changes. A place it was asked for isn't chosen.
		onplace?: (place: SongPlace, chosen: boolean) => void;
		onopen?: (patch: string) => void; // Someone asked to open a patch this timeline uses, in the Patch view
		onnewpatch?: (name: string) => Promise<string | null>; // Makes a patch in the library, and gives its id once it's there
		onwriting?: (writing: boolean) => void; // Whether step entry is writing the piano keys into the roll
		onsolo?: (track: number) => void; // Solo a track, or stop soloing it
		ontempo?: (tempo: Timeline['tempo'] | null) => void; // The tempo while the Tempo lane is dragged, then null
		onkey?: (note: number, on: boolean) => void; // Plays a note where the top bar's keys do, once audio has started
		onsay?: (text: string) => void; // Says why something typed into a field was refused, where the page says such things
		velocity?: number; // The velocity of new notes, clicked or stepped, which is the keys' too, so the page keeps it
	} = $props();

	const MODES = ['poly', 'mono', 'legato'] as const;
	const PRIORITIES = ['last', 'high', 'low'] as const;

	// The editor opens where the address says, or else on the first track with a clip, on its notes.
	const tabIds = $derived(['notes', 'mixer', ...tabs.map((extra) => extra.id)]);
	const opened = untrack(() => landing(doc, asked, tabIds));
	let selection = $state<Selection>({ track: opened.track, placement: opened.placement });
	let clipId = $state<string | null>(opened.clip);
	let grid = $state(untrack(() => grids(doc.ppq)[1].ticks));
	let draw = $state(untrack(() => doc.ppq)); // The Draw length, a 1/4 note until a note is added, resized or chosen
	let mod = $state('Ctrl'); // What the hints call Mod, which only the browser knows
	// Step entry, which R or the Step toggle turns on and Esc leaves. It outlasts a change of clip, and its cursor is kept for
	// each clip, so coming back to one carries on where it left off.
	let stepping = $state(false);
	const cursors = new Map<string, Cursor>();
	let roll = $state<ReturnType<typeof PianoRoll>>();
	const drawChoices = $derived.by(() => {
		const lengths = drawLengths(doc.ppq);
		if (lengths.some((length) => length.ticks === draw)) return lengths;
		return [...lengths, { label: noteValue(draw, doc.ppq), ticks: draw }].sort((a, b) => a.ticks - b.ticks);
	});
	let barWidth = $state(96);
	let tab = $state(opened.tab);

	const track = $derived(doc.tracks.find((t) => t.id === selection.track));
	const placed = $derived(selection.placement === null ? undefined : track?.placements[selection.placement]);
	const clip = $derived(doc.clips.find((c) => c.id === clipId));
	// A clip can be placed on several tracks. What it moves and what it plays are worked out for the one it was opened from,
	// or for the chosen track, which the roll follows.
	const home = $derived(
		placed?.clip === clipId || track?.placements.some((p) => p.clip === clipId)
			? track
			: doc.tracks.find((t) => t.placements.some((p) => p.clip === clipId))
	);
	const reported = $derived(program?.tracks.find((t) => t.id === home?.id));
	const uses = $derived(doc.tracks.flatMap((t) => t.placements).filter((p) => p.clip === clipId).length);
	// A slot plays a voice, so the pickers leave out inserts. What the song already plays comes first in them.
	const voices = $derived(patches.filter((patch) => !patch.graph.nodes.some((node) => node.type === 'in')));
	const used = $derived(doc.tracks.flatMap((t) => t.slots));
	const newPatchAction = $derived(onnewpatch && !readonly ? 'New patch for this track' : '');
	const choices = $derived(laneChoices(doc, home?.id ?? null, patches));
	// A track with no notes in any clip is left out of the image, so it never plays.
	const silent = $derived(!!home && !home.placements.some((p) => doc.clips.find((c) => c.id === p.clip)?.notes.length));
	const badTracks = $derived(new Set(errors.flatMap((e) => placeOfError(e.where).track ?? [])));
	const badClips = $derived(new Set(errors.flatMap((e) => placeOfError(e.where).clip ?? [])));

	// The piano keys write into the roll while step entry is on and the roll shows a clip. The page asks before it routes them.
	const writing = $derived(stepping && active && !readonly && tab === 'notes' && !!clip);
	$effect(() => onwriting(writing));
	$effect(() => () => onwriting(false));

	// A piano key from the page, for step entry to write. The roll ignores it unless it is writing.
	export function stepKey(note: number, on: boolean) {
		roll?.stepKey(note, on);
	}

	// What a take snaps to and writes at, as a clicked note does: the roll's Snap and Vel.
	export function takeSettings(): { grid: number; velocity: number } {
		return { grid, velocity };
	}

	// A take writes what the keys play, so step entry gives way to it.
	export function stopStepping() {
		stepping = false;
	}

	const playhead = $derived.by(() => {
		if (!clip || !placed || placed.clip !== clip.id) return null;
		const { start, length } = windowOf(doc, placed);
		const into = tick - placed.tick;
		return into >= 0 && length > 0 && into < length * placed.repeat ? start + (into % length) : null;
	});

	const number = (event: Event) => Number((event.currentTarget as HTMLInputElement).value);

	// The page records each edit in the timeline's history, which outlasts this editor, as opening another timeline ends it.
	function commit(next: Timeline) {
		if (next !== doc) onchange(next);
	}

	// The roll's "Clip is now N bars · Undo" takes back the growing. The top bar has the Undo and Redo for everything else.
	const undo = () => history?.undo();

	// The page puts the chosen track, clip and tab in the address, and shows the chosen track's patch in the Patch view, so it
	// hears of every change. Where the editor opened, or where the address took it, the address says already, so it isn't told
	// as a choice. What it was taken to is kept until the next change, which is the next choice.
	let landed: SongPlace | null = { track: opened.track, clip: opened.clip, tab: opened.tab };
	$effect(() => {
		const now: SongPlace = { track: selection.track, clip: clipId, tab };
		untrack(() => {
			const chosen = !landed || now.track !== landed.track || now.clip !== landed.clip || now.tab !== landed.tab;
			landed = null;
			onplace(now, chosen);
		});
	});

	// Back or Forward moved the address, and it asks for a place: the editor goes there, as it did when it opened. A place that is
	// where the editor is already changes nothing, so a placement chosen among several of one clip stays chosen.
	$effect(() => {
		const wanted = asked;
		untrack(() => {
			const at = landing(doc, wanted, tabIds);
			if (at.track === selection.track && at.clip === clipId && at.tab === tab) return;
			landed = { track: at.track, clip: at.clip, tab: at.tab };
			if (at.track !== selection.track || at.clip !== clipId) {
				selection = { track: at.track, placement: at.placement };
				clipId = at.clip;
			}
			tab = at.tab;
		});
	});

	// The roll shows a clip on the chosen track, so what a click or step entry writes goes to the track the keys play. A track
	// chosen that doesn't hold the clip shown brings its own first clip into the roll, or none, and the roll offers it one.
	let followed = untrack(() => selection.track);
	$effect(() => {
		const id = selection.track;
		untrack(() => {
			if (id === followed) return;
			followed = id;
			const chosen = doc.tracks.find((t) => t.id === id);
			if (!chosen || chosen.placements.some((p) => p.clip === clipId)) return;
			clipId = chosen.placements[0]?.clip ?? null;
		});
	});

	// The roll's New clip, for a track with none: as long as a new song's, at the bar the playhead is in.
	function firstClip(id: number) {
		const bar = ticksPerBar(doc);
		newClip(id, Math.floor(tick / bar) * bar, TEMPLATE_BARS * bar);
	}

	function select(next: Selection) {
		selection = next;
		if (next.placement === null) return;
		const chosen = doc.tracks.find((t) => t.id === next.track)?.placements[next.placement];
		if (chosen) clipId = chosen.clip;
		tab = 'notes';
	}

	function arranged(next: Timeline, moved?: Selection) {
		commit(next);
		if (moved) selection = moved;
	}

	// A track plays a patch, so + Track asks which, and a track head's ▾ changes it. One picker is open at a time, below the
	// button that opened it.
	type Picking = { kind: 'add'; anchor: HTMLElement } | { kind: 'head'; track: number; anchor: HTMLElement };
	let picking = $state.raw<Picking | null>(null);

	// The picker takes focus, so a press on the button that opened it mustn't: then a second click closes it.
	function toggle(next: Picking) {
		const same =
			picking?.kind === next.kind && (picking.kind === 'add' || (next.kind === 'head' && picking.track === next.track));
		picking = same ? null : next;
	}

	const trackName = (track: { id: number; name: string }) => track.name || `Track ${track.id}`;

	function newTrack(patch: string) {
		const added = addTrack(doc, patch);
		commit(added.doc);
		selection = { track: added.id, placement: null };
		return added.id;
	}

	// A patch in slot `index`, or in a new slot past the last.
	function putPatch(id: number, index: number, patch: string) {
		const track = doc.tracks.find((t) => t.id === id);
		if (!track) return false;
		commit(index < track.slots.length ? setSlot(doc, id, index, patch) : addSlot(doc, id, patch));
		if (selection.track !== id) selection = { track: id, placement: null };
		return true;
	}

	function picked(target: Picking, patch: string) {
		picking = null;
		if (target.kind === 'add') newTrack(patch);
		else putPatch(target.track, 0, patch);
	}

	// The page shows a patch when it is opened and the chosen track's patch when a track is chosen, so the track is chosen and
	// the page has heard about it before the patch is opened.
	async function openPatch(track: number, patch: string) {
		if (selection.track !== track) selection = { track, placement: null };
		await settle();
		onopen(patch);
	}

	// New patch for this track: a patch made from the default, on the track, or on a new one, and then opened. It is named
	// after what was typed in the picker, or after its track.
	async function newPatchFor(home: { track: number | null; index: number }, typed: string) {
		picking = null;
		if (!onnewpatch) return;
		const track = doc.tracks.find((t) => t.id === home.track);
		const next = Math.max(0, ...doc.tracks.map((t) => t.id)) + 1;
		const id = await onnewpatch(typed || `${track ? trackName(track) : `Track ${next}`} patch`);
		if (!id) return;
		if (home.track === null) return openPatch(newTrack(id), id);
		if (putPatch(home.track, home.index, id)) await openPatch(home.track, id); // Unless the track went meanwhile
	}

	// The arrangement's zoom, by its − and +, or Mod with the wheel over it.
	function zoomBars(by: number) {
		barWidth = Math.max(24, Math.min(800, barWidth * by));
	}

	// The toolbar's hint, which the toolbar cuts short at a laptop's width, and so its title too.
	const songHint = $derived(
		'Click the numbers to move the playhead.' +
			(readonly
				? ''
				: ` Drag across a row for a new clip, or double-click it for a bar. Drag a clip's right edge to repeat it, hold ${mod} to copy it, and right-click it for more.`)
	);

	function newClip(id: number, at: number, length = ticksPerBar(doc)) {
		const added = addClip(doc, length);
		const next = place(added.doc, id, added.id, at);
		commit(next);
		selection = { track: id, placement: placementIndex(next, id, added.id, at) };
		clipId = added.id;
		tab = 'notes';
	}

	// The arrangement is as tall as its tracks, and the notes have the rest. Expand gives the notes the whole view, the
	// arrangement's height and the inspector's width too, until ⤢ or Esc brings them back.
	let expanded = $state(false);
	let peek = $state(false); // The inspector, shown beside expanded notes all the same
	function expand(on = !expanded) {
		expanded = on;
		peek = false;
	}

	// A double-click on a clip opens it: its notes, with the whole view.
	function expandClip(at: { track: number; placement: number }) {
		select(at);
		expand(true);
	}

	// The inspector is a column down the right of the view, and folds to a rail. Below 1400 px wide it starts folded, as the
	// browser does there, and each side of 1400 remembers what was chosen on it, so unfolding it on a laptop doesn't unfold it
	// on a wide screen. Until the page knows how wide the window is, the width decides.
	const WIDE = 1400;
	let wide = $state<boolean | null>(null);
	let folded = $state({ wide: false, narrow: true });
	const inspectorKey = (wide: boolean) => `modsynth.inspector.${wide ? 'wide' : 'narrow'}`;
	const inspecting = $derived(expanded ? peek : wide === null ? null : !folded[wide ? 'wide' : 'narrow']);

	function toggleInspector() {
		if (expanded) {
			peek = !peek;
			return;
		}
		if (wide === null) return;
		const side = wide ? 'wide' : 'narrow';
		folded[side] = !folded[side];
		localStorage.setItem(inspectorKey(wide), folded[side] ? 'folded' : 'open');
	}

	onMount(() => {
		for (const side of [true, false]) {
			const kept = localStorage.getItem(inspectorKey(side));
			if (kept) folded[side ? 'wide' : 'narrow'] = kept === 'folded';
		}
		const query = matchMedia(`(min-width: ${WIDE}px)`);
		wide = query.matches;
		return on(query, 'change', () => (wide = query.matches));
	});

	// Each clip keeps how the roll showed it: its zoom and row height across a reload, and its scroll while the page is open.
	const viewKey = (clip: string) => zoomKey(id, clip);
	function rollViewOf(clip: string): RollView | null {
		const seen = rollViews.get(viewKey(clip));
		if (seen) return seen;
		// The server draws the roll as a clip first looks, and the browser then puts it as it was kept.
		if (typeof localStorage === 'undefined') return null;
		return keptZoom(localStorage.getItem(ZOOM_KEY), viewKey(clip));
	}
	// A clip that leaves the document, deleted or renamed, takes its view with it, so a new clip given its name doesn't open at
	// the old one's zoom.
	$effect(() => {
		const clips = new Set(doc.clips.map((c) => c.id));
		untrack(() => {
			for (const key of [...rollViews.keys()]) if (gone(key, id, clips)) rollViews.delete(key);
			const kept = dropGone(localStorage.getItem(ZOOM_KEY), id, clips);
			if (kept !== null) localStorage.setItem(ZOOM_KEY, kept);
		});
	});
	function viewed(clip: string, view: RollView, zoomed: boolean) {
		rollViews.set(viewKey(clip), view);
		if (zoomed) localStorage.setItem(ZOOM_KEY, keepZoom(localStorage.getItem(ZOOM_KEY), viewKey(clip), view));
	}

	// I folds the inspector, `.` fits the roll to its clip's notes, and Esc leaves Expand once nothing nearer has taken it: a
	// menu, a drag, or what the roll is doing. They have their own listener, so the editor's `keydown` stays as it is.
	function viewKeys(event: KeyboardEvent) {
		if (!active || event.defaultPrevented || typingIn(event.target)) return;
		if (matches(event, 'inspector')) {
			event.preventDefault();
			if (!event.repeat) toggleInspector();
		} else if (matches(event, 'fit') && tab === 'notes' && roll) {
			event.preventDefault();
			void roll.fit();
		} else if (matches(event, 'escape') && expanded) {
			event.preventDefault();
			expand(false);
		}
	}

	onMount(() => on(window, 'keydown', viewKeys));

	const ringOf = (id: number) => {
		const target = targets.find((t) => t.chain === `track:${id}`);
		return target ? rings[target.slot] : null;
	};

	function deletePlacement() {
		if (selection.track === null || selection.placement === null) return;
		commit(removePlacement(doc, selection.track, selection.placement));
		selection = { ...selection, placement: null };
	}

	// A track head's M is the track's own mute, as the Mixer's Mute is: saved with the song, one step of its undo, and heard at
	// once through the mix registers.
	function toggleMute(id: number) {
		const track = doc.tracks.find((t) => t.id === id);
		if (!track || readonly) return;
		const next = setTrack(doc, id, { mute: !track.mute });
		const writes = program ? mixWrites(soloed(next, solo), program, trackKey(id)) : [];
		for (const { register, value } of writes) engine.setMix(register, value);
		commit(next);
	}

	// A track head's fader or pan, as the Mixer's: the mix registers follow a drag, and the song takes the value let go of,
	// which is one step of its undo.
	function mixed(id: number, change: { gain?: number; pan?: number }, done: boolean) {
		if (readonly) return;
		const next = setTrack(doc, id, change);
		const writes = program ? mixWrites(soloed(next, solo), program, trackKey(id)) : [];
		for (const { register, value } of writes) engine.setMix(register, value);
		if (done) commit(next);
	}

	function deleteTrack() {
		if (selection.track === null) return;
		commit(removeTrack(doc, selection.track));
		selection = { track: null, placement: null };
	}

	function deleteClip() {
		if (!clipId) return;
		commit(removeClip(doc, clipId));
		clipId = null;
		selection = { ...selection, placement: null };
	}

	function unique() {
		if (selection.track === null || selection.placement === null) return;
		const made = makeUnique(doc, selection.track, selection.placement);
		commit(made.doc);
		clipId = made.id;
	}

	function rename(name: string) {
		if (!clipId) return;
		const next = renameClip(doc, clipId, name.trim());
		if (next === doc) return;
		commit(next);
		const seen = rollViews.get(viewKey(clipId)); // A clip renamed keeps how the roll showed it
		if (seen) rollViews.set(viewKey(name.trim()), seen);
		clipId = name.trim();
	}

	const clipChanged = (next: Clip) => commit(setClip(doc, next.id, next));

	// What a clip's menu in the arrangement does, each to the placement it was opened on.
	const placementActions: PlacementActions = {
		open: (at) => select(at),
		duplicate: (at) => {
			const copied = duplicatePlacement(doc, at.track, at.placement);
			select(at);
			commit(copied.doc);
			selection = { track: at.track, placement: copied.index };
		},
		unique: (at) => {
			select(at);
			unique();
		},
		remove: (at) => {
			select(at);
			deletePlacement();
		},
		delete: (at) => {
			select(at);
			deleteClip();
		},
		// The loop goes over the placement and its repeats, and the playhead into it, so Play plays the loop.
		loop: (at) => {
			select(at);
			const placed = doc.tracks.find((t) => t.id === at.track)?.placements[at.placement];
			if (!placed) return;
			const range = { start: placed.tick, end: placed.tick + placementSpan(doc, placed) };
			onloop(range, true);
			if (tick < range.start || tick >= range.end) engine.locate(range.start);
		}
	};

	// Shows where a problem is, for the compile light's links: a track, a clip and where it is placed, or a tab.
	export function reveal(place: { track?: number | null; clip?: string | null; tab?: string }) {
		const clip = place.clip ?? null;
		const on =
			place.track === undefined || place.track === null
				? doc.tracks.find((t) => clip !== null && t.placements.some((p) => p.clip === clip))
				: doc.tracks.find((t) => t.id === place.track);
		const index = clip === null ? -1 : (on?.placements.findIndex((p) => p.clip === clip) ?? -1);
		if (on) selection = { track: on.id, placement: index >= 0 ? index : null };
		if (clip !== null && doc.clips.some((c) => c.id === clip)) clipId = clip;
		tab = place.tab ?? 'notes';
	}

	// [ and ] step the Draw length. They go by where the keys are, as the piano keys do, and a field keeps them. They have
	// their own listener, so the editor's `keydown` stays as it is.
	function stepDraw(event: KeyboardEvent) {
		if (readonly || !active || typingIn(event.target)) return;
		const by = matches(event, 'draw-shorter') ? -1 : matches(event, 'draw-longer') ? 1 : 0;
		if (!by) return;
		event.preventDefault();
		draw = stepLength(draw, doc.ppq, by);
	}

	// R turns step entry on or off, wherever focus is but a field or a dialog. From another tab it opens the notes to write
	// in, and with no clip there is nothing to write into. C and V, which step the velocity of new notes, are the page's.
	function noteKeys(event: KeyboardEvent) {
		const target = event.target as Element | null;
		if (readonly || !active || typingIn(target) || target?.closest?.('dialog')) return;
		if (matches(event, 'step-entry')) {
			event.preventDefault();
			if (event.repeat || !clip) return;
			stepping = tab !== 'notes' || !stepping;
			tab = 'notes';
		}
	}

	onMount(() => on(window, 'keydown', noteKeys));

	onMount(() => {
		mod = modKey() === 'Meta' ? '⌘' : 'Ctrl';
		return on(window, 'keydown', stepDraw);
	});

	// A track the image leaves out, because it has no notes yet, is heard where the keys play it, on its own.
	const auditionByKeys = $derived(
		reported === undefined && !!onkey && home !== undefined && home.id === selection.track
	);

	function audition(note: number, on: boolean) {
		if (auditionByKeys) return onkey?.(note, on);
		if (reported?.index === undefined) return;
		if (on) engine.noteOn(reported.index, note);
		else engine.noteOff(reported.index, note);
	}

	function locate(at: number) {
		engine.locate(at);
	}

	// Undo and Redo are the page's keys, since they act on whichever panel is in use.
	function keydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement;
		if (readonly || !active || target.closest('input, textarea, select')) return;
		const deleting = matches(event, 'arrangement.delete') || matches(event, 'arrangement.backspace');
		if (deleting && !target.closest('[data-testid="roll"]')) {
			if (selection.placement === null) return;
			event.preventDefault();
			deletePlacement();
		}
	}
</script>

<svelte:window onkeydown={keydown} />

<section
	use:leavesFields
	class="timeline"
	class:expanded
	class:inspecting={inspecting === true}
	class:folded={inspecting === false}
	aria-label="Timeline editor"
>
	<div class="toolbar">
		{@render heading?.()}
		{#if !readonly}
			<button
				type="button"
				aria-label="Add track"
				aria-haspopup="listbox"
				aria-expanded={picking?.kind === 'add'}
				title="Add a track, and choose its patch"
				onmousedown={(event) => event.preventDefault()}
				onclick={(event) => toggle({ kind: 'add', anchor: event.currentTarget })}>+ Track</button
			>
		{/if}
		{#if !readonly}
			<label
				title="How long a clicked note is. [ and ] step it, and it follows the last note added, resized or chosen."
			>
				Draw
				<select aria-label="Draw length" bind:value={draw}>
					{#each drawChoices as choice (choice.ticks)}<option value={choice.ticks}>{choice.label}</option>{/each}
				</select>
			</label>
			<label
				title={`How hard a new note is played, from 1 to 127. ${label('softer')} and ${label('louder')} step it by 10.`}
			>
				Vel
				<input
					class="velocity"
					type="number"
					min="1"
					max="127"
					aria-label="Velocity of new notes"
					value={velocity}
					onchange={(e) => {
						velocity = clampVelocity(Number(e.currentTarget.value) || velocity);
						e.currentTarget.value = String(velocity);
					}}
				/>
			</label>
		{/if}
		<label>
			Snap
			<select aria-label="Snap" bind:value={grid}>
				{#each grids(doc.ppq) as choice (choice.label)}<option value={choice.ticks}>{choice.label}</option>{/each}
			</select>
		</label>
		<button
			type="button"
			onclick={() => zoomBars(1 / 1.5)}
			aria-label="Zoom out"
			title={`Zoom out. ${mod} with the wheel, or a pinch, zooms where the pointer is.`}>−</button
		>
		<button
			type="button"
			onclick={() => zoomBars(1.5)}
			aria-label="Zoom in"
			title={`Zoom in. ${mod} with the wheel, or a pinch, zooms where the pointer is.`}>+</button
		>
		<span class="muted hint" title={songHint}>{songHint}</span>
	</div>

	<!-- The arrangement and the inspector take their places in the editor's grid: see `.top` below. -->
	<div class="top">
		<Arrangement
			{id}
			{doc}
			{selection}
			{barWidth}
			{grid}
			{tick}
			{playing}
			{loop}
			{looping}
			{readonly}
			{badTracks}
			{badClips}
			meter={ringOf}
			{patches}
			{solo}
			{active}
			onmute={toggleMute}
			{onsolo}
			picking={picking?.kind === 'head' ? picking.track : null}
			onpick={(track, anchor) => toggle({ kind: 'head', track, anchor })}
			onopen={(track, patch) => void openPatch(track, patch)}
			onselect={select}
			onchange={arranged}
			onnew={newClip}
			actions={placementActions}
			onlocate={locate}
			{onloop}
			onexpand={expandClip}
			{ontempo}
			onmix={mixed}
			onzoom={zoomBars}
		/>

		<aside class="inspector" id="inspector">
			<div class="fold">
				<span class="muted">Inspector</span>
				<button
					type="button"
					aria-label="Inspector"
					aria-expanded="true"
					aria-controls="inspector"
					title={`Fold the inspector (${label('inspector')})`}
					onclick={toggleInspector}>»</button
				>
			</div>
			<fieldset disabled={readonly}>
				<details>
					<summary>Tempo, {doc.tempo[0]?.bpm} BPM</summary>
					<p class="muted lanenote">The Tempo lane, above the tracks, draws these and is dragged.</p>
					{#each doc.tempo as change, index (index)}
						<div class="line">
							<span class="muted"
								>{change.tick % ticksPerBar(doc)
									? position(change.tick, doc.ppq)
									: `bar ${barOf(change.tick, doc.ppq)}`}</span
							>
							<input
								type="number"
								min="1"
								max="1000"
								step="any"
								aria-label={`Tempo at bar ${barOf(change.tick, doc.ppq)}`}
								value={change.bpm}
								onchange={(e) => commit(setTempo(doc, index, { bpm: number(e) }))}
							/>
							{#if doc.tempo.some((t) => t.tick > change.tick)}
								<label class="ramp" title="Glide to the next change's tempo, instead of holding this one until it">
									<input
										type="checkbox"
										aria-label={`Ramp from bar ${barOf(change.tick, doc.ppq)}`}
										checked={change.ramp ?? false}
										onchange={(e) => commit(setTempo(doc, index, { ramp: e.currentTarget.checked }))}
									/>
									ramp
								</label>
							{/if}
							{#if index > 0 && !readonly}
								<button
									type="button"
									aria-label={`Remove tempo at bar ${barOf(change.tick, doc.ppq)}`}
									onclick={() => commit(removeTempo(doc, index))}>×</button
								>
							{/if}
						</div>
					{/each}
					{#if !readonly}
						<button
							type="button"
							onclick={() => {
								const at = snapTick(tick, ticksPerBar(doc));
								commit(addTempo(doc, at, Math.round(tempoAt(doc.tempo, at) * 100) / 100));
							}}
						>
							Add a change at the playhead
						</button>
					{/if}
				</details>

				{#if track}
					<h3>Track</h3>
					<label
						>name <input
							aria-label="Track name"
							value={track.name}
							onchange={(e) => commit(setTrack(doc, track.id, { name: e.currentTarget.value }))}
						/></label
					>
					<label
						>voices <input
							type="number"
							min="1"
							max="256"
							aria-label="Voices"
							value={track.voices}
							onchange={(e) => commit(setTrack(doc, track.id, { voices: number(e) }))}
						/></label
					>
					{@const held = program?.tracks.find((t) => t.id === track.id)?.notes_at_once}
					{@const short = program?.warnings?.find((w) => placeOfError(w.where).track === track.id)}
					{#if held !== undefined}
						<p class="muted" class:short data-testid="notes-at-once">
							Holds up to {held} at once{#if short && short.tick !== undefined}, so with {track.voices} the oldest are cut
								short from bar {barOf(short.tick, doc.ppq)}{/if}.
						</p>
					{/if}
					{#each track.slots as slot, index (index)}
						<div class="line">
							<PatchPicker
								label={`Patch slot ${index + 1}`}
								value={slot}
								patches={voices}
								{used}
								{examples}
								action={newPatchAction}
								disabled={readonly}
								onchoose={(patch) => commit(setSlot(doc, track.id, index, patch))}
								onaction={(typed) => void newPatchFor({ track: track.id, index }, typed)}
							/>
							{#if !readonly}
								<button
									type="button"
									aria-label={`Open patch slot ${index + 1}`}
									title="Open this patch in the Patch view"
									onclick={() => onopen(slot)}>Open <span aria-hidden="true">◆</span></button
								>
								<button
									type="button"
									aria-label={`Remove patch slot ${index + 1}`}
									onclick={() => commit(removeSlot(doc, track.id, index))}>×</button
								>
							{/if}
						</div>
					{/each}
					{#if !readonly && voices.length}
						<div class="line">
							<PatchPicker
								label="Add a patch slot"
								placeholder="Add a patch…"
								patches={voices}
								{used}
								{examples}
								action={newPatchAction}
								onchoose={(patch) => commit(addSlot(doc, track.id, patch))}
								onaction={(typed) => void newPatchFor({ track: track.id, index: track.slots.length }, typed)}
							/>
						</div>
					{/if}
					<label>
						mode
						<select
							aria-label="Play mode"
							value={track.play?.mode ?? 'poly'}
							onchange={(e) =>
								commit(setPlay(doc, track.id, { mode: e.currentTarget.value as (typeof MODES)[number] }))}
						>
							{#each MODES as mode (mode)}<option value={mode}>{mode}</option>{/each}
						</select>
					</label>
					{#if track.play && track.play.mode !== 'poly'}
						<label>
							priority
							<select
								aria-label="Note priority"
								value={track.play.priority}
								onchange={(e) =>
									commit(setPlay(doc, track.id, { priority: e.currentTarget.value as (typeof PRIORITIES)[number] }))}
							>
								{#each PRIORITIES as priority (priority)}<option value={priority}>{priority}</option>{/each}
							</select>
						</label>
					{/if}
					<label
						>glide <input
							type="number"
							min="0"
							max="60"
							step="any"
							aria-label="Glide seconds"
							value={track.play?.glide ?? 0}
							onchange={(e) => commit(setPlay(doc, track.id, { glide: number(e) }))}
						/></label
					>
					{#if track.play?.mode === 'legato'}
						<label title="A slurred note brings its velocity, over the glide or 5 ms">
							<input
								type="checkbox"
								aria-label="Slurs bring their velocity"
								checked={track.play.slur_velocity ?? false}
								onchange={(e) =>
									commit(setPlay(doc, track.id, { slur_velocity: e.currentTarget.checked || undefined }))}
							/>
							slurs bring velocity
						</label>
					{/if}
					<label title="What happens to a note whose voice a new one takes: cut off, or faded out over 2 ms">
						stolen voices
						<select
							aria-label="Stolen voices"
							value={track.steal ?? 'cut'}
							onchange={(e) =>
								commit(setTrack(doc, track.id, { steal: e.currentTarget.value === 'fade' ? 'fade' : undefined }))}
						>
							<option value="cut">cut</option>
							<option value="fade">fade</option>
						</select>
					</label>
					{#if !readonly}<button type="button" onclick={deleteTrack}>Delete track</button>{/if}
				{/if}

				{#if clip}
					<h3>Clip</h3>
					<label
						>name <input
							aria-label="Clip name"
							value={clip.id}
							onchange={(e) => rename(e.currentTarget.value)}
						/></label
					>
					<label title="How long the clip is, in bars, as a note value such as 1/2, or in ticks"
						>length <UnitField
							label="Clip length"
							value={clip.length}
							format={(length) => barLength(length, doc.ppq)}
							read={readLength(doc.ppq)}
							choices={barLengths(doc.ppq)}
							onvalue={(length) => commit(setClip(doc, clip.id, { ...clip, length }))}
							{onsay}
							width="9.5rem"
						/></label
					>
					{#if placed && selection.track !== null && selection.placement !== null}
						{@const at = { track: selection.track, index: selection.placement }}
						<label title="Where it starts in the song, as bar.beat.tick, or a bar">
							starts
							<UnitField
								label="Clip start"
								value={placed.tick}
								format={(tick) => position(tick, doc.ppq)}
								read={readPosition(doc.ppq)}
								onvalue={(tick) => {
									const next = setPlacement(doc, at.track, at.index, { tick });
									commit(next);
									selection = { track: at.track, placement: placementIndex(next, at.track, placed.clip, tick) };
								}}
								{onsay}
								width="8rem"
							/>
						</label>
						<label
							>repeats <input
								type="number"
								min="1"
								aria-label="Repeats"
								value={placed.repeat}
								onchange={(e) => commit(setPlacement(doc, at.track, at.index, { repeat: number(e) }))}
							/></label
						>
						{@const window = windowOf(doc, placed)}
						<div class="placement" role="group" aria-label="What this placement plays">
							<label title="Plays the clip from here in it, as bar.beat.tick from the clip's start"
								>from <UnitField
									label="Window start"
									value={window.start}
									format={(tick) => position(tick, doc.ppq)}
									read={readPosition(doc.ppq, clip.length)}
									onvalue={(start) => commit(setPlacement(doc, at.track, at.index, { start, length: undefined }))}
									{onsay}
									width="8rem"
								/></label
							>
							<label title="For this long, each repeat, in bars, as a note value or in ticks"
								>for <UnitField
									label="Window length"
									value={window.length}
									format={(length) => barLength(length, doc.ppq)}
									read={readLength(doc.ppq)}
									choices={barLengths(doc.ppq)}
									onvalue={(length) => commit(setPlacement(doc, at.track, at.index, { length }))}
									{onsay}
									width="9.5rem"
								/></label
							>
							<label
								>transpose <input
									type="number"
									min="-127"
									max="127"
									aria-label="Transpose"
									value={placed.transpose ?? 0}
									onchange={(e) => commit(setPlacement(doc, at.track, at.index, { transpose: number(e) }))}
								/></label
							>
							<label title="Multiplies every note's velocity"
								>velocity × <input
									type="number"
									min="0"
									max="4"
									step="0.05"
									aria-label="Velocity scale"
									value={placed.velocity ?? 1}
									onchange={(e) => commit(setPlacement(doc, at.track, at.index, { velocity: number(e) }))}
								/></label
							>
						</div>
					{/if}
					{#if uses > 1}<p class="muted" data-testid="clip-uses">
							Placed {uses} times. An edit changes all of them.
						</p>{/if}
					{#each clip.play as change, index (index)}
						<div class="change">
							<UnitField
								label={`Play change ${index + 1} tick`}
								title="Where in the clip it changes, as bar.beat.tick from the clip's start"
								value={change.tick}
								format={(tick) => position(tick, doc.ppq)}
								read={readPosition(doc.ppq, clip.length)}
								onvalue={(tick) => clipChanged(setPlayChange(clip, index, { tick }))}
								{onsay}
								width="5.5rem"
							/>
							<select
								aria-label={`Play change ${index + 1} mode`}
								value={change.mode}
								onchange={(e) =>
									clipChanged(setPlayChange(clip, index, { mode: e.currentTarget.value as (typeof MODES)[number] }))}
							>
								{#each MODES as mode (mode)}<option value={mode}>{mode}</option>{/each}
							</select>
							{#if !readonly}
								<button
									type="button"
									aria-label={`Remove play change ${index + 1}`}
									onclick={() => clipChanged(removePlayChange(clip, index))}>×</button
								>
							{/if}
						</div>
					{/each}
					{#if !readonly}
						<div class="tools">
							{#if uses > 1 && placed}<button type="button" onclick={unique}>Make unique</button>{/if}
							<button type="button" onclick={() => clipChanged(addPlayChange(clip, 0))}>Add play change</button>
							{#if placed}<button type="button" onclick={deletePlacement}>Remove from track</button>{/if}
							<button type="button" onclick={deleteClip}>Delete clip</button>
						</div>
					{/if}
				{/if}
			</fieldset>
		</aside>
		<button
			type="button"
			class="rail"
			aria-label="Inspector"
			aria-expanded="false"
			aria-controls="inspector"
			title={`Show the inspector (${label('inspector')})`}
			onclick={toggleInspector}><span aria-hidden="true">«</span> Inspector</button
		>
	</div>

	<div class="detail">
		<div class="tabs" role="tablist" aria-label="Timeline views">
			<button type="button" role="tab" aria-selected={tab === 'notes'} onclick={() => (tab = 'notes')}>
				Notes{clip ? `: ${clip.id}` : ''}
			</button>
			<button type="button" role="tab" aria-selected={tab === 'mixer'} onclick={() => (tab = 'mixer')}>Mixer</button>
			{#each tabs as extra (extra.id)}
				<button type="button" role="tab" aria-selected={tab === extra.id} onclick={() => (tab = extra.id)}
					>{extra.label}</button
				>
			{/each}
		</div>
		<!-- Step is for the notes, and ⤢ for whichever tab is open. -->
		<div class="rolltools" role="toolbar" aria-label="Notes">
			{#if tab === 'notes' && clip && !readonly}
				<button
					type="button"
					class="step"
					aria-pressed={stepping}
					title={`Step entry (${label('step-entry')}): the piano keys write notes at a cursor, each as long as Draw`}
					onclick={() => (stepping = !stepping)}><span aria-hidden="true">●</span> Step</button
				>
			{/if}
			<button
				type="button"
				class="expand"
				aria-label="Expand"
				aria-pressed={expanded}
				title={expanded
					? 'Bring the arrangement and the inspector back (Esc)'
					: 'Give this the whole view. A double-click on a clip does too, and Esc comes back.'}
				onclick={() => expand()}>⤢</button
			>
		</div>
		<div class="pane" class:notes={tab === 'notes'} role="tabpanel">
			{#if tab === 'notes'}
				{#if clip}
					{#key clip.id}
						<PianoRoll
							{clip}
							ppq={doc.ppq}
							{grid}
							slots={home?.slots ?? []}
							{choices}
							{silent}
							{playhead}
							{playing}
							canAudition={reported !== undefined || auditionByKeys}
							{readonly}
							bind:draw
							bind:this={roll}
							bind:stepping
							{velocity}
							{active}
							{cursors}
							cangrow={(length) => !!clip && canGrow(doc, clip.id, length)}
							view={rollViewOf(clip.id)}
							{expanded}
							onchange={clipChanged}
							onaudition={audition}
							onundo={undo}
							onview={(view, zoomed) => clip && viewed(clip.id, view, zoomed)}
							{onsay}
						/>
					{/key}
				{:else if track && !track.placements.length && !readonly}
					{@const owner = track}
					<p class="muted empty" data-testid="no-clip">
						{trackName(owner)} has no clip yet.
						<button type="button" onclick={() => firstClip(owner.id)}>New clip</button>
						makes one of {TEMPLATE_BARS} bars at the playhead, or drag across its row for one of your own length.
					</p>
				{:else}
					<p class="muted empty">
						{readonly
							? 'Choose a clip in the arrangement to see its notes.'
							: 'Choose a clip in the arrangement to edit its notes, or drag across a row for a new one.'}
					</p>
				{/if}
			{:else if tab === 'mixer'}
				<Mixer
					{doc}
					{patches}
					{program}
					{targets}
					{rings}
					{engine}
					{readonly}
					{solo}
					onchange={commit}
					{onopen}
					{onsolo}
				/>
			{:else}
				{@render tabs.find((extra) => extra.id === tab)?.content()}
			{/if}
		</div>
	</div>
</section>

{#if picking}
	{@const target = picking}
	{@const on = target.kind === 'head' ? doc.tracks.find((t) => t.id === target.track) : undefined}
	{#key target}
		<PatchPicker
			label={on ? `Patch for ${trackName(on)}` : 'Patch for the new track'}
			value={on?.slots[0] ?? null}
			anchor={target.anchor}
			patches={voices}
			{used}
			{examples}
			action={newPatchAction}
			onchoose={(patch) => picked(target, patch)}
			onaction={(typed) => void newPatchFor({ track: target.kind === 'head' ? target.track : null, index: 0 }, typed)}
			oncancel={() => (picking = null)}
		/>
	{/key}
{/if}

<style>
	.short {
		color: var(--warn, #e3b341);
	}
	.placement {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
	}
	/* The toolbar across the top, the arrangement over the notes, and the inspector down the right of both. The arrangement is
	   as tall as its tracks, up to a limit it sets itself, and the notes have the rest. */
	.timeline {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-rows: auto auto minmax(0, 1fr);
		grid-template-areas: 'toolbar toolbar' 'arrangement side' 'detail side';
		column-gap: 0.5rem;
		height: 100%;
		min-height: 0;
	}
	.toolbar {
		grid-area: toolbar;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		padding: 0.25rem 0;
		min-width: 0;
	}
	.toolbar button,
	.toolbar select {
		padding: 0.1rem 0.5rem;
	}
	.toolbar :global(button),
	.toolbar :global(label),
	.toolbar :global(form) {
		flex: none;
		white-space: nowrap;
	}
	.hint {
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 0.75rem;
	}
	/* `.top` holds the arrangement and the inspector, and puts no box of its own in the grid, so each takes its own place. */
	.top {
		display: contents;
	}
	.top > :global(.arrangement) {
		grid-area: arrangement;
		margin-bottom: 0.4rem;
	}
	.expanded .top > :global(.arrangement) {
		display: none;
	}
	/* The inspector shows, or its rail does. Until the page knows how wide the window is, the width decides. */
	.inspecting .rail,
	.folded .inspector {
		display: none;
	}
	@media (min-width: 1400px) {
		.timeline:not(.inspecting, .folded) .rail {
			display: none;
		}
	}
	@media (max-width: 1399.98px) {
		.timeline:not(.inspecting, .folded) .inspector {
			display: none;
		}
	}
	.rail {
		grid-area: side;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 1.6rem;
		margin: 0;
		padding: 0.5rem 0;
		writing-mode: vertical-rl;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 6px;
		color: var(--muted);
		font-size: 0.75rem;
	}
	.rail:hover {
		color: var(--text);
	}
	.rail span {
		writing-mode: horizontal-tb;
	}
	.fold {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: -0.2rem 0 0.2rem;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.inspector {
		grid-area: side;
		width: 250px;
		box-sizing: border-box;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 0.5rem;
		min-height: 0;
		overflow: auto;
		font-size: 0.8rem;
	}
	.detail {
		grid-area: detail;
		min-height: 0;
		display: flex;
		flex-direction: column;
		position: relative;
	}
	/* The roll's own controls, and ⤢, sit at the right end of the tab strip. */
	.rolltools {
		position: absolute;
		top: 0;
		right: 0;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding-top: 0.3rem;
		font-size: 0.8rem;
	}
	.rolltools button {
		padding: 0.1rem 0.6rem;
		font-size: 0.8rem;
	}
	.step span {
		color: var(--muted);
	}
	.step[aria-pressed='true'] {
		border-color: #3fb950;
	}
	.step[aria-pressed='true'] span {
		color: #3fb950;
	}
	.toolbar input.velocity {
		width: 3.2rem;
		padding: 0.1rem 0.25rem;
	}
	.tabs {
		flex: none;
		display: flex;
		gap: 0.15rem;
		padding-top: 0.3rem;
		border-bottom: 1px solid var(--line);
	}
	.tabs button {
		border: 1px solid transparent;
		border-bottom: 0;
		border-radius: 5px 5px 0 0;
		padding: 0.15rem 0.7rem;
		font-size: 0.8rem;
		background: transparent;
		color: var(--muted);
	}
	.tabs button[aria-selected='true'] {
		background: var(--panel);
		border-color: var(--line);
		color: var(--text);
	}
	.rolltools .expand {
		padding: 0 0.4rem;
		font-size: 1rem;
		line-height: 1.2;
	}
	.expand[aria-pressed='true'] {
		color: var(--accent);
		border-color: var(--accent);
	}
	.pane {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding-top: 0.4rem;
	}
	.pane.notes {
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.empty {
		font-size: 0.85rem;
	}
	fieldset {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.inspector h3 {
		margin: 0.6rem 0 0.3rem;
		font-size: 0.85rem;
	}
	.inspector label,
	.line {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.3rem;
		margin-bottom: 0.2rem;
	}
	.inspector input,
	.inspector select {
		width: 8rem;
		min-width: 0;
		padding: 0.1rem 0.3rem;
		font-size: 0.78rem;
		box-sizing: border-box;
	}
	.lanenote {
		margin: 0.2rem 0 0.35rem;
		font-size: 0.72rem;
	}
	.ramp {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		font-size: 0.75rem;
		color: var(--muted);
	}
	.inspector .ramp input {
		width: auto;
		margin: 0;
	}
	.inspector button {
		padding: 0.1rem 0.4rem;
		font-size: 0.75rem;
	}
	.change {
		display: flex;
		gap: 0.2rem;
		margin-bottom: 0.2rem;
	}
	.change :global(input.unit),
	.change select {
		width: auto;
		flex: 1;
	}
	.tools {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.3rem;
	}
	.inspector p {
		margin: 0.2rem 0;
		font-size: 0.75rem;
	}
</style>
