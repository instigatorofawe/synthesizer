<script lang="ts">
	import { onMount, tick as settle } from 'svelte';
	import { bpmText, tempoRange } from '#lib/Tempo.ts';
	import {
		copiedSpan,
		drawnClip,
		movePlacement,
		moveTrack,
		pasteAt,
		pastePlacement,
		place,
		placementIndex,
		placementSpan,
		removeTrack,
		setPlacement,
		setTrack,
		songLength,
		windowOf,
		type Clip,
		type PatchLike,
		type Tempo,
		type Track
	} from '#lib/TimelineEdit.ts';
	import { wholeSong } from '#lib/Transport.ts';
	import { BAR, noteValue } from '#lib/Units.ts';
	import { addMeter, barsOf, meterText, metersOf, removeMeter } from '#lib/TimeSignature.ts';
	import { clipboard } from '#lib/Clipboard.ts';
	import ContextMenu, { EXAMPLE_NOTE, byKeys, type MenuItem } from '#lib/ContextMenu.svelte';
	import { escapeCancels } from '#lib/Drag.ts';
	import { followScroll } from '#lib/Follow.ts';
	import HeadMix from '#lib/HeadMix.svelte';
	import Meter from '#lib/Meter.svelte';
	import { bringing, patchDrag, wavFiles, type DraggedPatch } from '#lib/PatchDrag.svelte.ts';
	import { anchored, wheelAction } from '#lib/RollView.ts';
	import type { Timeline } from '#lib/Schema.ts';
	import type { Ring } from '#lib/ScopeMath.ts';
	import { matches, modHeld, modKey, typingIn } from '#lib/Shortcuts.ts';
	import { LANES_KEY, SONG_LANES, keepOpen, keptOpen, laneHeight, laneTop, layerHeight } from '#lib/SongLayer.ts';
	import { addKey, keyAt, keyName, keysOf, removeKey } from '#lib/KeySignature.ts';
	import { TEMPLATE_BARS } from '#lib/Template.ts';
	import TempoLane from '#lib/TempoLane.svelte';

	export interface Selection {
		track: number | null;
		placement: number | null; // An index into that track's placements
	}

	// The loop, in the song's ticks. It is the editor's, not the song's, so it isn't saved.
	export interface Loop {
		start: number;
		end: number;
	}

	// What was dropped on the arrangement, and where: on a track, or on the row below the tracks for a new one, at a bar.
	export type Dropped =
		| { kind: 'patch'; patch: DraggedPatch; track: number | null; tick: number }
		| { kind: 'files'; files: File[]; track: number | null; tick: number };

	// What a clip's right-click menu does, each to the placement it was opened on.
	export interface PlacementActions {
		open: (at: { track: number; placement: number }) => void;
		duplicate: (at: { track: number; placement: number }) => void; // Another of it, where it ends
		unique: (at: { track: number; placement: number }) => void;
		remove: (at: { track: number; placement: number }) => void; // The placement, and not its clip
		delete: (at: { track: number; placement: number }) => void; // The clip, and every placement of it
		loop: (at: { track: number; placement: number }) => void; // The loop, over the placement and its repeats, and on
		split: (at: { track: number; placement: number }, tick: number) => void; // In two there, each its own clip
	}

	let {
		id = '',
		doc,
		selection,
		barWidth,
		grid,
		height: dragged = null,
		tick,
		playing = false,
		loop,
		looping = false,
		readonly = false,
		badTracks,
		badClips,
		meter = () => null,
		patches = [],
		picking = null,
		solo = new Set(),
		active = true,
		onpick = () => {},
		onopen = () => {},
		onmute = () => {},
		onsolo = () => {},
		onselect,
		onchange,
		onnew,
		onlocate,
		onloop,
		onexpand = () => {},
		ontempo = () => {},
		onmix = () => {},
		onzoom = () => {},
		ondropped = () => {},
		onsignature,
		actions
	}: {
		id?: string; // Which timeline this is, for what the arrangement keeps about it between visits: which song lanes are open
		doc: Timeline;
		selection: Selection;
		barWidth: number;
		grid: number; // The arrangement's Snap, which clips, the loop and the Tempo lane go by, in ticks
		height?: number | null; // As tall as the tab strip below was dragged to make it, or null for its own height
		tick: number;
		playing?: boolean; // Whether the song is playing, which the view follows
		loop: Loop | null; // Where the loop is, or null for the whole song, which the strip shows whether or not it is on
		looping?: boolean; // Whether it is on
		readonly?: boolean;
		badTracks: Set<number>; // What the last compile complained about
		badClips: Set<string>;
		meter?: (track: number) => Ring | null; // What each track's level meter reads
		patches?: PatchLike[]; // What the heads name each track's patches by
		picking?: number | null; // The track whose head opened the patch picker
		solo?: ReadonlySet<number>; // The tracks soloed, which every other track is muted for
		active?: boolean; // Whether keys are for this editor, which they are while the Song view is on screen
		onpick?: (track: number, anchor: HTMLElement) => void; // A head's ▾, to choose another patch
		onopen?: (track: number, patch: string) => void; // A head's patch name, to edit that patch
		onmute?: (track: number) => void; // A head's M
		onsolo?: (track: number) => void; // A head's S
		onselect: (selection: Selection) => void;
		onchange: (doc: Timeline, selection?: Selection) => void;
		onnew: (track: number, tick: number, length?: number) => void; // A new clip there, a bar long unless it says
		onlocate: (tick: number) => void;
		onloop: (loop: Loop | null, on: boolean) => void; // A loop drawn, moved or stretched on the strip, or turned on or off
		onexpand?: (at: { track: number; placement: number }) => void; // A double-click on a clip, which opens its notes in the whole view
		ontempo?: (tempo: Tempo[] | null) => void; // The tempo while the Tempo lane is dragged, and null once the drag is over
		onmix?: (track: number, change: { gain?: number; pan?: number }, done: boolean) => void; // A head's fader or pan
		onzoom?: (by: number) => void; // Mod with the wheel, or a pinch: bars this many times as wide
		ondropped?: (drop: Dropped) => void; // A patch from the browser, or WAV files from the desktop, let go of here
		onsignature?: (at: { kind: 'meter' | 'key'; tick: number }) => void; // A change on the Time & key lane, to edit
		actions?: PlacementActions;
	} = $props();

	const ROW = 60;
	const BLOCK = ROW - 8;
	const RULER = 20;
	const LOOP = 14;
	const TOP = RULER + LOOP;
	const HANDLE = 7;
	const LOOP_EDGE = 6; // Pixels either side of a loop's end that take hold of that end rather than the whole loop
	const DRAG = 4; // Pixels a press moves before it is a drag rather than a click
	const MOST_REPEATS_DRAWN = 32; // A placement can repeat 100,000 times, and past this it's only a texture
	const MOST_BARS_DRAWN = 1000; // Each bar is a line and a number, so a song that long would stop the page

	type Gesture =
		| { kind: 'move'; track: number; index: number; grab: number; tick: number; row: number; copy: boolean }
		| { kind: 'repeat'; track: number; index: number; start: number; length: number; repeat: number }
		| { kind: 'loop'; from: number; to: number; x: number; drawn: boolean }
		| {
				kind: 'loop-change';
				hold: 'start' | 'end' | 'both';
				grab: number;
				x: number;
				was: Loop;
				now: Loop;
				moved: boolean;
		  }
		| { kind: 'draw'; track: number; row: number; x: number; from: number; to: number; drawn: boolean }
		| { kind: 'track'; track: number; from: number; y: number; to: number; moved: boolean };

	let svg: SVGSVGElement;
	let view: HTMLDivElement; // What scrolls, with the track heads held at its left
	let heads: HTMLDivElement;
	let gesture = $state.raw<Gesture | null>(null);
	// A clip's menu, and where along the song it was opened, which is where Split here splits it: the pointer, snapped to the
	// clips' grid, or the playhead for a menu opened from the keys.
	let menu = $state.raw<{ x: number; y: number; track: number; placement: number; clip: string; tick: number } | null>(
		null
	);

	// Where the song's bars fall (TimeSignature.ts). `barWidth` is how wide four beats of a quarter are, a bar of 4/4, so a zoom holds
	// across a change of meter.
	const songBars = $derived(barsOf(doc));
	const perTick = $derived(barWidth / (4 * doc.ppq));
	const drawnBars = $derived(
		songBars.between(0, Math.max(songBars.after(0, 16), songBars.after(songLength(doc), 8)), MOST_BARS_DRAWN)
	);
	const width = $derived((drawnBars.at(-1)?.end ?? 0) * perTick);
	// The song layer sits between the loop strip and the first track, with a lane for each thing that belongs to the whole song
	// rather than to one track. Which of its lanes are unfolded is the editor's, kept for each timeline.
	let unfolded = $state<ReadonlySet<string>>(new Set());
	const layer = $derived(layerHeight(unfolded));
	const tracksTop = $derived(TOP + layer);
	// While a patch that plays notes is dragged out of the browser, or WAV files are held over the arrangement, a row below the
	// tracks takes them for a new track. It is there from the start of a patch's drag, so where it can go is in sight.
	let dropAt = $state.raw<{ track: number | null; tick: number; kind: 'patch' | 'files' } | null>(null);
	const newRow = $derived(
		!readonly && ((patchDrag.patch !== null && !patchDrag.patch.insert) || dropAt?.kind === 'files')
	);
	const rows = $derived(doc.tracks.length + (newRow ? 1 : 0));
	const height = $derived(tracksTop + Math.max(rows, 1) * ROW);
	const ticksAt = (x: number) => x / perTick;

	function canvas(event: { clientX: number; clientY: number }) {
		const box = svg.getBoundingClientRect();
		return { x: event.clientX - box.left, y: event.clientY - box.top };
	}

	// A head names a patch by its name. An id that isn't in the library is shown as it is, and the compiler says what's wrong.
	const patchName = (id: string) => patches.find((patch) => patch.id === id)?.name ?? id;
	const trackName = (track: Track) => track.name || `Track ${track.id}`;

	const rowAt = (y: number) => Math.min(doc.tracks.length - 1, Math.max(0, Math.floor((y - tracksTop) / ROW)));

	onMount(() => {
		if (id) unfolded = keptOpen(localStorage.getItem(LANES_KEY), id);
	});

	function fold(lane: string, open = !unfolded.has(lane)) {
		const next = new Set(unfolded);
		if (open) next.add(lane);
		else next.delete(lane);
		unfolded = next;
		if (id) localStorage.setItem(LANES_KEY, keepOpen(localStorage.getItem(LANES_KEY), id, next));
	}

	const tempoScale = $derived(tempoRange(doc.tempo));

	interface Block {
		key: string;
		track: Track;
		index: number;
		row: number;
		tick: number;
		repeat: number;
		name: string;
		clip: Clip | undefined;
		start: number; // The window of its clip it plays
		length: number;
		transpose: number;
		ghost: boolean;
	}

	const blocks = $derived.by(() => {
		const list: Block[] = [];
		doc.tracks.forEach((track, row) => {
			track.placements.forEach((placed, index) => {
				const clip = doc.clips.find((candidate) => candidate.id === placed.clip);
				const block = {
					key: `${track.id}:${index}`,
					track,
					index,
					row,
					tick: placed.tick,
					repeat: placed.repeat,
					name: placed.clip,
					clip,
					...windowOf(doc, placed),
					transpose: placed.transpose ?? 0,
					ghost: false
				};
				const held =
					(gesture?.kind === 'move' || gesture?.kind === 'repeat') &&
					gesture.track === track.id &&
					gesture.index === index;
				if (held && gesture?.kind === 'repeat') block.repeat = gesture.repeat;
				if (held && gesture?.kind === 'move') {
					if (gesture.copy)
						list.push({ ...block, key: `${block.key}:copy`, tick: gesture.tick, row: gesture.row, ghost: true });
					else {
						block.tick = gesture.tick;
						block.row = gesture.row;
					}
				}
				list.push(block);
			});
		});
		return list;
	});

	// The notes a block plays, each repeat of its window.
	function sketch(block: Block) {
		const notes = block.clip?.notes.filter((n) => n.tick >= block.start && n.tick < block.start + block.length) ?? [];
		if (!notes.length) return '';
		const pitches = notes.map((note) => note.note);
		const low = Math.min(...pitches);
		const span = Math.max(Math.max(...pitches) - low, 12);
		const usable = BLOCK - 18;
		let d = '';
		for (let r = 0; r < Math.min(block.repeat, MOST_REPEATS_DRAWN); ++r) {
			for (const note of notes) {
				const at = note.tick - block.start;
				const x = (r * block.length + at) * perTick;
				const y = 15 + usable - ((note.note - low) / span) * usable;
				d += `M${x.toFixed(1)} ${y.toFixed(1)}h${Math.max(1, Math.min(note.dur, block.length - at) * perTick).toFixed(1)}`;
			}
		}
		return d;
	}

	function joins(block: Block) {
		if (!block.clip) return '';
		let d = '';
		for (let r = 1; r < Math.min(block.repeat, MOST_REPEATS_DRAWN); ++r)
			d += `M${(r * block.length * perTick).toFixed(1)} 0v${BLOCK}`;
		return d;
	}

	function title(block: Block) {
		const shift = block.transpose ? ` ${block.transpose > 0 ? '+' : ''}${block.transpose}` : '';
		return `${block.name}${shift}${block.repeat > 1 ? ` x${block.repeat}` : ''}`;
	}

	// A right-click chooses what it is on, and Ctrl-click is a right-click on a Mac, so neither starts a drag.
	const secondary = (event: PointerEvent) => event.button !== 0 || (event.ctrlKey && modKey() === 'Meta');

	function startMove(event: PointerEvent, block: Block) {
		event.stopPropagation();
		onselect({ track: block.track.id, placement: block.index });
		if (readonly || secondary(event)) return;
		const grab = ticksAt(canvas(event).x) - block.tick;
		gesture = {
			kind: 'move',
			track: block.track.id,
			index: block.index,
			grab,
			tick: block.tick,
			row: block.row,
			copy: modHeld(event)
		};
	}

	function startRepeat(event: PointerEvent, block: Block) {
		event.stopPropagation();
		onselect({ track: block.track.id, placement: block.index });
		if (readonly || secondary(event) || !block.clip || !block.length) return;
		gesture = {
			kind: 'repeat',
			track: block.track.id,
			index: block.index,
			start: block.tick,
			length: block.length,
			repeat: block.repeat
		};
	}

	// On the strip, a drag where there is no loop draws one, and a drag on the loop moves it, or stretches it by an end. A click
	// turns the loop on or off, as a cycle strip's does. Until a loop is drawn it is the whole song, which a drag anywhere
	// replaces.
	function startLoop(event: PointerEvent) {
		if (secondary(event)) return;
		const x = canvas(event).x;
		if (loop) {
			const [left, right] = [loop.start * perTick, loop.end * perTick];
			const hold =
				Math.abs(x - left) <= LOOP_EDGE
					? 'start'
					: Math.abs(x - right) <= LOOP_EDGE
						? 'end'
						: x > left && x < right
							? 'both'
							: null;
			if (hold) {
				gesture = { kind: 'loop-change', hold, grab: ticksAt(x), x, was: loop, now: loop, moved: false };
				return;
			}
		}
		const at = songBars.snap(ticksAt(x), grid);
		gesture = { kind: 'loop', from: at, to: at, x, drawn: false };
	}

	function changeLoop(held: Extract<Gesture, { kind: 'loop-change' }>, x: number): Loop {
		const { was } = held;
		if (held.hold === 'both') {
			const by = Math.max(-was.start, songBars.snap(ticksAt(x) - held.grab + was.start, grid) - was.start);
			return { start: was.start + by, end: was.end + by };
		}
		const at = songBars.snap(Math.max(0, ticksAt(x)), grid);
		const other = held.hold === 'start' ? was.end : was.start;
		if (at === other) return held.now; // A loop is never empty
		return { start: Math.min(at, other), end: Math.max(at, other) };
	}

	function pointerMove(event: PointerEvent) {
		if (!gesture) return;
		const at = canvas(event);
		if (gesture.kind === 'move') {
			gesture = { ...gesture, tick: songBars.snap(ticksAt(at.x) - gesture.grab, grid), row: rowAt(at.y) };
		} else if (gesture.kind === 'repeat') {
			const repeat = Math.round((ticksAt(at.x) - gesture.start) / gesture.length);
			gesture = { ...gesture, repeat: Math.max(1, repeat) };
		} else if (gesture.kind === 'draw') {
			if (!gesture.drawn && Math.abs(at.x - gesture.x) < DRAG) return;
			gesture = { ...gesture, to: Math.max(0, ticksAt(at.x)), drawn: true };
		} else if (gesture.kind === 'loop-change') {
			if (!gesture.moved && Math.abs(at.x - gesture.x) < DRAG) return;
			gesture = { ...gesture, now: changeLoop(gesture, at.x), moved: true };
		} else if (gesture.kind === 'track') {
			if (!gesture.moved && Math.abs(event.clientY - gesture.y) < DRAG) return;
			gesture = { ...gesture, to: rowAt(at.y), moved: true };
		} else {
			if (!gesture.drawn && Math.abs(at.x - gesture.x) < DRAG) return;
			gesture = { ...gesture, to: songBars.snap(ticksAt(at.x), grid), drawn: true };
		}
	}

	function finishMove(held: Extract<Gesture, { kind: 'move' }>) {
		const from = doc.tracks.find((track) => track.id === held.track);
		const placed = from?.placements[held.index];
		const to = doc.tracks[held.row];
		if (!placed || !to || (!held.copy && to.id === held.track && held.tick === placed.tick)) return;
		const next = held.copy
			? place(doc, to.id, placed.clip, held.tick)
			: movePlacement(doc, held.track, held.index, to.id, held.tick);
		const index = placementIndex(next, to.id, placed.clip, held.tick);
		onchange(held.copy ? setPlacement(next, to.id, index, { repeat: placed.repeat }) : next, {
			track: to.id,
			placement: index
		});
	}

	function pointerUp() {
		const held = gesture;
		gesture = null;
		if (!held) return;
		if (held.kind === 'track') {
			if (held.moved && held.to !== held.from) onchange(moveTrack(doc, held.track, held.to));
		} else if (held.kind === 'move') finishMove(held);
		else if (held.kind === 'repeat') onchange(setPlacement(doc, held.track, held.index, { repeat: held.repeat }));
		else if (held.kind === 'draw') {
			const drawn = held.drawn && drawnClip(doc, held.track, held.from, held.to);
			if (drawn) onnew(held.track, drawn.tick, drawn.length);
		} else if (held.kind === 'loop-change') {
			if (!held.moved) toggleLoop();
			else onloop(held.now, true);
		} else if (!held.drawn) toggleLoop();
		else if (held.from !== held.to)
			onloop({ start: Math.min(held.from, held.to), end: Math.max(held.from, held.to) }, true);
	}

	function toggleLoop() {
		onloop(loop, !looping);
	}

	// Esc cancels a drag, of a clip, its repeats, a new clip or the loop, and what the pointer then lets go of is nothing.
	const dragging = $derived(gesture !== null);
	$effect(() => {
		if (dragging) return escapeCancels(() => (gesture = null));
	});

	// A track head dragged up or down moves the track, which a line between the heads shows the place of. Its buttons, fields
	// and fader are its own, so a press on them doesn't drag.
	function startTrack(event: PointerEvent, track: Track) {
		if (readonly || secondary(event)) return;
		if ((event.target as Element).closest('input, select, .toggles, .patch, .mix, .meter')) return;
		const from = doc.tracks.findIndex((t) => t.id === track.id);
		gesture = { kind: 'track', track: track.id, from, y: event.clientY, to: from, moved: false };
	}

	// Where the line goes while a track is dragged: above the head it would take the place of.
	const trackLine = $derived.by(() => {
		if (gesture?.kind !== 'track' || !gesture.moved || gesture.to === gesture.from) return null;
		const below = gesture.to > gesture.from;
		return tracksTop + (gesture.to + (below ? 1 : 0)) * ROW;
	});

	// A drop's place: the track under the pointer, by its head or its row, or the row below the tracks for a new one, at the
	// bar under the pointer, or the playhead's bar from the heads. An insert has no notes to play, so it goes only on a track.
	// Nothing goes in an example, which can't change, or on the ruler, the loop strip or the song's lanes.
	function dropPlace(event: DragEvent) {
		const what = bringing(event);
		if (!what || readonly || (event.target as Element).closest('.band, .corner')) return null;
		const box = svg.getBoundingClientRect();
		const row = Math.floor((event.clientY - box.top - tracksTop) / ROW);
		const onHeads = !!(event.target as Element).closest('.heads');
		const over = onHeads ? tick : Math.max(0, ticksAt(event.clientX - box.left));
		const at = { tick: songBars.floor(over, BAR), kind: what.kind };
		if (row >= 0 && row < doc.tracks.length) return { ...at, track: doc.tracks[row].id };
		const insert = what.kind === 'patch' && what.patch.insert;
		return row >= doc.tracks.length && !insert ? { ...at, track: null } : null;
	}

	function dragOver(event: DragEvent) {
		const place = dropPlace(event);
		if (!place) {
			dropAt = null;
			return;
		}
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
		if (place.track !== dropAt?.track || place.tick !== dropAt?.tick || place.kind !== dropAt?.kind) dropAt = place;
	}

	function drop(event: DragEvent) {
		const place = dropPlace(event);
		dropAt = null;
		const what = bringing(event);
		if (!place || !what) return;
		event.preventDefault();
		const at = { track: place.track, tick: place.tick };
		if (what.kind === 'patch') ondropped({ kind: 'patch', patch: what.patch, ...at });
		else {
			const files = wavFiles(event);
			if (files.length) ondropped({ kind: 'files', files, ...at });
		}
	}

	// A drag that leaves for elsewhere on the page, or ends, takes the place it showed with it.
	function dragElsewhere(event: DragEvent) {
		if (dropAt && !view.contains(event.target as Node)) dropAt = null;
	}

	// What a head shows a drop would do to its track.
	const dropWords = $derived.by(() => {
		if (dropAt === null || dropAt.track === null) return null;
		if (dropAt.kind === 'files') return 'plays the WAV files';
		const patch = patchDrag.patch;
		return patch ? (patch.insert ? `+ ${patch.name}` : `plays ${patch.name}`) : null;
	});
	const newWords = $derived(
		dropAt?.kind === 'files' ? 'New track for the WAV files' : `New track: ${patchDrag.patch?.name ?? ''}`
	);

	// A press on an empty row chooses its track, and dragging across it draws a clip, whole bars long.
	function rowPressed(event: PointerEvent) {
		const at = canvas(event);
		const row = rowAt(at.y);
		const track = doc.tracks[row];
		if (!track) return;
		onselect({ track: track.id, placement: null });
		if (readonly || secondary(event)) return;
		const tick = Math.max(0, ticksAt(at.x));
		gesture = { kind: 'draw', track: track.id, row, x: at.x, from: tick, to: tick, drawn: false };
	}

	const drawing = $derived(
		gesture?.kind === 'draw' && gesture.drawn ? drawnClip(doc, gesture.track, gesture.from, gesture.to) : null
	);

	// A track head's menu, and an empty row's: what is done to the track, and a clip made or pasted where the row was pressed.
	// They are the clip's menu's neighbours, so one is open at a time.
	let other = $state.raw<{ x: number; y: number; label: string; items: MenuItem[]; note?: string } | null>(null);
	const note = $derived(readonly ? EXAMPLE_NOTE : undefined); // Why an example's menus grey out what would change it
	let renaming = $state<number | null>(null); // The track whose name is being typed in its head

	function headItems(track: Track): MenuItem[] {
		const index = doc.tracks.findIndex((t) => t.id === track.id);
		const at = songBars.floor(tick, BAR);
		return [
			{ label: 'Rename…', action: () => (renaming = track.id), disabled: readonly },
			{
				label: 'New clip at the playhead',
				action: () => onnew(track.id, at, songBars.after(at, TEMPLATE_BARS) - at),
				disabled: readonly
			},
			// Its head drags up or down too.
			{
				label: 'Move up',
				action: () => onchange(moveTrack(doc, track.id, index - 1)),
				disabled: readonly || index <= 0
			},
			{
				label: 'Move down',
				action: () => onchange(moveTrack(doc, track.id, index + 1)),
				disabled: readonly || index >= doc.tracks.length - 1
			},
			{ label: track.mute ? 'Unmute' : 'Mute', action: () => onmute(track.id), disabled: readonly },
			{ label: solo.has(track.id) ? 'Unsolo' : 'Solo', action: () => onsolo(track.id) },
			{
				label: 'Delete track',
				action: () => {
					onselect({ track: null, placement: null });
					onchange(removeTrack(doc, track.id));
				},
				disabled: readonly
			}
		];
	}

	function openHeadMenu(track: Track, on: Element, at: { x: number; y: number } | null) {
		gesture = null;
		menu = null;
		onselect({ track: track.id, placement: null });
		const box = on.getBoundingClientRect();
		other = {
			x: at?.x ?? box.left,
			y: at?.y ?? box.bottom,
			label: `Track ${trackName(track)}`,
			items: headItems(track),
			note
		};
	}

	function headMenu(event: MouseEvent, track: Track) {
		if ((event.target as Element).closest('input, .mix')) return; // A field's own menu, and the fader's
		event.preventDefault();
		openHeadMenu(track, event.currentTarget as Element, byKeys(event) ? null : { x: event.clientX, y: event.clientY });
	}

	function headKeys(event: KeyboardEvent, track: Track) {
		if (!matches(event, 'menu')) return;
		event.preventDefault();
		event.stopPropagation();
		openHeadMenu(track, event.currentTarget as Element, null);
	}

	function rowMenu(event: MouseEvent) {
		event.preventDefault();
		gesture = null;
		menu = null;
		const at = canvas(event);
		const track = doc.tracks[rowAt(at.y)];
		if (!track) return;
		const tick = songBars.floor(ticksAt(at.x), grid);
		const copied = clipboard.placement;
		const items: MenuItem[] = [{ label: 'New clip here', action: () => onnew(track.id, tick), disabled: readonly }];
		if (copied) {
			items.push({
				label: 'Paste here',
				keys: 'paste',
				disabled: readonly,
				action: () => {
					const pasted = pastePlacement(doc, track.id, tick, copied.what);
					if (pasted.index < 0) return;
					copied.pasted = { to: track.id, at: tick };
					const chosen = { track: track.id, placement: pasted.index };
					onchange(pasted.doc, chosen);
					onselect(chosen);
				}
			});
		}
		items.push(locateItem(at.x));
		other = { x: event.clientX, y: event.clientY, label: `Row of ${trackName(track)}`, items, note };
	}

	// What can be done anywhere along the song: the playhead, and the loop, which are the editor's, so an example has them too.
	const locateItem = (x: number): MenuItem => ({
		label: 'Move the playhead here',
		action: () => onlocate(songBars.snap(Math.max(0, ticksAt(x)), grid))
	});
	function barLoop(x: number): Loop {
		const start = songBars.floor(Math.max(0, ticksAt(x)), BAR);
		return { start, end: songBars.at(start).end };
	}

	// The ruler's menu and the loop strip's. A right-click there doesn't move the playhead or the loop as a click does.
	function bandMenu(event: MouseEvent, strip: 'ruler' | 'loop') {
		event.preventDefault();
		gesture = null;
		menu = null;
		const x = canvas(event).x;
		const loopItems: MenuItem[] = [
			{ label: 'Loop this bar', action: () => onloop(barLoop(x), true) },
			{ label: 'Loop the whole song', action: () => onloop(null, true), disabled: loop === null && looping }
		];
		const items =
			strip === 'ruler'
				? [locateItem(x), ...loopItems]
				: [{ label: looping ? 'Turn the loop off' : 'Turn the loop on', action: toggleLoop }, ...loopItems];
		other = { x: event.clientX, y: event.clientY, label: strip === 'ruler' ? 'Ruler' : 'Loop', items };
	}

	// The Time & key lane: a mark at each tick where the time signature or the key changes, or both, saying what it changes to.
	// A click on one edits it in the inspector, and its menu, or the lane's, adds and removes them.
	type Mark = { tick: number; bar: number; meter: number | null; key: number | null; words: string };
	const marks = $derived.by((): Mark[] => {
		const meters = metersOf(doc);
		const keys = keysOf(doc);
		const ticks = [...new Set([...meters, ...keys].map((change) => change.tick))].sort((a, b) => a - b);
		return ticks.map((at) => {
			const meter = meters.findIndex((change) => change.tick === at);
			const key = keys.findIndex((change) => change.tick === at);
			const words = [meter >= 0 ? meterText(meters[meter]) : '', key >= 0 ? keyName(keys[key]) : '']
				.filter(Boolean)
				.join(' · ');
			return {
				tick: at,
				bar: songBars.at(at).number,
				meter: meter >= 0 ? meter : null,
				key: key >= 0 ? key : null,
				words
			};
		});
	});

	// A change added where a bar starts, as what plays there already, for the inspector to change.
	function addSignature(kind: 'meter' | 'key', at: number) {
		onchange(kind === 'meter' ? addMeter(doc, at, songBars.meterAt(at)) : addKey(doc, at, keyAt(doc, at)));
		onsignature?.({ kind, tick: at });
	}

	function markItems(mark: Mark): MenuItem[] {
		const items: MenuItem[] = [];
		if (mark.meter !== null) {
			items.push({
				label: 'Change the time signature…',
				action: () => onsignature?.({ kind: 'meter', tick: mark.tick })
			});
		} else {
			items.push({
				label: 'Time signature from here…',
				action: () => addSignature('meter', mark.tick),
				disabled: readonly
			});
		}
		if (mark.key !== null) {
			items.push({ label: 'Change the key…', action: () => onsignature?.({ kind: 'key', tick: mark.tick }) });
		} else items.push({ label: 'Key from here…', action: () => addSignature('key', mark.tick), disabled: readonly });
		const meter = mark.meter;
		const key = mark.key;
		if (meter) {
			items.push({
				label: 'Remove the time signature change',
				action: () => onchange(removeMeter(doc, meter)),
				disabled: readonly
			});
		}
		if (key)
			items.push({ label: 'Remove the key change', action: () => onchange(removeKey(doc, key)), disabled: readonly });
		return items;
	}

	function signatureMenu(event: MouseEvent, mark: Mark | null) {
		event.preventDefault();
		event.stopPropagation();
		gesture = null;
		menu = null;
		const x = canvas(event).x;
		const at = songBars.floor(Math.max(0, ticksAt(x)), BAR);
		const bar = songBars.at(at).number;
		const items: MenuItem[] = mark
			? markItems(mark)
			: [
					{ label: `Time signature from bar ${bar}…`, action: () => addSignature('meter', at), disabled: readonly },
					{ label: `Key from bar ${bar}…`, action: () => addSignature('key', at), disabled: readonly }
				];
		items.push(locateItem(x));
		const label = mark ? `Time & key at bar ${mark.bar}` : 'Time & key lane';
		other = { x: event.clientX, y: event.clientY, label, items, note };
	}

	function markKeys(event: KeyboardEvent, mark: Mark) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onsignature?.({ kind: mark.meter !== null ? 'meter' : 'key', tick: mark.tick });
		} else if (matches(event, 'menu')) {
			event.preventDefault();
			const box = (event.currentTarget as Element).getBoundingClientRect();
			gesture = null;
			menu = null;
			const label = `Time & key at bar ${mark.bar}`;
			other = { x: box.left, y: box.bottom, label, items: [...markItems(mark), locateItem(mark.tick * perTick)], note };
		}
	}

	// Anywhere else on the tracks' canvas, such as a song with no tracks yet.
	function canvasMenu(event: MouseEvent) {
		if (event.defaultPrevented) return;
		event.preventDefault();
		gesture = null;
		menu = null;
		other = { x: event.clientX, y: event.clientY, label: 'Arrangement', items: [locateItem(canvas(event).x)] };
	}

	function renamed(track: Track, name: string) {
		renaming = null;
		if (name.trim() !== track.name) onchange(setTrack(doc, track.id, { name: name.trim() }));
	}

	// The field takes focus and its text is chosen, so typing replaces the name.
	function chooseText(input: HTMLInputElement) {
		input.focus();
		input.select();
	}

	function blockMenu(event: MouseEvent, block: Block) {
		event.preventDefault();
		event.stopPropagation();
		openBlockMenu(block, event.currentTarget as Element, byKeys(event) ? null : { x: event.clientX, y: event.clientY });
	}

	// The menu key and Shift+F10 open it at the clip rather than at a pointer.
	function openBlockMenu(block: Block, on: Element, at: { x: number; y: number } | null) {
		gesture = null;
		other = null;
		onselect({ track: block.track.id, placement: block.index });
		if (!actions) return;
		const box = on.getBoundingClientRect();
		menu = {
			x: at?.x ?? box.left,
			y: at?.y ?? box.bottom,
			track: block.track.id,
			placement: block.index,
			clip: block.name,
			tick: at ? songBars.snap(ticksAt(canvas({ clientX: at.x, clientY: at.y }).x), grid) : tick
		};
	}

	function blockKeys(event: KeyboardEvent, block: Block) {
		if (event.key === 'Enter') onselect({ track: block.track.id, placement: block.index });
		else if (matches(event, 'menu')) {
			event.preventDefault();
			event.stopPropagation();
			openBlockMenu(block, event.currentTarget as Element, null);
		}
	}

	const uses = (clip: string) => doc.tracks.flatMap((t) => t.placements).filter((p) => p.clip === clip).length;

	// The menu closes before an item acts, so each item holds the placement it is for rather than reading the menu.
	function placementItems(opened: NonNullable<typeof menu>): MenuItem[] {
		const at = { track: opened.track, placement: opened.placement };
		if (!actions) return [];
		const { open, duplicate, unique, remove, delete: deleteClip, loop: loopThis, split } = actions;
		const placed = doc.tracks.find((t) => t.id === opened.track)?.placements[opened.placement];
		const inside = (at: number) => !!placed && at > placed.tick && at < placed.tick + placementSpan(doc, placed);
		return [
			{ label: 'Open notes', action: () => open(at) },
			{ label: 'Loop this clip', action: () => loopThis(at) },
			{
				label: `Split here, at ${songBars.position(opened.tick)}`,
				action: () => split(at, opened.tick),
				disabled: readonly || !inside(opened.tick)
			},
			{
				label: 'Split at the playhead',
				keys: 'arrangement.split',
				action: () => split(at, tick),
				disabled: readonly || !inside(tick)
			},
			{ label: 'Copy', keys: 'copy', action: () => copyPlacement(at) },
			{ label: 'Duplicate after', keys: 'duplicate', action: () => duplicate(at), disabled: readonly },
			{ label: 'Make unique', action: () => unique(at), disabled: readonly || uses(opened.clip) < 2 },
			{ label: 'Remove from track', keys: 'arrangement.delete', action: () => remove(at), disabled: readonly },
			{ label: 'Delete clip', action: () => deleteClip(at), disabled: readonly }
		];
	}

	// Mod+C, or Copy in the clip's menu: the placement and its clip, for a paste in this song or another.
	function copyPlacement(at: { track: number; placement: number }) {
		const placed = doc.tracks.find((t) => t.id === at.track)?.placements[at.placement];
		const clip = placed && doc.clips.find((c) => c.id === placed.clip);
		if (!placed || !clip) return false;
		const what = { placement: placed, clip };
		clipboard.placement = { what, from: at.track, at: placed.tick, span: copiedSpan(what), pasted: null };
		return true;
	}

	function rowDoubled(event: MouseEvent) {
		if (readonly) return;
		const at = canvas(event);
		const track = doc.tracks[rowAt(at.y)];
		if (track) onnew(track.id, songBars.floor(ticksAt(at.x), grid));
	}

	// Mod+C, Mod+V and Mod+D for the chosen clip, while the Song view is on screen and the key isn't the roll's or a field's.
	// Mod+D is always taken, so the browser never bookmarks the page for it. A copy can come from an example, and a paste lands
	// on the chosen track, where `pasteAt` says.
	function keydown(event: KeyboardEvent) {
		const target = event.target as Element | null;
		const elsewhere = typingIn(target, event.key) || !!target?.closest?.('[data-testid="roll"], dialog');
		if (!active || event.defaultPrevented || elsewhere) return;
		const track = selection.track;
		const at = track !== null && selection.placement !== null ? { track, placement: selection.placement } : null;
		if (matches(event, 'duplicate')) {
			event.preventDefault();
			if (at && !readonly) actions?.duplicate(at);
		} else if (matches(event, 'arrangement.split') && at) {
			event.preventDefault();
			if (!readonly) actions?.split(at, tick);
		} else if (matches(event, 'copy') && at) {
			if (copyPlacement(at)) event.preventDefault();
		} else if (matches(event, 'paste') && clipboard.placement && !readonly) {
			const copied = clipboard.placement;
			const to = track ?? (doc.tracks.some((t) => t.id === copied.from) ? copied.from : doc.tracks[0]?.id);
			if (to === undefined) return;
			event.preventDefault();
			const tick = pasteAt(copied, copied.pasted, to);
			const pasted = pastePlacement(doc, to, tick, copied.what);
			if (pasted.index < 0) return;
			copied.pasted = { to, at: tick };
			const chosen = { track: to, placement: pasted.index };
			onchange(pasted.doc, chosen);
			onselect(chosen);
		}
	}

	// Mod with the wheel, or a pinch, zooms across, keeping what is under the pointer there, as the roll does. Anything else
	// scrolls, as it would anywhere.
	async function wheel(event: WheelEvent) {
		const action = wheelAction(event, modKey(), view.clientHeight);
		if (action.kind !== 'zoom' && action.kind !== 'rows') return;
		event.preventDefault();
		const before = barWidth;
		const at = event.clientX - view.getBoundingClientRect().left;
		onzoom(action.by);
		await settle();
		if (barWidth !== before) view.scrollLeft = anchored(view.scrollLeft, at, barWidth / before, heads.offsetWidth);
	}

	// While the song plays, the view keeps the playhead in sight. Where it was last is all this keeps, so it isn't state.
	let followed: number | null = null;
	$effect(() => {
		const at = tick * perTick;
		if (!playing) {
			followed = null;
			return;
		}
		const to = followScroll(at, followed, view.scrollLeft, view.clientWidth - heads.offsetWidth);
		if (to !== null) view.scrollLeft = to;
		followed = at;
	});

	const soloing = $derived(doc.tracks.some((track) => solo.has(track.id)));

	// While the loop is being drawn or changed, the strip shows where it would go, on.
	const shownLoop = $derived(
		gesture?.kind === 'loop' && gesture.drawn
			? { start: Math.min(gesture.from, gesture.to), end: Math.max(gesture.from, gesture.to) }
			: gesture?.kind === 'loop-change' && gesture.moved
				? gesture.now
				: (loop ?? wholeSong(doc))
	);
	const shownOn = $derived(
		(gesture?.kind === 'loop' && gesture.drawn) || (gesture?.kind === 'loop-change' && gesture.moved) || looping
	);
