<script lang="ts">
	import { onMount, tick as settle } from 'svelte';
	import {
		barOf,
		copiedSpan,
		drawnClip,
		movePlacement,
		noteValue,
		pasteAt,
		pastePlacement,
		place,
		placementIndex,
		setPlacement,
		snapTick,
		songLength,
		ticksPerBar,
		windowOf,
		type Clip,
		type PatchLike,
		type Tempo,
		type Track
	} from '#lib/TimelineEdit.ts';
	import { clipboard } from '#lib/Clipboard.ts';
	import ContextMenu, { type MenuItem } from '#lib/ContextMenu.svelte';
	import { escapeCancels } from '#lib/Drag.ts';
	import { followScroll } from '#lib/Follow.ts';
	import HeadMix from '#lib/HeadMix.svelte';
	import Meter from '#lib/Meter.svelte';
	import { anchored, wheelAction } from '#lib/RollView.ts';
	import type { Timeline } from '#lib/Schema.ts';
	import type { Ring } from '#lib/ScopeMath.ts';
	import { matches, modHeld, modKey, typingIn } from '#lib/Shortcuts.ts';
	import { LANES_KEY, SONG_LANES, keepOpen, keptOpen, laneHeight, layerHeight } from '#lib/SongLayer.ts';
	import TempoLane from '#lib/TempoLane.svelte';
	import { bpmText, tempoRange } from '#lib/TempoLane.ts';
	import { wholeSong } from '#lib/Transport.ts';

	export interface Selection {
		track: number | null;
		placement: number | null; // An index into that track's placements
	}

	// The loop, in the song's ticks. It is the editor's, not the song's, so it isn't saved.
	export interface Loop {
		start: number;
		end: number;
	}

	// What a clip's right-click menu does, each to the placement it was opened on.
	export interface PlacementActions {
		open: (at: { track: number; placement: number }) => void;
		duplicate: (at: { track: number; placement: number }) => void; // Another of it, where it ends
		unique: (at: { track: number; placement: number }) => void;
		remove: (at: { track: number; placement: number }) => void; // The placement, and not its clip
		delete: (at: { track: number; placement: number }) => void; // The clip, and every placement of it
		loop: (at: { track: number; placement: number }) => void; // The loop, over the placement and its repeats, and on
	}

	let {
		id = '',
		doc,
		selection,
		barWidth,
		grid,
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
		actions
	}: {
		id?: string; // Which timeline this is, for what the arrangement keeps about it between visits: which song lanes are open
		doc: Timeline;
		selection: Selection;
		barWidth: number;
		grid: number;
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
		| { kind: 'draw'; track: number; row: number; x: number; from: number; to: number; drawn: boolean };

	let svg: SVGSVGElement;
	let view: HTMLDivElement; // What scrolls, with the track heads held at its left
	let heads: HTMLDivElement;
	let gesture = $state.raw<Gesture | null>(null);
	let menu = $state.raw<{ x: number; y: number; track: number; placement: number; clip: string } | null>(null);

	const perTick = $derived(barWidth / ticksPerBar(doc));
	const bars = $derived(Math.min(MOST_BARS_DRAWN, Math.max(16, Math.ceil(songLength(doc) / ticksPerBar(doc)) + 8)));
	const width = $derived(bars * barWidth);
	// The song layer sits between the loop strip and the first track, with a lane for each thing that belongs to the whole song
	// rather than to one track. Which of its lanes are unfolded is the editor's, kept for each timeline.
	let unfolded = $state<ReadonlySet<string>>(new Set());
	const layer = $derived(layerHeight(unfolded));
	const tracksTop = $derived(TOP + layer);
	const height = $derived(tracksTop + Math.max(doc.tracks.length, 1) * ROW);
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
		if (event.button !== 0) return;
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
		const at = snapTick(ticksAt(x), grid);
		gesture = { kind: 'loop', from: at, to: at, x, drawn: false };
	}

	function changeLoop(held: Extract<Gesture, { kind: 'loop-change' }>, x: number): Loop {
		const { was } = held;
		if (held.hold === 'both') {
			const by = Math.max(-was.start, snapTick(ticksAt(x) - held.grab + was.start, grid) - was.start);
			return { start: was.start + by, end: was.end + by };
		}
		const at = snapTick(Math.max(0, ticksAt(x)), grid);
		const other = held.hold === 'start' ? was.end : was.start;
		if (at === other) return held.now; // A loop is never empty
		return { start: Math.min(at, other), end: Math.max(at, other) };
	}

	function pointerMove(event: PointerEvent) {
		if (!gesture) return;
		const at = canvas(event);
		if (gesture.kind === 'move') {
			gesture = { ...gesture, tick: snapTick(ticksAt(at.x) - gesture.grab, grid), row: rowAt(at.y) };
		} else if (gesture.kind === 'repeat') {
			const repeat = Math.round((ticksAt(at.x) - gesture.start) / gesture.length);
			gesture = { ...gesture, repeat: Math.max(1, repeat) };
		} else if (gesture.kind === 'draw') {
			if (!gesture.drawn && Math.abs(at.x - gesture.x) < DRAG) return;
			gesture = { ...gesture, to: Math.max(0, ticksAt(at.x)), drawn: true };
		} else if (gesture.kind === 'loop-change') {
			if (!gesture.moved && Math.abs(at.x - gesture.x) < DRAG) return;
			gesture = { ...gesture, now: changeLoop(gesture, at.x), moved: true };
		} else {
			if (!gesture.drawn && Math.abs(at.x - gesture.x) < DRAG) return;
			gesture = { ...gesture, to: snapTick(ticksAt(at.x), grid), drawn: true };
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
		if (held.kind === 'move') finishMove(held);
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

	function blockMenu(event: MouseEvent, block: Block) {
		event.preventDefault();
		event.stopPropagation();
		const keyed = event.clientX === 0 && event.clientY === 0;
		openBlockMenu(block, event.currentTarget as Element, keyed ? null : { x: event.clientX, y: event.clientY });
	}

	// The menu key and Shift+F10 open it at the clip rather than at a pointer.
	function openBlockMenu(block: Block, on: Element, at: { x: number; y: number } | null) {
		gesture = null;
		onselect({ track: block.track.id, placement: block.index });
		if (readonly || !actions) return;
		const box = on.getBoundingClientRect();
		menu = {
			x: at?.x ?? box.left,
			y: at?.y ?? box.bottom,
			track: block.track.id,
			placement: block.index,
			clip: block.name
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
		const { open, duplicate, unique, remove, delete: deleteClip, loop: loopThis } = actions;
		return [
			{ label: 'Open notes', action: () => open(at) },
			{ label: 'Loop this clip', action: () => loopThis(at) },
			{ label: 'Duplicate after', keys: 'duplicate', action: () => duplicate(at) },
			{ label: 'Make unique', action: () => unique(at), disabled: uses(opened.clip) < 2 },
			{ label: 'Remove from track', keys: 'arrangement.delete', action: () => remove(at) },
			{ label: 'Delete clip', action: () => deleteClip(at) }
		];
	}

	function rowDoubled(event: MouseEvent) {
		if (readonly) return;
		const at = canvas(event);
		const track = doc.tracks[rowAt(at.y)];
		if (track) onnew(track.id, Math.floor(ticksAt(at.x) / grid) * grid);
	}

	// Mod+C, Mod+V and Mod+D for the chosen clip, while the Song view is on screen and the key isn't the roll's or a field's.
	// Mod+D is always taken, so the browser never bookmarks the page for it. A copy can come from an example, and a paste lands
	// on the chosen track, where `pasteAt` says.
	function keydown(event: KeyboardEvent) {
		const target = event.target as Element | null;
		const elsewhere = typingIn(target) || !!target?.closest?.('[data-testid="roll"], dialog');
		if (!active || event.defaultPrevented || elsewhere) return;
		const track = selection.track;
		const at = track !== null && selection.placement !== null ? { track, placement: selection.placement } : null;
		if (matches(event, 'duplicate')) {
			event.preventDefault();
			if (at && !readonly) actions?.duplicate(at);
		} else if (matches(event, 'copy') && at) {
			const placed = doc.tracks.find((t) => t.id === at.track)?.placements[at.placement];
			const clip = placed && doc.clips.find((c) => c.id === placed.clip);
			if (!placed || !clip) return;
			event.preventDefault();
			const what = { placement: placed, clip };
			clipboard.placement = { what, from: at.track, at: placed.tick, span: copiedSpan(what), pasted: null };
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

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} onkeydown={keydown} />

<div class="arrangement" bind:this={view} data-testid="arrangement-view" onwheel={wheel}>
	<div class="heads" bind:this={heads}>
		<!-- The ruler's corner and the song layer's heads, which stay at the top as the tracks scroll under them. ▸ or a
			 double-click on a folded lane unfolds it, and ▾ folds it again. -->
		<div class="corner" style:padding-top="{TOP}px">
			<div class="layer" role="group" aria-label="Song lanes" style:height="{layer}px">
				{#each SONG_LANES as lane (lane.id)}
					{@const open = unfolded.has(lane.id)}
					<div class="lanehead" class:open style:height="{laneHeight(open)}px" data-testid={`lane-head-${lane.id}`}>
						<button
							type="button"
							class="fold"
							aria-expanded={open}
							aria-label={`${lane.name} lane`}
							title={open ? `Fold the ${lane.name} lane` : `Unfold the ${lane.name} lane`}
							onclick={() => fold(lane.id)}><span aria-hidden="true">{open ? '▾' : '▸'}</span> {lane.name}</button
						>
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
			<div
				class="head"
				class:chosen={selection.track === track.id}
				class:silent={track.mute || (soloing && !soloed)}
				style:height="{ROW}px"
			>
				<div class="namerow">
					<button
						type="button"
						class="select"
						class:problem={badTracks.has(track.id)}
						data-testid={`track-${track.id}`}
						aria-pressed={selection.track === track.id}
						onclick={() => onselect({ track: track.id, placement: null })}
					>
						<span class="title">{trackName(track)}</span>
					</button>
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
					{#if names.length}
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
		{:else}
			<p class="muted empty">No tracks yet.</p>
		{/each}
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
					onpointerdown={(event) => onlocate(snapTick(ticksAt(canvas(event).x), grid))}
				/>
				<rect
					class="loopstrip"
					y={RULER}
					{width}
					height={LOOP}
					role="presentation"
					data-testid="loop-strip"
					onpointerdown={startLoop}
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

				{#each { length: bars + 1 }, bar}
					<line class="bar" x1={bar * barWidth} x2={bar * barWidth} y1={0} y2={tracksTop} />
					{#if bar < bars}
						<text class="number" x={bar * barWidth + 4} y={14}>{bar + 1}</text>
					{/if}
				{/each}
				<line class="playhead" x1={tick * perTick} x2={tick * perTick} y1={0} y2={tracksTop} />
			</svg>
			<TempoLane
				{doc}
				y={TOP}
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
		>
			{#each doc.tracks as track, row (track.id)}
				<rect
					class="row"
					class:odd={row % 2 === 1}
					class:chosen={selection.track === track.id}
					y={tracksTop + row * ROW}
					{width}
					height={ROW}
					role="presentation"
					data-testid={`row-${track.id}`}
					onpointerdown={rowPressed}
					ondblclick={rowDoubled}
				/>
			{/each}

			{#each { length: bars + 1 }, bar}
				<line class="bar" x1={bar * barWidth} x2={bar * barWidth} y1={tracksTop} y2={height} />
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
						aria-label={`${block.name} at bar ${barOf(block.tick, doc.ppq)}`}
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
					<text x="5" y="12">{noteValue(drawing.length, doc.ppq)}</text>
				</g>
			{/if}

			<line class="playhead" x1={tick * perTick} x2={tick * perTick} y1={0} y2={height} data-testid="playhead" />
		</svg>
	</div>
</div>

{#if menu}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		label={`Clip ${menu.clip}`}
		items={placementItems(menu)}
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
		font-size: 0.68rem;
		line-height: 17px;
		text-align: left;
		white-space: nowrap;
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
