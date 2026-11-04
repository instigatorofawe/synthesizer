<script lang="ts">
	import ContextMenu, { EXAMPLE_NOTE, byKeys, type MenuItem } from '#lib/ContextMenu.svelte';
	import type { Timeline } from '#lib/Schema.ts';
	import { matches, modKey } from '#lib/Shortcuts.ts';
	import { FOLDED, UNFOLDED } from '#lib/SongLayer.ts';
	import {
		addTempoAt,
		bpmText,
		bpmToY,
		canGlide,
		isFirstTempo,
		labelsShown,
		moveTempo,
		nudgeTempo,
		roundBpm,
		tempoRange,
		tempoTick,
		tempoSegments,
		tempoSummary,
		tempoThere,
		toggleGlide,
		yToBpm,
		type TempoSegment,
		removeTempo
	} from '#lib/Tempo.ts';
	import type { Tempo } from '#lib/TimelineEdit.ts';
	import { barsOf } from '#lib/TimeSignature.ts';

	// The song's tempo as a lane of the song layer, over the arrangement's bars, so the playhead and the bar lines pass through
	// it. Folded it is a thin row of flags, each change's BPM where it starts, with a slope where one glides to the next, so the
	// song's tempo reads with no clicks. Unfolded it is a curve of BPM over the song, steps where a change holds and lines where
	// it glides, which is drawn on and dragged. Each gesture is one step of the timeline's undo, and a drag is only that once it
	// is let go: while it lasts, the curve and the top bar's tempo follow it, and the song compiles when it ends, as a fader's
	// drag does.
	let {
		doc,
		y,
		width,
		perTick,
		grid,
		open,
		readonly = false,
		onchange,
		onpreview = () => {},
		onunfold
	}: {
		doc: Timeline;
		y: number; // Where it sits in the arrangement, in pixels from the top of the bars
		width: number;
		perTick: number;
		grid: number; // The arrangement's Snap, in ticks
		open: boolean;
		readonly?: boolean;
		onchange: (doc: Timeline) => void;
		onpreview?: (tempo: Tempo[] | null) => void; // The tempo while a drag lasts, and null once it is over
		onunfold: () => void;
	} = $props();

	const PAD = 9; // Pixels kept clear above the fastest point and below the slowest, which leaves room for their labels
	const DRAG = 3; // Pixels a press moves before it is a drag, so a click changes nothing it wasn't meant to
	const CHAR = 6; // About how wide a digit of a label is, in pixels

	type Gesture =
		| {
				kind: 'point';
				index: number;
				base: Timeline; // The song as the press found it, with a change it added
				now: Timeline;
				from: { x: number; y: number };
				tick: number; // Where the change was, and its tempo, as pressed
				bpm: number;
				at: { tick: number; bpm: number }; // And where the drag has it now
				added: boolean; // A change the press added, whose drag sets only its tempo
				moved: boolean;
		  }
		| { kind: 'segment'; index: number; from: { x: number; y: number }; moved: boolean };

	let svg: SVGSVGElement;
	let gesture = $state.raw<Gesture | null>(null);
	let chosen = $state<number | null>(null); // An index into the song's tempo
	// A change's menu, or with no index, the lane's own, at the tick it was opened at.
	let menu = $state.raw<{ x: number; y: number; index: number | null; tick: number } | null>(null);

	const height = $derived(open ? UNFOLDED : FOLDED);
	const shown = $derived(gesture?.kind === 'point' ? gesture.now : doc);
	const tempo = $derived(shown.tempo);
	// The range follows the song, and the song only changes when a drag is let go, so the lane holds still under a drag.
	const range = $derived(tempoRange(doc.tempo));
	const perBpm = $derived((height - 2 * PAD) / (range.high - range.low));
	const end = $derived(width / perTick);
	const segments = $derived(tempoSegments(tempo, end));
	// What the unfolded lane says it does until it has been used for it: how to add a change, and then how to glide to one.
	const coach = $derived(
		readonly
			? null
			: tempo.length < 2
				? 'A click adds a tempo change, and a drag sets its BPM.'
				: tempo.some((change) => change.ramp)
					? null
					: 'A click on the line after a change makes it glide to the next.'
	);
	const bars = $derived(barsOf(doc));
	const summary = $derived(tempoSummary(doc.tempo, bars));

	const xOf = (tick: number) => tick * perTick;
	const yOf = (bpm: number) => bpmToY(bpm, range, height, PAD);
	const drawnY = (bpm: number) => Math.min(height - 2, Math.max(2, yOf(bpm)));

	// The changes in tick order, with where each is drawn and whether its label fits beside the one before.
	const points = $derived.by(() => {
		const order = tempo.map((change, index) => ({ change, index })).sort((a, b) => a.change.tick - b.change.tick);
		const xs = order.map(({ change }) => xOf(change.tick) + (open ? 5 : 7));
		const shows = labelsShown(
			xs,
			order.map(({ change }) => bpmText(change.bpm).length * CHAR)
		);
		return order.map(({ change, index }, at) => ({ change, index, label: shows[at] }));
	});

	function canvas(event: { clientX: number; clientY: number }) {
		const box = svg.getBoundingClientRect();
		return { x: event.clientX - box.left, y: event.clientY - box.top };
	}

	// A right-click opens a menu and Ctrl-click is a right-click on a Mac, so neither drags.
	const secondary = (event: PointerEvent) => event.button !== 0 || (event.ctrlKey && modKey() === 'Meta');

	function take(event: PointerEvent) {
		svg.focus({ preventScroll: true });
		return canvas(event);
	}

	// A click on empty lane adds a change there, on the Snap's grid, at the tempo playing there, and a drag before letting go
	// sets its tempo. A change already at that tick is taken hold of instead.
	function pressGround(event: PointerEvent) {
		const at = take(event);
		chosen = null;
		if (!open || readonly || secondary(event)) return;
		const tick = bars.snap(at.x / perTick, grid);
		const there = doc.tempo.findIndex((change) => change.tick === tick);
		if (there >= 0) return holdPoint(there, at, false);
		const added = addTempoAt(doc, tick, tempoThere(doc.tempo, tick));
		if (added.index < 0) return;
		chosen = added.index;
		const change = added.doc.tempo[added.index];
		gesture = {
			kind: 'point',
			index: added.index,
			base: added.doc,
			now: added.doc,
			from: at,
			tick: change.tick,
			bpm: change.bpm,
			at: { tick: change.tick, bpm: change.bpm },
			added: true,
			moved: false
		};
		onpreview(added.doc.tempo);
	}

	function holdPoint(index: number, at: { x: number; y: number }, added: boolean) {
		chosen = index;
		const change = doc.tempo[index];
		const was = { tick: change.tick, bpm: change.bpm };
		gesture = { kind: 'point', index, base: doc, now: doc, from: at, ...was, at: was, added, moved: false };
	}

	function pressPoint(event: PointerEvent, index: number) {
		event.stopPropagation();
		const at = take(event);
		chosen = index;
		if (readonly || secondary(event)) return;
		holdPoint(index, at, false);
	}

	// A click on the line from a change to the next switches it between holding and gliding.
	function pressSegment(event: PointerEvent, segment: TempoSegment) {
		event.stopPropagation();
		const at = take(event);
		if (segment.index === null) return;
		chosen = segment.index;
		if (readonly || secondary(event)) return;
		gesture = { kind: 'segment', index: segment.index, from: at, moved: false };
	}

	function pointerMove(event: PointerEvent) {
		if (!gesture) return;
		const at = canvas(event);
		const [dx, dy] = [at.x - gesture.from.x, at.y - gesture.from.y];
		if (!gesture.moved && Math.abs(dx) < DRAG && Math.abs(dy) < DRAG) return;
		if (gesture.kind === 'segment') {
			gesture = { ...gesture, moved: true };
			return;
		}
		// Up and down for its tempo, and sideways for its tick, each from where it was, so a drag along one leaves the other.
		const by = yToBpm(at.y, range, height, PAD) - yToBpm(gesture.from.y, range, height, PAD);
		const bpm = Math.abs(dy) < DRAG ? gesture.bpm : roundBpm(gesture.bpm + by, event.shiftKey);
		const tick = gesture.added || Math.abs(dx) < DRAG ? gesture.tick : gesture.tick + dx / perTick;
		const to = { tick: tempoTick(gesture.base.tempo, gesture.index, tick, grid, bars), bpm };
		const now = moveTempo(gesture.base, gesture.index, tick, bpm, grid, bars);
		gesture = { ...gesture, now, at: to, moved: true };
		onpreview(now.tempo);
	}

	function pointerUp() {
		const held = gesture;
		gesture = null;
		if (!held) return;
		if (held.kind === 'segment') {
			if (!held.moved) commit(toggleGlide(doc, held.index));
			return;
		}
		if (held.added || held.now !== doc) commit(held.now);
		chosen = held.now.tempo.findIndex((change) => change.tick === held.at.tick);
		if (held.added || held.moved) onpreview(null);
	}

	function commit(next: Timeline) {
		if (next !== doc) onchange(next);
	}

	function remove(index: number) {
		if (isFirstTempo(doc.tempo, index)) return;
		chosen = null;
		commit(removeTempo(doc, index));
	}

	// The lane's keys act on the chosen change, and Delete here is about tempo, so none of them reaches the arrangement, where
	// it would take a clip off its track. Esc lets go of a drag, and then of the change.
	function keydown(event: KeyboardEvent) {
		const nudges: [Parameters<typeof matches>[1], number][] = [
			['tempo.up', 1],
			['tempo.down', -1],
			['tempo.up-ten', 10],
			['tempo.down-ten', -10]
		];
		const nudge = nudges.find(([id]) => matches(event, id));
		if (matches(event, 'tempo.delete') || matches(event, 'tempo.backspace')) {
			event.preventDefault();
			event.stopPropagation();
			if (!readonly && chosen !== null) remove(chosen);
		} else if (nudge) {
			event.preventDefault();
			event.stopPropagation();
			if (!readonly && chosen !== null && !gesture) commit(nudgeTempo(doc, chosen, nudge[1]));
		} else if (matches(event, 'menu')) {
			event.preventDefault();
			event.stopPropagation();
			menuAtChosen();
		} else if (matches(event, 'escape')) {
			if (gesture) {
				const previewed = gesture.kind === 'point' && (gesture.added || gesture.moved);
				gesture = null;
				if (previewed) onpreview(null);
			} else if (chosen !== null) chosen = null;
			else return;
			event.preventDefault();
			event.stopPropagation();
		}
	}

	function openMenu(event: MouseEvent, index: number | null) {
		event.preventDefault();
		event.stopPropagation();
		gesture = null;
		if (index !== null) chosen = index;
		menu = { x: event.clientX, y: event.clientY, index, tick: bars.snap(canvas(event).x / perTick, grid) };
	}

	// The lane's own menu, where no change is. The menu key and Shift+F10 open the chosen change's, at its point.
	function laneMenu(event: MouseEvent) {
		if (byKeys(event)) {
			event.preventDefault();
			menuAtChosen();
		} else openMenu(event, null);
	}

	function menuAtChosen() {
		if (!open || chosen === null) return;
		const point = svg.querySelector(`[data-testid="tempo-point-${chosen}"]`)?.getBoundingClientRect();
		if (point) menu = { x: point.left, y: point.bottom, index: chosen, tick: doc.tempo[chosen]?.tick ?? 0 };
	}

	// Where no change is: one added there, at the tempo the song has there, which is what a click on the open lane adds.
	function laneItems(tick: number): MenuItem[] {
		if (!open) return [{ label: 'Unfold the Tempo lane', action: onunfold }];
		const there = doc.tempo.some((change) => change.tick === tick);
		return [
			{
				label: 'Add a tempo change here',
				action: () => {
					const added = addTempoAt(doc, tick, tempoThere(doc.tempo, tick));
					if (added.index < 0) return;
					chosen = added.index;
					commit(added.doc);
				},
				disabled: readonly || there
			}
		];
	}

	// The menu closes before an item acts, so each item holds the change it is for rather than reading the menu.
	function changeItems(index: number): MenuItem[] {
		const change = doc.tempo[index];
		if (!change) return [];
		const items: MenuItem[] = [
			{
				label: change.ramp && canGlide(doc.tempo, index) ? 'Hold until the next change' : 'Glide to the next tempo',
				action: () => commit(toggleGlide(doc, index)),
				disabled: readonly || !canGlide(doc.tempo, index)
			}
		];
		if (!isFirstTempo(doc.tempo, index))
			items.push({ label: 'Delete', keys: 'tempo.delete', action: () => remove(index), disabled: readonly });
		return items;
	}

	const curve = $derived(
		segments
			.flatMap(({ from, to }) => [from, to])
			.map(({ tick, bpm }) => `${xOf(tick).toFixed(1)},${drawnY(bpm).toFixed(1)}`)
			.join(' ')
	);

	// What a drag says under the pointer: the tempo and where the change is.
	const readout = $derived.by(() => {
		if (gesture?.kind !== 'point' || !(gesture.moved || gesture.added)) return null;
		const moved = gesture.at;
		const text = `${bpmText(moved.bpm)} BPM · ${bars.position(moved.tick)}`;
		const x = Math.min(Math.max(0, xOf(moved.tick) + 8), Math.max(0, width - text.length * CHAR));
		const above = drawnY(moved.bpm) > height / 2;
		return { text, x, y: above ? drawnY(moved.bpm) - 8 : drawnY(moved.bpm) + 16 };
	});

	// Folded, a glide is a slope from the end of its label to the next flag, rising or falling as the tempo does.
	function slope(segment: TempoSegment, labelled: boolean) {
		const start = xOf(segment.from.tick) + (labelled ? bpmText(segment.from.bpm).length * CHAR + 10 : 4);
		const stop = xOf(segment.to.tick) - 3;
		if (stop - start < 8) return null;
		const [low, high] = [FOLDED - 4, 4];
		const [y0, y1] =
			segment.glide === 'up' ? [low, high] : segment.glide === 'down' ? [high, low] : [FOLDED / 2, FOLDED / 2];
		const angle = Math.atan2(y1 - y0, stop - start);
		const head = (turn: number) =>
			`${(stop - 5 * Math.cos(angle + turn)).toFixed(1)},${(y1 - 5 * Math.sin(angle + turn)).toFixed(1)}`;
		return {
			line: `M${start.toFixed(1)} ${y0}L${stop.toFixed(1)} ${y1}`,
			head: `M${head(0.5)}L${stop.toFixed(1)},${y1}L${head(-0.5)}`
		};
	}

	$effect(() => {
		if (!open) chosen = null;
	});

	// A lane that goes while a drag lasts leaves the top bar showing the song's own tempo.
	$effect(() => () => {
		if (gesture?.kind === 'point') onpreview(null);
	});
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<svg
	bind:this={svg}
	class="lane"
	class:open
	class:readonly
	style:top="{y}px"
	{width}
	{height}
	role="application"
	aria-label={`Tempo lane: ${summary}`}
	tabindex="-1"
	data-testid="tempo-lane"
	data-open={open}
	data-low={range.low}
	data-high={range.high}
	data-per-bpm={perBpm}
	onkeydown={keydown}
	oncontextmenu={laneMenu}
