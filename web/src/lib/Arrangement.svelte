<script lang="ts">
	import {
		barOf,
		movePlacement,
		place,
		placementIndex,
		setPlacement,
		snapTick,
		songLength,
		ticksPerBar,
		type Clip,
		type Track
	} from '#lib/TimelineEdit.ts';
	import type { Timeline } from '#lib/Schema.ts';

	export interface Selection {
		track: number | null;
		placement: number | null; // An index into that track's placements
	}

	let {
		doc,
		selection,
		barWidth,
		grid,
		tick,
		loop,
		readonly = false,
		badTracks,
		badClips,
		onselect,
		onchange,
		onnew,
		onlocate,
		onloop
	}: {
		doc: Timeline;
		selection: Selection;
		barWidth: number;
		grid: number;
		tick: number;
		loop: { start: number; end: number } | null;
		readonly?: boolean;
		badTracks: Set<number>; // What the last compile complained about
		badClips: Set<string>;
		onselect: (selection: Selection) => void;
		onchange: (doc: Timeline, selection?: Selection) => void;
		onnew: (track: number, tick: number) => void;
		onlocate: (tick: number) => void;
		onloop: (start: number, end: number) => void;
	} = $props();

	const ROW = 60;
	const BLOCK = ROW - 8;
	const RULER = 20;
	const LOOP = 14;
	const TOP = RULER + LOOP;
	const HANDLE = 7;
	const MOST_REPEATS_DRAWN = 32; // A placement can repeat 100,000 times, and past this it's only a texture

	type Gesture =
		| { kind: 'move'; track: number; index: number; grab: number; tick: number; row: number; copy: boolean }
		| { kind: 'repeat'; track: number; index: number; start: number; length: number; repeat: number }
		| { kind: 'loop'; from: number; to: number };

	let svg: SVGSVGElement;
	let gesture = $state.raw<Gesture | null>(null);

	const perTick = $derived(barWidth / ticksPerBar(doc));
	const bars = $derived(Math.max(16, Math.ceil(songLength(doc) / ticksPerBar(doc)) + 8));
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
					ghost: false
				};
				const held = gesture && gesture.kind !== 'loop' && gesture.track === track.id && gesture.index === index;
				if (held && gesture?.kind === 'repeat') block.repeat = gesture.repeat;
				if (held && gesture?.kind === 'move') {
					if (gesture.copy) list.push({ ...block, key: `${block.key}:copy`, tick: gesture.tick, row: gesture.row, ghost: true });
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

	function sketch(clip: Clip | undefined, repeat: number) {
		if (!clip?.notes.length) return '';
		const pitches = clip.notes.map((note) => note.note);
		const low = Math.min(...pitches);
		const span = Math.max(Math.max(...pitches) - low, 12);
		const usable = BLOCK - 18;
		let d = '';
		for (let r = 0; r < Math.min(repeat, MOST_REPEATS_DRAWN); ++r) {
			for (const note of clip.notes) {
				const x = (r * clip.length + note.tick) * perTick;
				const y = 15 + usable - ((note.note - low) / span) * usable;
				d += `M${x.toFixed(1)} ${y.toFixed(1)}h${Math.max(1, Math.min(note.dur, clip.length - note.tick) * perTick).toFixed(1)}`;
			}
		}
		return d;
	}

	function joins(clip: Clip | undefined, repeat: number) {
		if (!clip) return '';
		let d = '';
		for (let r = 1; r < Math.min(repeat, MOST_REPEATS_DRAWN); ++r) d += `M${(r * clip.length * perTick).toFixed(1)} 0v${BLOCK}`;
		return d;
	}

	function startMove(event: PointerEvent, block: Block) {
		event.stopPropagation();
		onselect({ track: block.track.id, placement: block.index });
		if (readonly) return;
		const grab = ticksAt(canvas(event).x) - block.tick;
		gesture = { kind: 'move', track: block.track.id, index: block.index, grab, tick: block.tick, row: block.row, copy: event.altKey };
	}

	function startRepeat(event: PointerEvent, block: Block) {
		event.stopPropagation();
		onselect({ track: block.track.id, placement: block.index });
		if (readonly || !block.clip) return;
		gesture = {
			kind: 'repeat',
			track: block.track.id,
			index: block.index,
			start: block.tick,
			length: block.clip.length,
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
		onchange(held.copy ? setPlacement(next, to.id, index, { repeat: placed.repeat }) : next, { track: to.id, placement: index });
	}

	function pointerUp() {
		const held = gesture;
		gesture = null;
		if (!held) return;
		if (held.kind === 'move') finishMove(held);
		else if (held.kind === 'repeat') onchange(setPlacement(doc, held.track, held.index, { repeat: held.repeat }));
		else if (held.from === held.to) onloop(0, 0);
		else onloop(Math.min(held.from, held.to), Math.max(held.from, held.to));
	}

	function rowPressed(event: PointerEvent) {
		const row = rowAt(canvas(event).y);
		if (doc.tracks[row]) onselect({ track: doc.tracks[row].id, placement: null });
	}

	function rowDoubled(event: MouseEvent) {
		if (readonly) return;
		const at = canvas(event);
		const track = doc.tracks[rowAt(at.y)];
		if (track) onnew(track.id, Math.floor(ticksAt(at.x) / grid) * grid);
	}

	const shownLoop = $derived(
		gesture?.kind === 'loop' ? { start: Math.min(gesture.from, gesture.to), end: Math.max(gesture.from, gesture.to) } : loop
	);
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} />

<div class="arrangement">
	<div class="heads" style:padding-top="{TOP}px">
		{#each doc.tracks as track (track.id)}
			<button
				type="button"
				class="head"
				class:chosen={selection.track === track.id}
				class:problem={badTracks.has(track.id)}
				style:height="{ROW}px"
				data-testid={`track-${track.id}`}
				aria-pressed={selection.track === track.id}
				onclick={() => onselect({ track: track.id, placement: null })}
			>
				<span class="title">{track.name || `Track ${track.id}`}</span>
				<span class="muted">{track.slots.join(', ') || 'no patch'}{track.mute ? ', muted' : ''}</span>
			</button>
		{:else}
			<p class="muted empty">No tracks yet.</p>
		{/each}
	</div>

	<div class="scroller">
		<svg
			bind:this={svg}
			{width}
			{height}
			role="application"
			aria-label="Arrangement"
			data-testid="arrangement"
		>
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
				{@const span = (block.clip?.length ?? 0) * block.repeat * perTick}
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
						onkeydown={(event) => {
							if (event.key === 'Enter') onselect({ track: block.track.id, placement: block.index });
						}}
					/>
					<path class="join" d={joins(block.clip, block.repeat)} />
					<path class="sketch" d={sketch(block.clip, block.repeat)} />
					<text class="name" x="5" y="12">{block.name}{block.repeat > 1 ? ` x${block.repeat}` : ''}</text>
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
						/>
					{/if}
				</g>
			{/each}

			<line class="playhead" x1={tick * perTick} x2={tick * perTick} y1={0} y2={height} data-testid="playhead" />
		</svg>
	</div>
</div>

<style>
	.arrangement {
		display: grid;
		grid-template-columns: 150px minmax(0, 1fr);
		border: 1px solid var(--line);
		border-radius: 6px;
		overflow: hidden;
		background: #0d1117;
		min-width: 0;
	}
	.heads {
		background: var(--panel);
		border-right: 1px solid var(--line);
		box-sizing: border-box;
	}
	.head {
		display: flex;
		flex-direction: column;
		justify-content: center;
		width: 100%;
		text-align: left;
		box-sizing: border-box;
		border: 0;
		border-top: 1px solid var(--line);
		border-radius: 0;
		font-size: 0.8rem;
		overflow: hidden;
	}
	.head.chosen {
		background: #1a212b;
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.head.problem {
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
		overflow-x: auto;
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
</style>
