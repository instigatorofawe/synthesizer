<script lang="ts">
	import { tick } from 'svelte';
	import { rangeEscape } from '#lib/Drag.ts';
	import { shown } from '#lib/NodeHelp.ts';
	import { typedValue, valueText } from '#lib/ParamValues.ts';
	import type { Param } from '#lib/Schema.ts';
	import { matches } from '#lib/Shortcuts.ts';
	import { STEPS, stepOf, stepValue, taper } from '#lib/Taper.ts';

	// A parameter's slider and its value, which a double-click or Enter turns into a field to type a number in. The slider runs
	// on Taper.ts's law, logarithmic for a range such as a cutoff's, so its travel is steps and what it moves is the value. It
	// says the value as it is dragged and leaves the value to `value` once it is let go, so its owner decides what it then shows.
	let {
		param,
		value,
		unit = '',
		label,
		title = '',
		disabled = false,
		oninput,
		onchange
	}: {
		param: Pick<Param, 'min' | 'max'>;
		value: number; // What it shows when it isn't being dragged
		unit?: string;
		label: string; // The slider's name, and the field's with ", typed" after it
		title?: string;
		disabled?: boolean;
		oninput: (value: number) => void; // As it is dragged, which moves the sound
		onchange: (value: number) => void; // Let go, or typed, which is what is kept
	} = $props();

	const shape = $derived(taper(param.min, param.max));
	let dragged = $state<number | null>(null);
	const now = $derived(dragged ?? value);
	const text = $derived(valueText(now, unit));
	let typing = $state<string | null>(null);
	let field = $state<HTMLInputElement>();
	let readout = $state<HTMLButtonElement>();

	const at = (event: Event) => stepValue(shape, Number((event.currentTarget as HTMLInputElement).value));

	function moved(event: Event) {
		dragged = at(event);
		oninput(dragged);
	}

	function letGo(event: Event) {
		dragged = null;
		onchange(at(event));
	}

	// Esc during a drag: the sound goes back to the value kept, which the slider shows again.
	function cancelled() {
		if (dragged === null) return;
		dragged = null;
		oninput(value);
	}

	async function type() {
		if (disabled) return;
		typing = shown(now);
		await tick();
		field?.select();
	}

	// Enter or leaving the field keeps what was typed, if it is a number, and Esc keeps what was there. Either way the value
	// shows again, with focus on it if the field had it.
	async function typed(keep: boolean) {
		const text = typing;
		if (text === null) return;
		const focused = document.activeElement === field;
		typing = null;
		const next = keep ? typedValue(text, param) : null;
		if (next !== null) {
			oninput(next);
			onchange(next);
		}
		if (!focused) return;
		await tick();
		readout?.focus();
	}

	function fieldKeys(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void typed(true);
		} else if (matches(event, 'escape')) {
			event.preventDefault();
			event.stopPropagation(); // Esc here gives up the typing and nothing else
			void typed(false);
		}
	}
</script>

<input
	class="slider"
	type="range"
	min="0"
	max={STEPS}
	step="1"
	value={stepOf(shape, now)}
	aria-label={label}
	aria-valuetext={text}
	data-value={now}
	data-taper={shape.log ? 'log' : 'linear'}
	{title}
	{disabled}
	oninput={moved}
	onchange={letGo}
	use:rangeEscape={cancelled}
/>
{#if typing !== null}
	<input
		class="typed"
		bind:this={field}
		aria-label={`${label}, typed`}
		inputmode="decimal"
		spellcheck="false"
		autocomplete="off"
		value={typing}
		oninput={(event) => (typing = event.currentTarget.value)}
		onkeydown={fieldKeys}
		onblur={() => void typed(true)}
	/>
{:else}
	<button
		type="button"
		class="readout"
		bind:this={readout}
		{disabled}
		title={`${text}. Double-click or press Enter to type a value, from ${shown(param.min)} to ${shown(param.max)}.`}
		ondblclick={() => void type()}
		onkeydown={(event) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			void type();
		}}>{text}</button
	>
{/if}

<style>
	.slider {
		flex: 1;
		min-width: 0;
		width: auto;
	}
	/* The value reads as text, and is a button only so it can be reached and typed into. */
	.readout,
	.typed {
		flex: none;
		width: 3.8rem;
		box-sizing: border-box;
		padding: 0 0.2rem;
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
		text-align: right;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.readout {
		border-color: transparent;
		background: transparent;
		color: var(--text);
		cursor: text;
	}
	.readout:hover:not(:disabled),
	.readout:focus-visible {
		border-color: var(--line);
	}
	.readout:disabled {
		color: var(--muted);
		cursor: default;
	}
</style>
