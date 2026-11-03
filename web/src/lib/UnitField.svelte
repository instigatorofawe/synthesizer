<script lang="ts">
	import { tick as settle } from 'svelte';
	import { matches } from '#lib/Shortcuts.ts';

	// A field that holds a time, a pitch or a length, which reads as music (Units.ts) while the document holds a number. What is
	// typed goes in when Enter is pressed or the field is left, and Esc puts back what was there. What isn't a position, a pitch
	// or a length is refused with a message that says what to type, as the top bar's fields do, and the field goes back to what
	// it held. A list of choices, for a length, is offered as it is typed in, and the arrows go through it.
	let {
		label,
		value,
		format,
		read,
		onvalue,
		onsay,
		choices = [],
		title,
		width = '4.5rem',
		disabled = false
	}: {
		label: string; // Its name, which a screen reader reads and a test finds it by
		value: number;
		format: (value: number) => string; // What the field reads for a value
		read: (text: string) => number | string; // What was typed, or what to say about it if it isn't one
		onvalue: (value: number) => void;
		onsay: (text: string) => void; // Says why what was typed was refused, where the page says such things
		choices?: string[];
		title?: string;
		width?: string;
		disabled?: boolean;
	} = $props();

	const uid = $props.id();
	const shown = $derived(format(value));

	async function changed(field: HTMLInputElement) {
		const text = field.value;
		if (text.trim() !== shown) {
			const typed = read(text);
			if (typeof typed === 'string') onsay(typed);
			else if (typed !== value) onvalue(typed);
		}
		// What it reads now, which is the value it took, or the one it held. The change reaches `value` once the page has drawn.
		await settle();
		field.value = shown;
	}

	function keydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
		if (!matches(event, 'escape')) return;
		event.preventDefault();
		event.currentTarget.value = shown;
		event.currentTarget.blur();
	}
</script>

<input
	class="unit"
	type="text"
	aria-label={label}
	{title}
	{disabled}
	value={shown}
	style:width
	spellcheck="false"
	autocomplete="off"
	list={choices.length ? `${uid}-choices` : undefined}
	onchange={(event) => changed(event.currentTarget)}
	onkeydown={keydown}
/>
{#if choices.length}
	<datalist id={`${uid}-choices`}>
		{#each choices as choice (choice)}<option value={choice}></option>{/each}
	</datalist>
{/if}

<style>
	/* As compact as the fields beside it, in the roll's toolbar, a lane's head or the inspector, at their size of text. */
	.unit {
		box-sizing: border-box;
		min-width: 0;
		padding: 0.05rem 0.3rem;
		font-variant-numeric: tabular-nums;
	}
</style>
