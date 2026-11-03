<script lang="ts">
	import ContextMenu from '#lib/ContextMenu.svelte';
	import { matches, modKey } from '#lib/Shortcuts.ts';
	import { addPoint, laneCurve, removePoint, setPoint, snapTick, type Clip, type Lane } from '#lib/TimelineEdit.ts';

	let {
		clip,
		lane,
		label,
		min,
		max,
		perTick,
		width,
		grid,
		readonly = false,
		testid,
		onchange,
		onremove
	}: {
		clip: Clip;
		lane: Lane;
		label: string;
		min: number;
		max: number;
		perTick: number;
		width: number;
		grid: number;
		readonly?: boolean;
		testid: string;
		onchange: (clip: Clip) => void;
		onremove: () => void;
	} = $props();

	const HEIGHT = 64;
	const PAD = 6;

	let svg: SVGSVGElement;
	let chosen = $state<number | null>(null); // An index into `clip.automation`
	// A point being dragged, in `clip`, which `base` is as it was pressed: a new point is in `base` but not yet in `clip`.
	let held = $state.raw<{ index: number; base: Clip; clip: Clip } | null>(null);
	let menu = $state.raw<{ x: number; y: number; index: number } | null>(null);

	const shown = $derived(held?.clip ?? clip);
	const current = $derived(chosen === null ? undefined : shown.automation[chosen]);
	// The lane's points as they are while one is dragged, the new one too, which isn't in the lane until it is let go.
	const drawn = $derived.by(() => {
		const points = lane.points.map(({ index }) => ({ index, point: shown.automation[index] }));
		if (held && held.index >= clip.automation.length)
			points.push({ index: held.index, point: held.clip.automation[held.index] });
		return points;
	});
	const yOf = (value: number) => PAD + (1 - (value - min) / (max - min)) * (HEIGHT - 2 * PAD);

	function pointer(event: { clientX: number; clientY: number }) {
		const box = svg.getBoundingClientRect();
		const y = Math.min(HEIGHT - PAD, Math.max(PAD, event.clientY - box.top));
		const fraction = 1 - (y - PAD) / (HEIGHT - 2 * PAD);
		const at = snapTick((event.clientX - box.left) / perTick, grid);
		const tick = Math.min(clip.length - 1, at);
		return { tick, value: Number((min + fraction * (max - min)).toPrecision(4)), past: at >= clip.length };
	}

	const polyline = $derived(
		laneCurve({ ...lane, points: [...drawn].sort((a, b) => a.point.tick - b.point.tick) }, clip.length)
			.map(({ tick, value }) => `${(tick * perTick).toFixed(1)},${yOf(value).toFixed(1)}`)
			.join(' ')
	);

	// A right-click chooses the point for its menu, and Ctrl-click is a right-click on a Mac, so neither drags.
	const secondary = (event: PointerEvent) => event.button !== 0 || (event.ctrlKey && modKey() === 'Meta');

	function startPoint(event: PointerEvent, index: number) {
		event.stopPropagation();
		svg.focus({ preventScroll: true });
		chosen = index;
		if (!readonly && !secondary(event)) held = { index, base: clip, clip };
	}

	function pointerMove(event: PointerEvent) {
		if (!held) return;
		const { tick, value } = pointer(event);
		held = { ...held, clip: setPoint(held.base, held.index, { tick, value }) };
	}

	function pointerUp() {
		const finished = held;
		held = null;
		if (finished && finished.clip !== clip) onchange(finished.clip);
	}

	// A click on the lane adds a point there, and dragging before letting go moves it. A point already at that tick is
	// chosen instead, which is also what the second click of a double-click finds.
	function pressGround(event: PointerEvent) {
		svg.focus({ preventScroll: true });
		chosen = null;
		if (readonly || secondary(event)) return;
		const { tick, value, past } = pointer(event);
		if (past) return;
		const there = lane.points.find(({ point }) => point.tick === tick);
		if (there) {
			chosen = there.index;
			held = { index: there.index, base: clip, clip };
			return;
		}
		const base = addPoint(clip, lane, tick, value);
		chosen = clip.automation.length; // Taken first, because the parent's change reaches `clip` at once
		held = { index: chosen, base, clip: base };
	}

	// A double-click adds a point too, if its first click didn't.
	function doubled(event: MouseEvent) {
		if (readonly) return;
		const { tick, value, past } = pointer(event);
		if (past || lane.points.some(({ point }) => point.tick === tick)) return;
		chosen = clip.automation.length;
		onchange(addPoint(clip, lane, tick, value));
	}

	function removed(index: number) {
		chosen = null;
		onchange(removePoint(clip, index));
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

	// The menu closes before an item acts, so the item holds the point it is for rather than reading the menu.
	const pointItems = (index: number) => [{ label: 'Delete', action: () => removed(index) }];

	function pointMenu(event: MouseEvent, index: number) {
		event.preventDefault();
		event.stopPropagation();
		held = null;
		chosen = index;
		if (!readonly) menu = { x: event.clientX, y: event.clientY, index };
	}

	function field(name: 'tick' | 'value' | 'ramp', text: string) {
		const value = Number(text);
		if (chosen === null || Number.isNaN(value)) return;
		onchange(setPoint(clip, chosen, { [name]: value }));
	}
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} />

<div class="head">
	<span>{label}</span>
	{#if current}
		<fieldset disabled={readonly}>
			<label
				>tick <input
					type="number"
					min="0"
					aria-label={`${label} point tick`}
					value={current.tick}
					onchange={(e) => field('tick', e.currentTarget.value)}
				/></label
			>
			<label
				>value <input
					type="number"
					step="any"
					aria-label={`${label} point value`}
					value={current.value}
					onchange={(e) => field('value', e.currentTarget.value)}
				/></label
			>
			<label>
				ramp
				<input
					type="number"
					min="0"
					aria-label={`${label} point ramp`}
					value={current.ramp ?? 0}
					onchange={(e) => field('ramp', e.currentTarget.value)}
				/>
			</label>
			{#if current.ramp}
				<label title="Exp moves by equal ratios: evenly in decibels for a gain, and in pitch for a frequency">
					curve
					<select
						aria-label={`${label} point curve`}
						value={current.curve ?? 'linear'}
						onchange={(e) =>
							chosen !== null && onchange(setPoint(clip, chosen, { curve: e.currentTarget.value as 'linear' | 'exp' }))}
					>
						<option value="linear">linear</option>
						<option value="exp">exp</option>
					</select>
				</label>
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
	oncontextmenu={(event) => event.preventDefault()}
>
	<rect class="ground" {width} height={HEIGHT} role="presentation" ondblclick={doubled} onpointerdown={pressGround} />
	<polyline class="curve" points={polyline} />
	{#each drawn as { index, point } (index)}
		<circle
			class="point"
			class:chosen={chosen === index}
			cx={point.tick * perTick}
			cy={yOf(point.value)}
			r="5"
			role="button"
			tabindex="-1"
			aria-label={`Point at ${point.tick}`}
			data-testid={`${testid}-point-${index}`}
			onpointerdown={(event) => startPoint(event, index)}
			oncontextmenu={(event) => pointMenu(event, index)}
		/>
	{/each}
</svg>

{#if menu}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		label={`${label} point`}
		items={pointItems(menu.index)}
		onclose={() => (menu = null)}
	/>
{/if}

<style>
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
