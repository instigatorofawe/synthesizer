<script lang="ts">
	import ContextMenu, { EXAMPLE_NOTE, type MenuItem } from '#lib/ContextMenu.svelte';
	import { matches, modKey } from '#lib/Shortcuts.ts';
	import {
		SHAPES,
		addLanePoint,
		laneCurve,
		lanePoints,
		lanesOf,
		removeLanePoint,
		setLanePoint,
		type Clip,
		type Lane,
		type LanePoint,
		type Shape
	} from '#lib/TimelineEdit.ts';
	import { noteValue, position, snapTick, noteLengths, readLength, readPosition } from '#lib/Units.ts';
	import UnitField from '#lib/UnitField.svelte';

	let {
		clip,
		lane,
		label,
		min,
		max,
		start,
		ppq,
		perTick,
		width,
		grid,
		readonly = false,
		testid,
		onchange,
		onremove,
		onsay
	}: {
		clip: Clip;
		lane: Lane;
		label: string;
		min: number;
		max: number;
		start?: number; // Where what the lane moves stands before it moves it, if the page knows, which a first ramp starts from
		ppq: number;
		perTick: number;
		width: number;
		grid: number;
		readonly?: boolean;
		testid: string;
		onchange: (clip: Clip) => void;
		onremove: () => void;
		onsay: (text: string) => void; // Says why something typed into a field was refused
	} = $props();

	const HEIGHT = 64;
	const PAD = 6;
	const POINT_REACH = 8; // Pixels above or below a point within which a click on the lane meant that point
	const SHAPE_NAMES: Record<Shape, string> = { step: 'Step', line: 'Line', exp: 'Curve' };

	let svg: SVGSVGElement;
	let chosen = $state<number | null>(null); // An index into `clip.automation`
	// A point being dragged: `from` is its place in `base`, as it was pressed, and `index` its place in `clip`, as it is now. A
	// new point is in `base` but not yet in the document, until it is let go.
	let held = $state.raw<{ from: number; index: number; base: Clip; clip: Clip } | null>(null);
	// A point's menu, or with no index, the lane's own, for where it was opened.
	let menu = $state.raw<{
		x: number;
		y: number;
		index: number | null;
		at: { tick: number; value: number; past: boolean };
	} | null>(null);
	// Where a click would add a point, under the pointer, and what it would be: as the roll's ghost note says what a click adds.
	let ghost = $state.raw<{ tick: number; value: number } | null>(null);

	function hover(event: PointerEvent) {
		if (readonly || held || event.target !== event.currentTarget) return void (ghost = null);
		const { tick, value, past } = pointer(event);
		ghost = past || points.some((point) => point.tick === tick) ? null : { tick, value };
	}

	const valueText = (value: number) => String(Number(value.toPrecision(3)));

	// The ghost's words, kept inside the lane at either end.
	const ghostText = $derived(ghost ? `${valueText(ghost.value)} · ${position(ghost.tick, ppq)}` : '');
	const ghostX = $derived(
		ghost ? Math.min(Math.max(0, ghost.tick * perTick + 8), Math.max(0, width - ghostText.length * 6.2)) : 0
	);

	// The lane as it is while a point is dragged, the new one too, and its points where the lane gets to them.
	const shown = $derived(held ? (lanesOf(held.clip).find((l) => l.key === lane.key) ?? lane) : lane);
	const points = $derived(lanePoints(shown, start));
	const current = $derived(chosen === null ? undefined : points.find((point) => point.index === chosen));
	const yOf = (value: number) => PAD + (1 - (value - min) / (max - min)) * (HEIGHT - 2 * PAD);

	// Whether a point has room for a line from the one before it, or from the clip's start for the first.
	function roomFor(point: LanePoint) {
		const k = points.indexOf(point);
		return point.tick > (k > 0 ? points[k - 1].tick : 0);
	}

	function pointer(event: { clientX: number; clientY: number }) {
		const box = svg.getBoundingClientRect();
		const y = Math.min(HEIGHT - PAD, Math.max(PAD, event.clientY - box.top));
		const fraction = 1 - (y - PAD) / (HEIGHT - 2 * PAD);
		const at = snapTick((event.clientX - box.left) / perTick, grid);
		const tick = Math.min(clip.length - 1, at);
		return { tick, value: Number((min + fraction * (max - min)).toPrecision(4)), past: at >= clip.length };
	}

	const polyline = $derived(
		laneCurve(shown, clip.length, start)
			.map(({ tick, value }) => `${(tick * perTick).toFixed(1)},${yOf(value).toFixed(1)}`)
			.join(' ')
	);

	// A right-click chooses the point for its menu, and Ctrl-click is a right-click on a Mac, so neither drags.
	const secondary = (event: PointerEvent) => event.button !== 0 || (event.ctrlKey && modKey() === 'Meta');

	function startPoint(event: PointerEvent, index: number) {
		event.stopPropagation();
		svg.focus({ preventScroll: true });
		chosen = index;
		if (!readonly && !secondary(event)) held = { from: index, index, base: clip, clip };
	}

	// A point dragged keeps its line from the point before it, and the point after it stays joined to it (`setLanePoint`).
	function pointerMove(event: PointerEvent) {
		if (!held) return;
		const { tick, value } = pointer(event);
		const moved = setLanePoint(held.base, held.from, { tick, value }, start);
		held = { ...held, index: moved.index, clip: moved.clip };
		chosen = moved.index;
	}

	function pointerUp() {
		const finished = held;
		held = null;
		if (finished && finished.clip !== clip) onchange(finished.clip);
	}

	// A click on the lane adds a point there, joined to the one before by a line, and dragging before letting go moves it. A
	// point already at that tick is chosen instead, which is also what the second click of a double-click finds.
	function pressGround(event: PointerEvent) {
		svg.focus({ preventScroll: true });
		chosen = null;
		if (readonly || secondary(event)) return;
		const { tick, value, past } = pointer(event);
		// A click that can't add a point says why, rather than doing nothing.
		if (past) return onsay("That's past the clip's end. Lengthen the clip for a point there.");
		const there = points.find((point) => point.tick === tick);
		if (there) {
			chosen = there.index;
			held = { from: there.index, index: there.index, base: clip, clip };
			if (Math.abs(event.clientY - svg.getBoundingClientRect().top - yOf(there.value)) > POINT_REACH)
				onsay('A point is at that step already, so it is chosen. A finer Snap puts one beside it.');
			return;
		}
		const added = addLanePoint(clip, lane, tick, value, start);
		chosen = added.index;
		held = { from: added.index, index: added.index, base: added.clip, clip: added.clip };
	}

	// A double-click adds a point too, if its first click didn't.
	function doubled(event: MouseEvent) {
		if (readonly) return;
		const { tick, value, past } = pointer(event);
		if (past || points.some((point) => point.tick === tick)) return;
		edited(addLanePoint(clip, lane, tick, value, start));
	}

	function edited(next: { clip: Clip; index: number }) {
		chosen = next.index;
		if (next.clip !== clip) onchange(next.clip);
	}

	const change = (index: number, what: Parameters<typeof setLanePoint>[2]) =>
		edited(setLanePoint(clip, index, what, start));

	function removed(index: number) {
		chosen = null;
		onchange(removeLanePoint(clip, index, start));
	}

	// Delete in a lane is about its points, so it never reaches the arrangement, where it would take the clip away.
	function keydown(event: KeyboardEvent) {
		if (matches(event, 'roll.delete') || matches(event, 'roll.backspace')) {
			event.preventDefault();
			event.stopPropagation();
			if (!readonly && chosen !== null) removed(chosen);
		} else if (matches(event, 'escape')) {
			event.stopPropagation();
			if (held) held = null;
			else chosen = null;
		}
	}

	// The menu closes before an item acts, so each item holds the point it is for rather than reading the menu. It sets how the
	// lane gets to the point, and a line or a curve needs room after the point before.
	function pointItems(index: number): MenuItem[] {
		const point = points.find((p) => p.index === index);
		const items: MenuItem[] = [
			...SHAPES.map((shape) => ({
				label: SHAPE_NAMES[shape],
				action: () => change(index, { shape }),
				disabled: !point || point.shape === shape || (shape !== 'step' && !roomFor(point))
			})),
			{ label: 'Delete', keys: 'roll.delete', action: () => removed(index) }
		];
		return readonly ? items.map((item) => ({ ...item, disabled: true })) : items;
	}

	function pointMenu(event: MouseEvent, index: number) {
		event.preventDefault();
		event.stopPropagation();
		held = null;
		chosen = index;
		menu = { x: event.clientX, y: event.clientY, index, at: pointer(event) };
	}

	// Where no point is: a point added there, as a click adds one, and the lane taken away, as its Remove does.
	function laneMenu(event: MouseEvent) {
		event.preventDefault();
		held = null;
		menu = { x: event.clientX, y: event.clientY, index: null, at: pointer(event) };
	}

	function laneItems(at: { tick: number; value: number; past: boolean }): MenuItem[] {
		return [
			{
				label: 'Add a point here',
				action: () => edited(addLanePoint(clip, lane, at.tick, at.value, start)),
				disabled: readonly || at.past || points.some((point) => point.tick === at.tick)
			},
			{ label: 'Remove this lane', action: onremove, disabled: readonly }
		];
	}

	function valueTyped(text: string) {
		const value = Number(text);
		if (chosen !== null && text.trim() !== '' && !Number.isNaN(value)) change(chosen, { value });
	}
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} />

