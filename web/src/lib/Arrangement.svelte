<script lang="ts">
	import {
		barOf,
		drawnClip,
		movePlacement,
		noteValue,
		place,
		placementIndex,
		setPlacement,
		snapTick,
		songLength,
		ticksPerBar,
		windowOf,
		type Clip,
		type Track
	} from '#lib/TimelineEdit.ts';
	import ContextMenu, { type MenuItem } from '#lib/ContextMenu.svelte';
	import { followScroll } from '#lib/Follow.ts';
	import Meter from '#lib/Meter.svelte';
	import { isMod, onMac } from '#lib/Modifier.ts';
	import type { Timeline } from '#lib/Schema.ts';
	import type { Ring } from '#lib/ScopeMath.ts';

	export interface Selection {
		track: number | null;
		placement: number | null; // An index into that track's placements
	}

	// What a clip's right-click menu does, each to the placement it was opened on.
	export interface PlacementActions {
		open: (at: { track: number; placement: number }) => void;
		duplicate: (at: { track: number; placement: number }) => void; // Another of it, where it ends
		unique: (at: { track: number; placement: number }) => void;
		remove: (at: { track: number; placement: number }) => void; // The placement, and not its clip
		delete: (at: { track: number; placement: number }) => void; // The clip, and every placement of it
	}

	let {
		doc,
		selection,
		barWidth,
		grid,
		tick,
		playing = false,
		loop,
		readonly = false,
		badTracks,
		badClips,
		meter = () => null,
		onselect,
		onchange,
		onnew,
		onlocate,
		onloop,
		actions
	}: {
		doc: Timeline;
		selection: Selection;
		barWidth: number;
		grid: number;
		tick: number;
		playing?: boolean; // Whether the song is playing, which the view follows
		loop: { start: number; end: number } | null;
		readonly?: boolean;
		badTracks: Set<number>; // What the last compile complained about
		badClips: Set<string>;
		meter?: (track: number) => Ring | null; // What each track's level meter reads
		onselect: (selection: Selection) => void;
		onchange: (doc: Timeline, selection?: Selection) => void;
		onnew: (track: number, tick: number, length?: number) => void; // A new clip there, a bar long unless it says
		onlocate: (tick: number) => void;
		onloop: (start: number, end: number) => void;
		actions?: PlacementActions;
	} = $props();

	const ROW = 60;
	const BLOCK = ROW - 8;
	const RULER = 20;
	const LOOP = 14;
	const TOP = RULER + LOOP;
	const HANDLE = 7;
	const DRAG = 4; // Pixels a press moves before it is a drag rather than a click
	const MOST_REPEATS_DRAWN = 32; // A placement can repeat 100,000 times, and past this it's only a texture
	const MOST_BARS_DRAWN = 1000; // Each bar is a line and a number, so a song that long would stop the page

	type Gesture =
		| { kind: 'move'; track: number; index: number; grab: number; tick: number; row: number; copy: boolean }
		| { kind: 'repeat'; track: number; index: number; start: number; length: number; repeat: number }
		| { kind: 'loop'; from: number; to: number }
		| { kind: 'draw'; track: number; row: number; x: number; from: number; to: number; drawn: boolean };

	let svg: SVGSVGElement;
	let view: HTMLDivElement; // What scrolls, with the track heads held at its left
	let heads: HTMLDivElement;
	let gesture = $state.raw<Gesture | null>(null);
	let menu = $state.raw<{ x: number; y: number; track: number; placement: number; clip: string } | null>(null);

	const perTick = $derived(barWidth / ticksPerBar(doc));
	const bars = $derived(Math.min(MOST_BARS_DRAWN, Math.max(16, Math.ceil(songLength(doc) / ticksPerBar(doc)) + 8)));
	const width = $derived(bars * barWidth);
	const height = $derived(TOP + Math.max(doc.tracks.length, 1) * ROW);
	const ticksAt = (x: number) => x / perTick;

	function canvas(event: { clientX: number; clientY: number }) {
		const box = svg.getBoundingClientRect();
		return { x: event.clientX - box.left, y: event.clientY - box.top };
	}

	const rowAt = (y: number) => Math.min(doc.tracks.length - 1, Math.max(0, Math.floor((y - TOP) / ROW)));

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
	const secondary = (event: PointerEvent) => event.button !== 0 || (event.ctrlKey && onMac());

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
			copy: isMod(event)
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

	function startLoop(event: PointerEvent) {
		const at = snapTick(ticksAt(canvas(event).x), grid);
		gesture = { kind: 'loop', from: at, to: at };
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
		} else {
			gesture = { ...gesture, to: snapTick(ticksAt(at.x), grid) };
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
		} else if (held.from === held.to) onloop(0, 0);
		else onloop(Math.min(held.from, held.to), Math.max(held.from, held.to));
	}

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
		gesture = null;
		onselect({ track: block.track.id, placement: block.index });
		if (readonly || !actions) return;
		// The menu key and Shift+F10 open it at the clip rather than at a pointer.
		const box = (event.currentTarget as Element).getBoundingClientRect();
		const keyed = event.clientX === 0 && event.clientY === 0;
		menu = {
			x: keyed ? box.left : event.clientX,
			y: keyed ? box.bottom : event.clientY,
			track: block.track.id,
			placement: block.index,
			clip: block.name
		};
	}

	const uses = (clip: string) => doc.tracks.flatMap((t) => t.placements).filter((p) => p.clip === clip).length;

	// The menu closes before an item acts, so each item holds the placement it is for rather than reading the menu.
	function placementItems(opened: NonNullable<typeof menu>): MenuItem[] {
		const at = { track: opened.track, placement: opened.placement };
		if (!actions) return [];
		const { open, duplicate, unique, remove, delete: deleteClip } = actions;
		return [
			{ label: 'Open notes', action: () => open(at) },
			{ label: 'Duplicate after', action: () => duplicate(at) },
			{ label: 'Make unique', action: () => unique(at), disabled: uses(opened.clip) < 2 },
			{ label: 'Remove from track', action: () => remove(at) },
			{ label: 'Delete clip', action: () => deleteClip(at) }
		];
	}

	function rowDoubled(event: MouseEvent) {
		if (readonly) return;
		const at = canvas(event);
		const track = doc.tracks[rowAt(at.y)];
		if (track) onnew(track.id, Math.floor(ticksAt(at.x) / grid) * grid);
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

	const shownLoop = $derived(
		gesture?.kind === 'loop'
			? { start: Math.min(gesture.from, gesture.to), end: Math.max(gesture.from, gesture.to) }
			: loop
	);
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} />

