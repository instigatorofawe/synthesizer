<script lang="ts">
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
	let held = $state.raw<{ index: number; clip: Clip } | null>(null);

	const shown = $derived(held?.clip ?? clip);
	const current = $derived(chosen === null ? undefined : shown.automation[chosen]);
	const drawn = $derived(lane.points.map(({ index }) => ({ index, point: shown.automation[index] })));
	const yOf = (value: number) => PAD + (1 - (value - min) / (max - min)) * (HEIGHT - 2 * PAD);

	function pointer(event: { clientX: number; clientY: number }) {
		const box = svg.getBoundingClientRect();
		const y = Math.min(HEIGHT - PAD, Math.max(PAD, event.clientY - box.top));
		const fraction = 1 - (y - PAD) / (HEIGHT - 2 * PAD);
		const tick = Math.min(clip.length - 1, snapTick((event.clientX - box.left) / perTick, grid));
		return { tick, value: Number((min + fraction * (max - min)).toPrecision(4)) };
	}

	const polyline = $derived(
		laneCurve({ ...lane, points: [...drawn].sort((a, b) => a.point.tick - b.point.tick) }, clip.length)
			.map(({ tick, value }) => `${(tick * perTick).toFixed(1)},${yOf(value).toFixed(1)}`)
			.join(' ')
	);

	function startPoint(event: PointerEvent, index: number) {
		event.stopPropagation();
		chosen = index;
		if (!readonly) held = { index, clip };
	}

	function pointerMove(event: PointerEvent) {
		if (held) held = { ...held, clip: setPoint(clip, held.index, pointer(event)) };
	}

	function pointerUp() {
		const finished = held;
		held = null;
		if (finished && finished.clip !== clip) onchange(finished.clip);
	}

	function added(event: MouseEvent) {
		if (readonly) return;
		const { tick, value } = pointer(event);
		chosen = clip.automation.length; // Taken first, because the parent's change reaches `clip` at once
		onchange(addPoint(clip, lane, tick, value));
	}

	function removed(index: number) {
		chosen = null;
		onchange(removePoint(clip, index));
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
<svg bind:this={svg} {width} height={HEIGHT} role="application" aria-label={`Lane ${label}`} data-testid={testid}>
	<rect
		class="ground"
		{width}
		height={HEIGHT}
		role="presentation"
		ondblclick={added}
		onpointerdown={() => (chosen = null)}
	/>
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
			ondblclick={() => !readonly && removed(index)}
		/>
	{/each}
</svg>

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
