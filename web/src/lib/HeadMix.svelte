<script lang="ts">
	import { matches } from '#lib/Shortcuts.ts';
	import { decibels, faderGain, faderPosition, panText } from '#lib/TimelineEdit.ts';

	// A track head's volume fader and pan knob, so the mix's most used controls are in the Song view without opening the Mixer
	// tab. They edit the track's own `gain` and `pan`, the ones the Mixer's fader and pan do: live while they are dragged,
	// through the mix registers, and one step of undo when let go. The fader's travel is the Mixer's, cubic in gain. A drag
	// moves a control on from where it is, rather than jumping to the pointer, so a click changes nothing, and a double-click
	// resets it: 0 dB, or the centre.
	let {
		id,
		gain,
		pan,
		label,
		readonly = false,
		onmix
	}: {
		id: number; // The track's, for the tests' ids
		gain: number;
		pan: number;
		label: string; // The track's name
		readonly?: boolean;
		onmix: (change: { gain?: number; pan?: number }, done: boolean) => void; // Live while `done` is false
	} = $props();

	const DRAG = 3; // Pixels a press moves before it is a drag, so a click or the first half of a double-click changes nothing
	const FINE = 0.1; // How much slower a drag goes with Shift held
	const PAN_TRAVEL = 120; // Pixels of drag, up or right, from hard left to hard right
	const FADER_KEY = 0.01; // Of the fader's travel, for an arrow key
	const PAN_KEY = 0.05;

	type Held = {
		what: 'gain' | 'pan';
		at: number; // The fader's position or the pan, as the drag has it
		top: number; // The most the fader goes to: +6 dB, or the gain it started at if that was more
		width: number; // Of the fader's travel, in pixels
		last: { x: number; y: number };
		from: { x: number; y: number };
		moved: boolean;
	};
	let held = $state.raw<Held | null>(null);

	const top = $derived(Math.max(1, faderPosition(gain)));
	const shownGain = $derived(held?.what === 'gain' ? faderGain(held.at) : gain);
	const shownPan = $derived(held?.what === 'pan' ? held.at : pan);
	const share = $derived(Math.min(1, faderPosition(shownGain) / top));
	const unity = $derived(faderPosition(1) / top);

	const gainOf = (position: number) => Number(faderGain(position).toPrecision(4));
	const panOf = (value: number) => Math.round(Math.max(-1, Math.min(1, value)) * 100) / 100;
	const short = (gain: number) => (gain > 0 ? (20 * Math.log10(gain)).toFixed(1) : '-∞');

	// The knob's arc, from the top round to the pan, a quarter and a half of the way round at either end.
	const knob = $derived.by(() => {
		const angle = ((-90 + shownPan * 135) * Math.PI) / 180;
		const [x, y] = [8 + 5.5 * Math.cos(angle), 8 + 5.5 * Math.sin(angle)];
		return {
			arc: `M8 2.5A5.5 5.5 0 0 ${shownPan > 0 ? 1 : 0} ${x.toFixed(2)} ${y.toFixed(2)}`,
			line: `M8 8L${x.toFixed(2)} ${y.toFixed(2)}`
		};
	});

	function press(event: PointerEvent, what: 'gain' | 'pan') {
		if (readonly || event.button !== 0 || event.ctrlKey) return;
		// The control takes focus, so the arrow keys step it after, but the press selects no text as it drags.
		event.preventDefault();
		(event.currentTarget as HTMLElement | SVGElement).focus({ preventScroll: true });
		const box = (event.currentTarget as Element).getBoundingClientRect();
		const point = { x: event.clientX, y: event.clientY };
		held = {
			what,
			at: what === 'gain' ? faderPosition(gain) : pan,
			top,
			width: Math.max(1, box.width),
			last: point,
			from: point,
			moved: false
		};
	}

	function pointerMove(event: PointerEvent) {
		if (!held) return;
		const point = { x: event.clientX, y: event.clientY };
		// Past the first few pixels it is a drag, which goes on from where it was pressed.
		if (!held.moved && Math.abs(point.x - held.from.x) + Math.abs(point.y - held.from.y) < DRAG) return;
		const scale = event.shiftKey ? FINE : 1;
		const [dx, dy] = [point.x - held.last.x, point.y - held.last.y];
		const at =
			held.what === 'gain'
				? Math.max(0, Math.min(held.top, held.at + (dx / held.width) * scale))
				: Math.max(-1, Math.min(1, held.at + ((dx - dy) / PAN_TRAVEL) * 2 * scale));
		held = { ...held, at, last: point, moved: true };
		onmix(held.what === 'gain' ? { gain: gainOf(at) } : { pan: panOf(at) }, false);
	}

	function pointerUp() {
		const done = held;
		held = null;
		if (!done?.moved) return;
		onmix(done.what === 'gain' ? { gain: gainOf(done.at) } : { pan: panOf(done.at) }, true);
	}

	function reset(what: 'gain' | 'pan') {
		if (readonly) return;
		if (what === 'gain' && gain !== 1) onmix({ gain: 1 }, true);
		if (what === 'pan' && pan !== 0) onmix({ pan: 0 }, true);
	}

	function keydown(event: KeyboardEvent, what: 'gain' | 'pan') {
		const by =
			matches(event, 'head.up') || matches(event, 'head.right')
				? 1
				: matches(event, 'head.down') || matches(event, 'head.left')
					? -1
					: 0;
		if (!by || readonly) return;
		event.preventDefault();
		event.stopPropagation();
		if (what === 'gain') {
			const next = gainOf(Math.max(0, Math.min(top, faderPosition(gain) + by * FADER_KEY)));
			if (next !== gain) onmix({ gain: next }, true);
		} else {
			const next = panOf(pan + by * PAN_KEY);
			if (next !== pan) onmix({ pan: next }, true);
		}
	}
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} />