<div class="arrangement" bind:this={view} data-testid="arrangement-view">
	<div class="heads" bind:this={heads} style:padding-top="{TOP}px">
		{#each doc.tracks as track (track.id)}
			<div class="head" class:chosen={selection.track === track.id} style:height="{ROW}px">
				<button
					type="button"
					class:problem={badTracks.has(track.id)}
					data-testid={`track-${track.id}`}
					aria-pressed={selection.track === track.id}
					onclick={() => onselect({ track: track.id, placement: null })}
				>
					<span class="title">{track.name || `Track ${track.id}`}</span>
					<span class="muted">{track.slots.join(', ') || 'no patch'}{track.mute ? ', muted' : ''}</span>
				</button>
				<Meter ring={meter(track.id)} label={`Level of ${track.name || `Track ${track.id}`}`} />
			</div>
		{:else}
			<p class="muted empty">No tracks yet.</p>
		{/each}
	</div>

	<div class="scroller">
		<svg bind:this={svg} {width} {height} role="application" aria-label="Arrangement" data-testid="arrangement">
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
			/>
			{#if shownLoop}
				<rect
					class="brace"
					x={shownLoop.start * perTick}
					y={RULER + 2}
					width={(shownLoop.end - shownLoop.start) * perTick}
					height={LOOP - 4}
					data-testid="loop-brace"
				/>
			{/if}

			{#each doc.tracks as track, row (track.id)}
				<rect
					class="row"
					class:odd={row % 2 === 1}
					class:chosen={selection.track === track.id}
					y={TOP + row * ROW}
					{width}
					height={ROW}
					role="presentation"
					data-testid={`row-${track.id}`}
					onpointerdown={rowPressed}
					ondblclick={rowDoubled}
				/>
			{/each}

			{#each { length: bars + 1 }, bar}
				<line class="bar" x1={bar * barWidth} x2={bar * barWidth} y1={0} y2={height} />
				{#if bar < bars}
					<text class="number" x={bar * barWidth + 4} y={14}>{bar + 1}</text>
				{/if}
			{/each}

			{#each blocks as block (block.key)}
				{@const span = (block.clip ? block.length : 0) * block.repeat * perTick}
				<g
					class="block"
					class:ghost={block.ghost}
					class:chosen={selection.track === block.track.id && selection.placement === block.index}
					class:problem={badClips.has(block.name) || !block.clip}
					transform={`translate(${block.tick * perTick} ${TOP + block.row * ROW + 4})`}
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
						oncontextmenu={(event) => blockMenu(event, block)}
						onkeydown={(event) => {
							if (event.key === 'Enter') onselect({ track: block.track.id, placement: block.index });
						}}
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
				<g class="drawn" transform={`translate(${drawing.tick * perTick} ${TOP + gesture.row * ROW + 4})`}>
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
		height: 100%;
		box-sizing: border-box;
	}
	.heads {
		position: sticky;
		left: 0;
		z-index: 1;
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
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		justify-content: center;
		width: 100%;
		text-align: left;
		border: 0;
		border-radius: 0;
		background: transparent;
		font-size: 0.8rem;
		overflow: hidden;
	}
	.head :global(.meter) {
		margin-left: 0.6rem;
	}
	.head.chosen {
		background: #1a212b;
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.head button.problem {
		box-shadow: inset 3px 0 0 #f85149;
	}
	.title {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.head .muted {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 0.72rem;
	}
	.empty {
		padding: 0.5rem;
		margin: 0;
		font-size: 0.8rem;
	}
	.scroller {
		min-width: 0;
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