</script>

<svelte:window
	onpointermove={pointerMove}
	onpointerup={pointerUp}
	onkeydown={keydown}
	ondragover={dragElsewhere}
	ondrop={() => (dropAt = null)}
	ondragend={() => (dropAt = null)}
/>

<!-- A drop from the browser has its keys too: a head's ▾ and + Track. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="arrangement"
	class:sized={dragged !== null}
	style:height={dragged === null ? undefined : `${dragged}px`}
	bind:this={view}
	data-testid="arrangement-view"
	onwheel={wheel}
	ondragover={dragOver}
	ondrop={drop}
>
	<div class="heads" bind:this={heads}>
		<!-- The ruler's corner and the song layer's heads, which stay at the top as the tracks scroll under them. ▸ or a
			 double-click on a folded lane unfolds it, and ▾ folds it again. -->
		<div class="corner" style:padding-top="{TOP}px">
			<div class="layer" role="group" aria-label="Song lanes" style:height="{layer}px">
				{#each SONG_LANES as lane (lane.id)}
					{@const open = unfolded.has(lane.id)}
					<div
						class="lanehead"
						class:open
						style:height="{laneHeight(open, lane)}px"
						data-testid={`lane-head-${lane.id}`}
					>
						{#if lane.fixed}
							<span class="fixedname">{lane.name}</span>
						{:else}
							<button
								type="button"
								class="fold"
								aria-expanded={open}
								aria-label={`${lane.name} lane`}
								title={open ? `Fold the ${lane.name} lane` : `Unfold the ${lane.name} lane`}
								onclick={() => fold(lane.id)}><span aria-hidden="true">{open ? '▾' : '▸'}</span> {lane.name}</button
							>
						{/if}
						{#if open && lane.id === 'tempo'}
							<!-- The lane's scale, the BPM at its top and at its foot. -->
							<span class="scale" aria-hidden="true">
								<span>{bpmText(tempoScale.high)}</span>
								<span>{bpmText(tempoScale.low)}</span>
							</span>
						{/if}
					</div>
				{/each}
			</div>
		</div>
		{#each doc.tracks as track (track.id)}
			{@const names = track.slots.map(patchName)}
			{@const soloed = solo.has(track.id)}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="head"
				class:chosen={selection.track === track.id}
				class:silent={track.mute || (soloing && !soloed)}
				class:dropping={dropAt?.track === track.id}
				class:lifted={gesture?.kind === 'track' && gesture.moved && gesture.track === track.id}
				style:height="{ROW}px"
				data-testid={`head-${track.id}`}
				oncontextmenu={(event) => headMenu(event, track)}
				onpointerdown={(event) => startTrack(event, track)}
			>
				<div class="namerow">
					{#if renaming === track.id}
						<input
							class="rename"
							aria-label="Rename the track"
							value={track.name || trackName(track)}
							use:chooseText
							onkeydown={(event) => {
								if (event.key === 'Enter') renamed(track, event.currentTarget.value);
								else if (matches(event, 'escape')) {
									event.preventDefault();
									event.stopPropagation();
									renaming = null;
								}
							}}
							onblur={(event) => {
								if (renaming === track.id) renamed(track, event.currentTarget.value);
							}}
						/>
					{:else}
						<button
							type="button"
							class="select"
							class:problem={badTracks.has(track.id)}
							data-testid={`track-${track.id}`}
							aria-pressed={selection.track === track.id}
							title="Right-click or Shift+F10 for its menu: rename, a new clip, delete"
							onclick={() => onselect({ track: track.id, placement: null })}
							onkeydown={(event) => headKeys(event, track)}
							ondblclick={() => {
								if (!readonly) renaming = track.id;
							}}
						>
							<span class="title">{trackName(track)}</span>
						</button>
					{/if}
					<!-- Mute is the track's own, saved with the song as the Mixer's is. Solo is the editor's, and isn't saved. -->
					<div class="toggles" role="group" aria-label={`Mute and solo ${trackName(track)}`}>
						<button
							type="button"
							class="mute"
							aria-pressed={track.mute}
							aria-label="Mute"
							title={`Mute ${trackName(track)}. It's saved with the song.`}
							disabled={readonly}
							onclick={() => onmute(track.id)}>M</button
						>
						<button
							type="button"
							class="solo"
							aria-pressed={soloed}
							aria-label="Solo"
							title={`Solo ${trackName(track)}: hear only the soloed tracks. A solo isn't saved.`}
							onclick={() => onsolo(track.id)}>S</button
						>
					</div>
				</div>
				<!-- The track plays its patch: its name opens it, and ▾ chooses another. -->
				<div class="patch">
					{#if dropAt?.track === track.id && dropWords}
						<span class="dropwords" data-testid={`drop-words-${track.id}`}>{dropWords}</span>
					{:else if names.length}
						<button
							type="button"
							class="patchname"
							data-testid={`track-patch-${track.id}`}
							aria-label={`Open ${names[0]}`}
							title={names[0]}
							onclick={() => onopen(track.id, track.slots[0])}>{names[0]}</button
						>
						{#if names.length > 1}
							<span class="muted more" title={names.slice(1).join(', ')}>+{names.length - 1}</span>
						{/if}
					{:else}
						<span class="muted none">no patch</span>
					{/if}
					{#if !readonly}
						<button
							type="button"
							class="pick"
							aria-label={`Change the patch of ${trackName(track)}`}
							aria-haspopup="listbox"
							aria-expanded={picking === track.id}
							title="Choose another patch"
							onmousedown={(event) => event.preventDefault()}
							onclick={(event) => onpick(track.id, event.currentTarget)}>▾</button
						>
					{/if}
				</div>
				<!-- The track's volume and pan, which are the Mixer's, so either one moves the other. -->
				<HeadMix
					id={track.id}
					gain={track.gain}
					pan={track.pan}
					label={trackName(track)}
					{readonly}
					onmix={(change, done) => onmix(track.id, change, done)}
				/>
				<Meter ring={meter(track.id)} label={`Level of ${trackName(track)}`} />
			</div>
		{/each}
		{#if trackLine !== null}<div class="headline" style:top="{trackLine - 1}px"></div>{/if}
		{#if newRow}
			<div
				class="head newtrack"
				class:dropping={dropAt !== null && dropAt.track === null}
				style:height="{ROW}px"
				data-testid="new-track-head"
			>
				<span class="newwords">{newWords}</span>
			</div>
		{:else if !doc.tracks.length}
			<p class="muted empty">No tracks yet.</p>
		{/if}
	</div>

	<div class="scroller">
		<!-- The ruler, the loop strip and the song layer stay at the top as the tracks scroll, as a DAW's do. The tracks' canvas
			 starts under them, so a y on it is the same either way. -->
		<div class="band" style:height="{tracksTop}px" data-testid="arrangement-band">
			<svg {width} height={tracksTop}>
				<!-- Under the song layer's lanes, which draw over the bars and take the pointer there. -->
				<rect class="songlayer" y={TOP} {width} height={layer} />
				<rect
					class="ruler"
					{width}
					height={RULER}
					role="presentation"
					data-testid="ruler"
					onpointerdown={(event) => {
						if (!secondary(event)) onlocate(songBars.snap(ticksAt(canvas(event).x), grid));
					}}
					oncontextmenu={(event) => bandMenu(event, 'ruler')}
				/>
				<rect
					class="loopstrip"
					y={RULER}
					{width}
					height={LOOP}
					role="presentation"
					data-testid="loop-strip"
					onpointerdown={startLoop}
					oncontextmenu={(event) => bandMenu(event, 'loop')}
					><title
						>Drag for a loop. A click turns it on or off, and a drag on it moves it, or by an end stretches it.</title
					></rect
				>
				{#if shownLoop}
					<rect
						class="brace"
						class:off={!shownOn}
						x={shownLoop.start * perTick}
						y={RULER + 2}
						width={(shownLoop.end - shownLoop.start) * perTick}
						height={LOOP - 4}
						data-testid="loop-brace"
						data-on={shownOn}
						data-start={shownLoop.start}
						data-end={shownLoop.end}
					/>
				{/if}

				{#each drawnBars as bar (bar.number)}
					{#if bar.start >= 0}
						<line class="bar" x1={bar.start * perTick} x2={bar.start * perTick} y1={0} y2={tracksTop} />
						<text class="number" x={bar.start * perTick + 4} y={14}>{bar.number}</text>
					{/if}
				{/each}
				<line class="bar" x1={width} x2={width} y1={0} y2={tracksTop} />
				<!-- The Time & key lane, its marks over the bar lines. -->
				<g transform={`translate(0 ${TOP + laneTop(unfolded, 'signatures')})`} data-testid="signature-lane">
					<rect
						class="signatures"
						{width}
						height={laneHeight(false)}
						role="presentation"
						oncontextmenu={(event) => signatureMenu(event, null)}
						><title>Where the time signature and the key change. Right-click to add a change.</title></rect
					>
					{#each marks as mark (mark.tick)}
						<g
							class="mark"
							transform={`translate(${mark.tick * perTick} 0)`}
							role="button"
							tabindex="0"
							aria-label={`Time & key at bar ${mark.bar}: ${mark.words}`}
							data-testid={`signature-${mark.tick}`}
							onclick={() => onsignature?.({ kind: mark.meter !== null ? 'meter' : 'key', tick: mark.tick })}
							onkeydown={(event) => markKeys(event, mark)}
							oncontextmenu={(event) => signatureMenu(event, mark)}
						>
							<rect class="markground" width={mark.words.length * 6.4 + 8} height={laneHeight(false)} />
							<line class="markline" x1="0" x2="0" y1="0" y2={laneHeight(false)} />
							<text x="4" y="13">{mark.words}</text>
						</g>
					{/each}
				</g>
				<line class="playhead" x1={tick * perTick} x2={tick * perTick} y1={0} y2={tracksTop} />
			</svg>
			<TempoLane
				{doc}
				y={TOP + laneTop(unfolded, 'tempo')}
				{width}
				{perTick}
				{grid}
				open={unfolded.has('tempo')}
				{readonly}
				onchange={(next) => onchange(next)}
				onpreview={ontempo}
				onunfold={() => fold('tempo', true)}
			/>
		</div>
		<svg
			bind:this={svg}
			{width}
			{height}
			style:margin-top="{-tracksTop}px"
			role="application"
			aria-label="Arrangement"
			data-testid="arrangement"
			oncontextmenu={canvasMenu}
		>
			{#each doc.tracks as track, row (track.id)}
				<rect
					class="row"
					class:odd={row % 2 === 1}
					class:chosen={selection.track === track.id}
					class:dropping={dropAt?.track === track.id}
					y={tracksTop + row * ROW}
					{width}
					height={ROW}
					role="presentation"
					data-testid={`row-${track.id}`}
					onpointerdown={rowPressed}
					ondblclick={rowDoubled}
					oncontextmenu={rowMenu}
				/>
			{/each}

			{#if newRow}
				<rect
					class="row newrow"
					class:dropping={dropAt !== null && dropAt.track === null}
					y={tracksTop + doc.tracks.length * ROW}
					{width}
					height={ROW}
					data-testid="new-track-row"
				/>
			{/if}

			{#each drawnBars as bar (bar.number)}
				<line
					class="bar"
					x1={Math.max(0, bar.start) * perTick}
					x2={Math.max(0, bar.start) * perTick}
					y1={tracksTop}
					y2={height}
				/>
			{/each}

			{#each blocks as block (block.key)}
				{@const span = (block.clip ? block.length : 0) * block.repeat * perTick}
				<g
					class="block"
					class:ghost={block.ghost}
					class:chosen={selection.track === block.track.id && selection.placement === block.index}
					class:problem={badClips.has(block.name) || !block.clip}
					transform={`translate(${block.tick * perTick} ${tracksTop + block.row * ROW + 4})`}
					data-testid={`placement-${block.track.id}-${block.index}`}
					data-tick={block.tick}
					data-repeat={block.repeat}
				>
					<rect
						class="body"
						width={Math.max(span, 4)}
						height={BLOCK}
						rx="3"
						role="button"
						tabindex="0"
						aria-label={`${block.name} at bar ${songBars.at(block.tick).number}`}
						onpointerdown={(event) => startMove(event, block)}
						ondblclick={() => onexpand({ track: block.track.id, placement: block.index })}
						oncontextmenu={(event) => blockMenu(event, block)}
						onkeydown={(event) => blockKeys(event, block)}
					/>
					<path class="join" d={joins(block)} />
					<path class="sketch" d={sketch(block)} />
					<text class="name" x="5" y="12">{title(block)}</text>
					{#if !readonly}
						<rect
							class="handle"
							x={Math.max(span, 4) - HANDLE}
							width={HANDLE}
							height={BLOCK}
							rx="3"
							role="presentation"
							data-testid={`repeat-${block.track.id}-${block.index}`}
							onpointerdown={(event) => startRepeat(event, block)}
							oncontextmenu={(event) => blockMenu(event, block)}
						/>
					{/if}
				</g>
			{/each}

			{#if drawing && gesture?.kind === 'draw'}
				<g class="drawn" transform={`translate(${drawing.tick * perTick} ${tracksTop + gesture.row * ROW + 4})`}>
					<rect width={drawing.length * perTick} height={BLOCK} rx="3" data-testid="drawn-clip" />
					<text x="5" y="12"
						>{noteValue(
							drawing.length,
							doc.ppq,
							songBars.at(drawing.tick).beat * songBars.at(drawing.tick).meter.beats
						)}</text
					>
				</g>
			{/if}

			{#if dropAt !== null && dropAt.track === null}
				<!-- The clip the new track starts with, where it would go. -->
				<g class="drawn" transform={`translate(${dropAt.tick * perTick} ${tracksTop + doc.tracks.length * ROW + 4})`}>
					<rect
						width={(songBars.after(dropAt.tick, TEMPLATE_BARS) - dropAt.tick) * perTick}
						height={BLOCK}
						rx="3"
						data-testid="dropped-clip"
						data-tick={dropAt.tick}
					/>
					<text x="5" y="12">{newWords}</text>
				</g>
			{/if}
			{#if trackLine !== null}
				<line class="trackline" x1={0} x2={width} y1={trackLine} y2={trackLine} data-testid="track-line" />
			{/if}

			<line class="playhead" x1={tick * perTick} x2={tick * perTick} y1={0} y2={height} data-testid="playhead" />
		</svg>
	</div>
</div>

{#if other}
	<ContextMenu
		x={other.x}
		y={other.y}
		label={other.label}
		items={other.items}
		note={other.note}
		onclose={() => (other = null)}
	/>
{/if}
{#if menu}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		label={`Clip ${menu.clip}`}
		items={placementItems(menu)}
		{note}
		onclose={() => (menu = null)}
	/>
{/if}

<style>
	.arrangement {
		display: grid;
		grid-template-columns: 150px minmax(0, 1fr);
		align-items: start;
		border: 1px solid var(--line);
		border-radius: 6px;
		overflow: auto;
		background: #0d1117;
		min-width: 0;
		min-height: 0;
		/* As tall as the ruler, the loop strip and the tracks, so the notes below have the rest. Past about four tracks on a
		   laptop it scrolls instead, so the notes keep most of the height however many tracks there are. */
		max-height: 35vh;
		box-sizing: border-box;
	}
	/* Dragged to a height of its own, which a window made smaller still leaves the notes some of. */
	.arrangement.sized {
		max-height: calc(100vh - 14rem);
	}
	.heads {
		position: sticky;
		left: 0;
		z-index: 3; /* Over the band, which scrolls under it sideways */
		background: var(--panel);
		border-right: 1px solid var(--line);
		box-sizing: border-box;
		min-height: 100%;
	}
	.head {
		display: flex;
		flex-direction: column;
		user-select: none;
		box-sizing: border-box;
		border-top: 1px solid var(--line);
		padding: 0 0.4rem 0.35rem 0;
	}
	.head button {
		margin: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		text-align: left;
		overflow: hidden;
	}
	/* Not .name, which is the clip label's and lets the pointer through. */
	.namerow {
		flex: 1;
		min-height: 0;
		display: flex;
		align-items: flex-end;
	}
	.head .select {
		flex: 1;
		min-width: 0;
		height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		padding: 0 0.3rem 0 0.6rem;
		font-size: 0.8rem;
	}
	.rename {
		flex: 1;
		min-width: 0;
		margin: 0 0.3rem 0.1rem 0.4rem;
		padding: 0.05rem 0.25rem;
		font-size: 0.8rem;
	}
	.toggles {
		flex: none;
		display: flex;
		gap: 2px;
	}
	.head .toggles button {
		width: 1.2rem;
		padding: 0.05rem 0;
		border: 1px solid var(--line);
		border-radius: 3px;
		font-size: 0.68rem;
		font-weight: 600;
		line-height: 1.1;
		text-align: center;
		color: var(--muted);
	}
	.head .toggles .mute[aria-pressed='true'] {
		background: #d29922;
		border-color: #d29922;
		color: #0d1117;
	}
	.head .toggles .solo[aria-pressed='true'] {
		background: #1f6feb;
		border-color: #1f6feb;
		color: #fff;
	}
	/* Muted, or left out by a solo. */
	.head.silent .title {
		color: var(--muted);
	}
	.patch {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		min-width: 0;
		padding: 0 0 0.2rem 0.6rem;
		font-size: 0.72rem;
	}
	.head .patchname {
		flex: 0 1 auto;
		min-width: 0;
		padding: 0;
		color: var(--muted);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.head .patchname:hover {
		color: var(--accent);
		text-decoration: underline;
	}
	.head .pick {
		flex: none;
		margin-left: auto;
		padding: 0 0.3rem;
		font-size: 0.8rem;
		border-radius: 3px;
		color: var(--muted);
		line-height: 1.2;
	}
	.head .pick:hover,
	.head .pick[aria-expanded='true'] {
		color: var(--text);
		background: #ffffff14;
	}
	.more,
	.none {
		flex: none;
		white-space: nowrap;
	}
	.head :global(.meter) {
		margin-left: 0.6rem;
	}
	.head :global(.mix) {
		margin: 0 0 2px 0.6rem;
	}
	.head.chosen {
		background: #1a212b;
		box-shadow: inset 3px 0 0 var(--accent);
	}
	/* A drop's track, and the row a new one would take. */
	.head.dropping,
	.head.newtrack.dropping {
		box-shadow: inset 0 0 0 2px var(--accent);
	}
	.headline {
		position: absolute;
		left: 0;
		right: 0;
		height: 2px;
		background: var(--accent);
		pointer-events: none;
	}
	.head.lifted {
		opacity: 0.6;
	}
	.head.newtrack {
		justify-content: center;
		padding-left: 0.6rem;
		border-style: dashed;
	}
	.newwords,
	.dropwords {
		font-size: 0.72rem;
		color: var(--accent);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.head .select.problem {
		box-shadow: inset 3px 0 0 #f85149;
	}
	.title {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.empty {
		padding: 0.5rem;
		margin: 0;
		font-size: 0.8rem;
	}
	.scroller {
		position: relative;
		min-width: 0;
	}
	.corner,
	.band {
		position: sticky;
		top: 0;
		z-index: 2;
	}
	.corner {
		background: var(--panel);
		box-shadow: 0 1px 0 var(--line);
	}
	.band {
		box-shadow: 0 1px 0 var(--line);
	}
	/* The song layer's heads, over the tracks' and set apart from them. */
	.layer {
		background: #11161d;
	}
	.lanehead {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		box-sizing: border-box;
		padding: 0 0.4rem 0 0.25rem;
	}
	.lanehead .fold {
		margin: 0;
		padding: 0 0.2rem;
		border: 0;
		border-radius: 3px;
		background: transparent;
		color: var(--muted);
		font-size: 0.75rem;
		line-height: 17px;
		text-align: left;
		white-space: nowrap;
	}
	.lanehead .fixedname {
		padding: 0 0.2rem;
		color: var(--muted);
		font-size: 0.75rem;
		line-height: 17px;
		white-space: nowrap;
	}
	.signatures {
		fill: transparent;
	}
	.mark {
		cursor: pointer;
		outline: none;
	}
	.mark .markground {
		fill: transparent;
	}
	.mark .markline {
		stroke: var(--accent, #6cf);
	}
	.mark text {
		fill: var(--text);
		font-size: 11px;
		pointer-events: none;
	}
	.mark:hover .markground,
	.mark:focus-visible .markground {
		fill: #ffffff14;
	}
	.lanehead .fold:hover {
		color: var(--text);
		background: #ffffff14;
	}
	.scale {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		align-self: stretch;
		padding: 3px 0;
		font-size: 0.6rem;
		font-variant-numeric: tabular-nums;
		color: var(--muted);
		text-align: right;
	}
	.songlayer {
		fill: #11161d;
	}
	svg {
		display: block;
		user-select: none;
		touch-action: none;
	}
	.ruler {
		fill: var(--panel);
		cursor: pointer;
	}
	.loopstrip {
		fill: #161c24;
		cursor: ew-resize;
	}
	.brace {
		fill: #d2992255;
		stroke: #d29922;
		pointer-events: none;
	}
	/* Off, the loop is still there to see and take hold of, dimmed. */
	.brace.off {
		fill: #d2992214;
		stroke: #d2992270;
		stroke-dasharray: 3 2;
	}
	.row {
		fill: transparent;
	}
	.row.odd {
		fill: #ffffff05;
	}
	.row.chosen {
		fill: #58a6ff0d;
	}
	.row.dropping {
		fill: #58a6ff26;
	}
	.newrow {
		stroke: #58a6ff60;
		stroke-dasharray: 4 3;
	}
	.trackline {
		stroke: var(--accent);
		stroke-width: 2;
		pointer-events: none;
	}
	.bar {
		stroke: var(--line);
		pointer-events: none;
	}
	.number {
		fill: var(--muted);
		font-size: 10px;
		pointer-events: none;
	}
	.block .body {
		fill: #1f6feb40;
		stroke: #1f6feb;
		cursor: grab;
		outline: none;
	}
	.block.chosen .body {
		fill: #1f6feb70;
		stroke: var(--text);
	}
	.block.problem .body {
		stroke: #f85149;
		stroke-width: 2;
	}
	.block.ghost {
		opacity: 0.5;
	}
	.name {
		fill: var(--text);
		font-size: 10px;
		pointer-events: none;
	}
	.sketch {
		stroke: #79c0ff;
		stroke-width: 1.5;
		fill: none;
		pointer-events: none;
	}
	.join {
		stroke: #1f6feb80;
		fill: none;
		pointer-events: none;
	}
	.handle {
		fill: transparent;
		cursor: ew-resize;
	}
	.handle:hover {
		fill: #58a6ff60;
	}
	.playhead {
		stroke: #f0883e;
		pointer-events: none;
	}
	.drawn {
		pointer-events: none;
	}
	.drawn rect {
		fill: #1f6feb30;
		stroke: #79c0ff;
		stroke-dasharray: 4 3;
	}
	.drawn text {
		fill: var(--text);
		font-size: 11px;
	}
</style>