<div class="head">
	<span>{label}</span>
	{#if current}
		{@const index = current.index}
		<fieldset disabled={readonly}>
			<label title="Where the lane gets to this point's value, as bar.beat.tick from the clip's start"
				>at <UnitField
					label={`${label} point tick`}
					value={current.tick}
					format={(tick) => position(tick, ppq)}
					read={readPosition(ppq, clip.length)}
					onvalue={(tick) => change(index, { tick })}
					{onsay}
					width="5rem"
				/></label
			>
			<label
				>value <input
					type="number"
					step="any"
					aria-label={`${label} point value`}
					value={current.value}
					onchange={(e) => valueTyped(e.currentTarget.value)}
				/></label
			>
			<label
				title="How the lane gets to this point from the one before: at once, in a line, or along a curve, which moves by equal ratios, evenly in decibels for a gain and in pitch for a frequency"
			>
				shape
				<select
					aria-label={`${label} point shape`}
					value={current.shape}
					onchange={(e) => change(index, { shape: e.currentTarget.value as Shape })}
				>
					{#each SHAPES as shape (shape)}
						<option value={shape} disabled={shape !== 'step' && !roomFor(current)}>{SHAPE_NAMES[shape]}</option>
					{/each}
				</select>
			</label>
			{#if current.shape !== 'step'}
				<label
					title="How long the lane takes to get here. As long as the gap from the point before, it joins them, and it is never longer."
					>over <UnitField
						label={`${label} point over`}
						value={current.ramp}
						format={(ramp) => noteValue(ramp, ppq)}
						read={readLength(ppq, 0)}
						choices={noteLengths(ppq)}
						onvalue={(ramp) => change(index, { ramp })}
						{onsay}
						width="5rem"
					/></label
				>
			{/if}
		</fieldset>
	{/if}
	<span class="grow"></span>
	{#if !readonly}<button type="button" onclick={onremove} aria-label={`Remove lane ${label}`}>Remove</button>{/if}
</div>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<svg
	bind:this={svg}
	{width}
	height={HEIGHT}
	role="application"
	aria-label={`Lane ${label}`}
	tabindex="-1"
	data-testid={testid}
	onkeydown={keydown}
	oncontextmenu={laneMenu}
>
	<rect
		class="ground"
		{width}
		height={HEIGHT}
		role="presentation"
		ondblclick={doubled}
		onpointerdown={pressGround}
		onpointermove={hover}
		onpointerleave={() => (ghost = null)}
	/>
	<polyline class="curve" points={polyline} data-testid={`${testid}-curve`} />
	{#if ghost && !held}
		<g class="ghost" data-testid={`${testid}-ghost`} data-tick={ghost.tick} data-value={ghost.value}>
			<circle cx={ghost.tick * perTick} cy={yOf(ghost.value)} r="5" />
			<text x={ghostX} y={yOf(ghost.value) < HEIGHT / 2 ? yOf(ghost.value) + 14 : yOf(ghost.value) - 7}
				>{ghostText}</text
			>
		</g>
	{/if}
	{#each points as point (point.index)}
		<circle
			class="point"
			class:chosen={chosen === point.index}
			cx={point.tick * perTick}
			cy={yOf(point.value)}
			r="5"
			role="button"
			tabindex="-1"
			aria-label={`Point at ${position(point.tick, ppq)}`}
			data-testid={`${testid}-point-${point.index}`}
			data-tick={point.tick}
			data-value={point.value}
			data-shape={point.shape}
			onpointerdown={(event) => startPoint(event, point.index)}
			oncontextmenu={(event) => pointMenu(event, point.index)}
		/>
	{/each}
</svg>

{#if menu}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		label={menu.index === null ? `Lane ${label}` : `${label} point`}
		items={menu.index === null ? laneItems(menu.at) : pointItems(menu.index)}
		note={readonly ? EXAMPLE_NOTE : undefined}
		onclose={() => (menu = null)}
	/>
{/if}

<style>
	.ghost {
		pointer-events: none;
	}
	.ghost circle {
		fill: none;
		stroke: var(--accent);
		stroke-dasharray: 2 2;
		opacity: 0.8;
	}
	.ghost text {
		fill: var(--muted);
		font-size: 10px;
		paint-order: stroke;
		stroke: #0d1117;
		stroke-width: 3px;
	}
	.head {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		font-size: 0.75rem;
		padding: 0.25rem 0;
		color: var(--muted);
		position: sticky;
		left: 0;
		width: fit-content;
		min-width: 40rem;
	}
	.head button {
		padding: 0 0.4rem;
		font-size: 0.72rem;
	}
	fieldset {
		display: flex;
		gap: 0.5rem;
		border: 0;
		margin: 0;
		padding: 0;
	}
	input {
		width: 5rem;
		padding: 0 0.25rem;
		font-size: 0.75rem;
	}
	svg {
		display: block;
		outline: none;
		background: #0d1117;
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
		touch-action: none;
		user-select: none;
	}
	.ground {
		fill: transparent;
	}
	.curve {
		fill: none;
		stroke: var(--accent);
		stroke-width: 1.5;
		pointer-events: none;
	}
	.point {
		fill: var(--panel);
		stroke: var(--accent);
		stroke-width: 1.5;
		cursor: grab;
		outline: none;
	}
	.point.chosen {
		fill: var(--accent);
	}
</style>
