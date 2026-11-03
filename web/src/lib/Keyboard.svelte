<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { baseAfter, belongsElsewhere, keyFor, noteForKey } from '#lib/KeyboardKeys.ts';
	import { isBlackKey, noteName } from '#lib/TimelineEdit.ts';

	// Two octaves of keys in the top bar, for whichever view is on screen to play. Each key is a button named by its note
	// number, and the computer keyboard plays them too: A to ' from the lowest C shown, with Z and X moving the keys an octave.
	// There is one set of keys on the page, so the page decides where a key is heard, and it listens on the window whichever
	// view is showing.
	let {
		low = 48,
		octaves = 2,
		disabled = false,
		writing = false,
		recording = false,
		where = '',
		onnote
	}: {
		low?: number;
		octaves?: number;
		disabled?: boolean;
		writing?: boolean; // Whether step entry writes what the keys play, which they play as they otherwise would
		recording?: boolean; // Whether a take is recording what they play
		where?: string; // Where the keys are heard, or why they can't be
		onnote: (note: number, on: boolean, at: number) => void; // `at` is when, on the page's clock, as a take needs
	} = $props();

	const WHITE = 14; // px

	let base = $state(untrack(() => low)); // `low` is where the keys start, and Z and X move them from there
	const notes = $derived(Array.from({ length: octaves * 12 + 1 }, (_, i) => base + i));
	const whites = $derived(notes.filter((note) => !isBlackKey(note)));
	const held = new SvelteSet<number>();
	const typed = new Map<string, number>(); // The note each key held down started, so moving the octave can't strand it

	// A black key sits over the line between the white keys either side of it.
	const left = (note: number) => whites.indexOf(note - 1) * WHITE + WHITE - 4.5;

	function press(note: number, at = performance.now()) {
		if (held.has(note)) return;
		held.add(note);
		onnote(note, true, at);
	}

	function release(note: number, at = performance.now()) {
		if (!held.delete(note)) return;
		onnote(note, false, at);
	}

	function keydown(event: KeyboardEvent) {
		if (disabled || belongsElsewhere(event)) return;
		const moved = baseAfter(event.code, base);
		const note = noteForKey(event.code, base);
		if (moved === null && note === null) return;
		event.preventDefault();
		if (event.repeat) return;
		if (moved !== null) {
			base = moved;
		} else if (note !== null && !typed.has(event.code)) {
			typed.set(event.code, note);
			press(note, event.timeStamp);
		}
	}

	function keyup(event: KeyboardEvent) {
		const note = typed.get(event.code);
		if (note === undefined) return;
		typed.delete(event.code);
		release(note, event.timeStamp);
	}

	// A key let go while the page wasn't looking would otherwise hold its note for ever.
	function releaseAll() {
		typed.clear();
		for (const note of [...held]) release(note);
	}

	$effect(() => {
		if (disabled) releaseAll();
	});
</script>

<svelte:window onkeydown={keydown} onkeyup={keyup} onblur={releaseAll} />

<div
	class="keyboard"
	class:writing
	class:recording
	style:width="{whites.length * WHITE}px"
	role="group"
	aria-label="Keys"
	title={`${writing ? 'Step entry: keys write notes at the cursor in the roll. ' : ''}${recording ? 'Recording: the take writes what the keys play. ' : ''}${where ? `${where} ` : ''}Play from the computer keyboard: A to ', with Z and X for an octave down or up.`}
>
	{#each notes as note (note)}
		<button
			type="button"
			class="key"
			class:black={isBlackKey(note)}
			class:down={held.has(note)}
			style:left="{isBlackKey(note) ? left(note) : whites.indexOf(note) * WHITE}px"
			aria-label={String(note)}
			aria-keyshortcuts={keyFor(note, base) || undefined}
			title={keyFor(note, base) ? `${noteName(note)} (${keyFor(note, base)})` : noteName(note)}
			{disabled}
			onpointerdown={(event) => press(note, event.timeStamp)}
			onpointerup={(event) => release(note, event.timeStamp)}
			onpointerleave={(event) => release(note, event.timeStamp)}
		>
			{#if note % 12 === 0}<span>{noteName(note)}</span>{/if}
		</button>
	{/each}
</div>

<style>
	.keyboard {
		position: relative;
		height: 26px;
		flex: none;
		user-select: none;
	}
	/* Step entry is on, so what is played is written too. */
	.keyboard.writing {
		outline: 2px solid #3fb950;
		outline-offset: 1px;
		border-radius: 2px;
	}
	/* A take is recording what is played. */
	.keyboard.recording {
		outline: 2px solid #f85149;
		outline-offset: 1px;
		border-radius: 2px;
	}
	.key {
		position: absolute;
		top: 0;
		width: 14px;
		height: 26px;
		padding: 0;
		border-radius: 0 0 3px 3px;
		border: 1px solid #30363d;
		background: #c9d1d9;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		touch-action: none;
	}
	.key span {
		font-size: 7px;
		color: #0d1117;
		pointer-events: none;
	}
	.key.black {
		width: 9px;
		height: 16px;
		background: #21262d;
		z-index: 1;
	}
	.key:active:not(:disabled),
	.key:hover:not(:disabled) {
		background: #79c0ff;
		border-color: #30363d;
	}
	.key.black:hover:not(:disabled) {
		background: #1f6feb;
	}
	.key.down:not(:disabled) {
		background: #79c0ff;
	}
	.key.black.down:not(:disabled) {
		background: #1f6feb;
	}
	.key:disabled {
		opacity: 0.5;
	}
</style>