<div class="mix" class:readonly>
	<div
		class="fader"
		class:held={held?.what === 'gain'}
		role="slider"
		tabindex={readonly ? -1 : 0}
		aria-label={`Volume of ${label}`}
		aria-valuemin={0}
		aria-valuemax={1}
		aria-valuenow={Math.round(share * 1000) / 1000}
		aria-valuetext={decibels(shownGain)}
		aria-disabled={readonly}
		title={`Volume of ${label}, ${decibels(shownGain)}.${readonly ? '' : ' Drag it, or double-click it for 0 dB.'}`}
		data-testid={`head-fader-${id}`}
		data-gain={shownGain}
		onpointerdown={(event) => press(event, 'gain')}
		ondblclick={() => reset('gain')}
		onkeydown={(event) => keydown(event, 'gain')}
	>
		<div class="groove">
			<div class="fill" style:width="{share * 100}%"></div>
			<div class="unity" style:left="{unity * 100}%"></div>
		</div>
		<div class="thumb" style:left="{share * 100}%"></div>
	</div>
	<span class="db" aria-hidden="true">{short(shownGain)}</span>
	<svg
		class="pan"
		class:held={held?.what === 'pan'}
		width="16"
		height="16"
		viewBox="0 0 16 16"
		role="slider"
		tabindex={readonly ? -1 : 0}
		aria-label={`Pan of ${label}`}
		aria-valuemin={-1}
		aria-valuemax={1}
		aria-valuenow={shownPan}
		aria-valuetext={panText(shownPan)}
		aria-disabled={readonly}
		data-testid={`head-pan-${id}`}
		data-pan={shownPan}
		onpointerdown={(event) => press(event, 'pan')}
		ondblclick={() => reset('pan')}
		onkeydown={(event) => keydown(event, 'pan')}
	>
		<title
			>{`Pan of ${label}, ${panText(shownPan)}.${readonly ? '' : ' Drag it up or right, or double-click it for the centre.'}`}</title
		>
		<circle class="ring" cx="8" cy="8" r="5.5" />
		{#if shownPan !== 0}<path class="arc" d={knob.arc} />{/if}
		<path class="line" d={knob.line} />
	</svg>
</div>

<style>
	.mix {
		user-select: none;
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		height: 16px;
	}
	.fader {
		position: relative;
		flex: 1;
		min-width: 0;
		height: 12px;
		cursor: ew-resize;
		outline: none;
		touch-action: none;
	}
	.readonly .fader,
	.readonly .pan {
		cursor: default;
	}
	.groove {
		position: absolute;
		left: 0;
		right: 0;
		top: 5px;
		height: 2px;
		border-radius: 1px;
		background: #30363d;
	}
	.fill {
		height: 100%;
		border-radius: 1px;
		background: #58a6ff80;
	}
	/* Where 0 dB is, which a double-click goes back to. */
	.unity {
		position: absolute;
		top: -2px;
		width: 1px;
		height: 6px;
		background: #ffffff40;
	}
	.thumb {
		position: absolute;
		top: 1px;
		width: 4px;
		height: 10px;
		margin-left: -2px;
		border-radius: 1px;
		background: var(--muted);
	}
	.fader:hover .thumb,
	.fader.held .thumb,
	.fader:focus-visible .thumb {
		background: var(--text);
	}
	.fader:focus-visible .groove {
		box-shadow: 0 0 0 1px var(--accent);
	}
	.db {
		flex: none;
		width: 1.9rem;
		text-align: right;
		font-size: 0.62rem;
		font-variant-numeric: tabular-nums;
		color: var(--muted);
	}
	.pan {
		flex: none;
		display: block;
		cursor: ns-resize;
		outline: none;
		touch-action: none;
	}
	.ring {
		fill: #0d1117;
		stroke: #30363d;
		stroke-width: 1.5;
	}
	.arc {
		fill: none;
		stroke: #58a6ff;
		stroke-width: 1.5;
	}
	.line {
		stroke: var(--muted);
		stroke-width: 1.5;
		stroke-linecap: round;
	}
	.pan:hover .line,
	.pan.held .line,
	.pan:focus-visible .line {
		stroke: var(--text);
	}
	.pan:focus-visible .ring {
		stroke: var(--accent);
	}
</style>