>
	<rect
		class="ground"
		{width}
		{height}
		role="presentation"
		onpointerdown={pressGround}
		ondblclick={() => {
			if (!open) onunfold();
		}}
		><title
			>{open
				? readonly
					? summary
					: `${summary}. Click to add a change, and drag a point to move it.`
				: `${summary}. Double-click to unfold.`}</title
		></rect
	>

	{#if open}
		<polyline class="curve" points={curve} />
		{#each segments as segment (segment.index ?? 'before')}
			{#if segment.index !== null && segment.next !== null}
				{@const index = segment.index}
				<line
					class="segment"
					class:readonly
					x1={xOf(segment.from.tick)}
					y1={drawnY(segment.from.bpm)}
					x2={xOf(segment.to.tick)}
					y2={drawnY(segment.to.bpm)}
					role="presentation"
					data-testid={`tempo-segment-${index}`}
					data-glide={segment.glide !== null}
					onpointerdown={(event) => pressSegment(event, segment)}
					oncontextmenu={(event) => openMenu(event, index)}
					><title
						>{segment.glide !== null
							? `Gliding to ${bpmText(segment.to.bpm)} BPM.${readonly ? '' : ' Click to hold until the next change.'}`
							: `Holding ${bpmText(segment.from.bpm)} BPM.${readonly ? '' : ' Click to glide to the next tempo.'}`}</title
					></line
				>
			{/if}
		{/each}
		{#each points as { change, index, label } (index)}
			<g class="point" class:chosen={chosen === index}>
				<circle
					cx={xOf(change.tick)}
					cy={drawnY(change.bpm)}
					r="4.5"
					role="presentation"
					data-testid={`tempo-point-${index}`}
					data-tick={change.tick}
					data-bpm={change.bpm}
					onpointerdown={(event) => pressPoint(event, index)}
					oncontextmenu={(event) => openMenu(event, index)}
					><title>{`${bpmText(change.bpm)} BPM from bar ${bars.at(change.tick).number}`}</title></circle
				>
				{#if label}
					<text
						class="label"
						x={xOf(change.tick) + 6}
						y={drawnY(change.bpm) < height / 2 ? drawnY(change.bpm) + 13 : drawnY(change.bpm) - 6}
						>{bpmText(change.bpm)}</text
					>
				{/if}
			</g>
		{/each}
		{#if readout}
			<text class="readout" x={readout.x} y={readout.y} data-testid="tempo-readout">{readout.text}</text>
		{:else if coach}
			<text class="coach" x={xOf(0) + 60} y={height - 6} data-testid="tempo-coach">{coach}</text>
		{/if}
	{:else}
		{#each segments as segment (segment.index ?? 'before')}
			{@const labelled = points.find((p) => p.index === segment.index)?.label ?? false}
			{@const drawn = segment.next !== null ? slope(segment, labelled) : null}
			{#if drawn}
				<path
					class="slope"
					class:hold={segment.glide === null}
					d={drawn.line}
					data-testid={segment.glide !== null && segment.index !== null ? `tempo-glide-${segment.index}` : undefined}
				/>
				{#if segment.glide !== null}<path class="slope head" d={drawn.head} />{/if}
			{/if}
		{/each}
		{#each points as { change, index, label } (index)}
			<g class="flag" data-testid={`tempo-flag-${index}`} data-bpm={change.bpm}>
				<path d={`M${xOf(change.tick) + 0.5} 2V${FOLDED - 2}M${xOf(change.tick) + 0.5} 2h5l-2 2.5l2 2.5h-5`} />
				{#if label}<text x={xOf(change.tick) + 7} y={FOLDED - 5}>{bpmText(change.bpm)}</text>{/if}
				<title>{`${bpmText(change.bpm)} BPM from bar ${bars.at(change.tick).number}`}</title>
			</g>
		{/each}
	{/if}
</svg>

{#if menu}
	{@const at = menu.index === null ? menu.tick : (doc.tempo[menu.index]?.tick ?? 0)}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		label={menu.index === null ? 'Tempo lane' : `Tempo at bar ${bars.at(at).number}`}
		items={menu.index === null ? laneItems(menu.tick) : changeItems(menu.index)}
		note={readonly && (open || menu.index !== null) ? EXAMPLE_NOTE : undefined}
		onclose={() => (menu = null)}
	/>
{/if}

<style>
	.lane {
		position: absolute;
		left: 0;
		display: block;
		outline: none;
		user-select: none;
		touch-action: none;
		overflow: hidden;
	}
	.ground {
		fill: transparent;
	}
	.open:not(.readonly) .ground {
		cursor: crosshair;
	}
	.curve {
		fill: none;
		stroke: #d2a8ff;
		stroke-width: 1.5;
		pointer-events: none;
	}
	/* A wide stroke nobody sees, so the line is easy to click. */
	.segment {
		stroke: transparent;
		stroke-width: 9;
		cursor: pointer;
	}
	.segment.readonly {
		cursor: default;
	}
	.segment:hover {
		stroke: #d2a8ff30;
	}
	.point circle {
		fill: #0d1117;
		stroke: #d2a8ff;
		stroke-width: 1.5;
		cursor: grab;
	}
	.point.chosen circle {
		fill: #d2a8ff;
	}
	.readonly .point circle {
		cursor: default;
	}
	.label,
	.readout,
	.flag text {
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		pointer-events: none;
	}
	.label {
		fill: var(--muted);
	}
	.point.chosen .label {
		fill: var(--text);
	}
	.coach {
		fill: var(--muted);
		font-size: 11px;
		pointer-events: none;
	}
	.readout {
		fill: var(--text);
		paint-order: stroke;
		stroke: #0d1117;
		stroke-width: 3px;
	}
	.flag {
		pointer-events: none;
	}
	.flag path {
		fill: #d2a8ff;
		stroke: #d2a8ff;
		stroke-width: 1;
	}
	.flag text {
		fill: var(--text);
	}
	.slope {
		fill: none;
		stroke: #d2a8ff;
		stroke-width: 1.25;
		pointer-events: none;
	}
	.slope.hold {
		stroke: #d2a8ff40;
		stroke-dasharray: 2 3;
	}
</style>
