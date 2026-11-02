<script lang="ts">
	import { isBlackKey, noteName } from '#lib/TimelineEdit.ts';

	// Two octaves of keys for playing the patch on screen. Each key is a button named by its note number.
	let {
		low = 48,
		octaves = 2,
		disabled = false,
		onnote
	}: { low?: number; octaves?: number; disabled?: boolean; onnote: (note: number, on: boolean) => void } = $props();

	const WHITE = 18; // px

	const notes = $derived(Array.from({ length: octaves * 12 + 1 }, (_, i) => low + i));
	const whites = $derived(notes.filter((note) => !isBlackKey(note)));
	const held = new Set<number>();

	// A black key sits over the line between the white keys either side of it.
	const left = (note: number) => whites.indexOf(note - 1) * WHITE + WHITE - 6;

	function press(note: number) {
		if (held.has(note)) return;
		held.add(note);
		onnote(note, true);
	}

	function release(note: number) {
		if (!held.delete(note)) return;
		onnote(note, false);
	}
</script>

<div class="keyboard" style:width="{whites.length * WHITE}px" role="group" aria-label="Keys">
	{#each notes as note (note)}
		<button
			type="button"
			class="key"
			class:black={isBlackKey(note)}
			style:left="{isBlackKey(note) ? left(note) : whites.indexOf(note) * WHITE}px"
			aria-label={String(note)}
			title={noteName(note)}
			{disabled}
			onpointerdown={() => press(note)}
			onpointerup={() => release(note)}
			onpointerleave={() => release(note)}
		>
			{#if note % 12 === 0}<span>{noteName(note)}</span>{/if}
		</button>
	{/each}
</div>

<style>
	.keyboard {
		position: relative;
		height: 30px;
		flex: none;
		user-select: none;
	}
	.key {
		position: absolute;
		top: 0;
		width: 18px;
		height: 30px;
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
		width: 12px;
		height: 18px;
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
	.key:disabled {
		opacity: 0.5;
	}
</style>
