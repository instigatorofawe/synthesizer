<script lang="ts">
	import { SECTIONS, type Section } from '#lib/Browser.svelte';

	// The browser folded to a strip of icons down the side, one for each of its lists. Choosing one opens the browser there.
	let { open, onopen }: { open: boolean; onopen: (section: Section) => void } = $props();
</script>

<div class="rail" role="toolbar" aria-orientation="vertical" aria-label="Library and examples">
	{#each SECTIONS as section (section.id)}
		<button
			type="button"
			aria-label={section.name}
			aria-expanded={open}
			title={`${section.name}. B shows or hides the browser.`}
			onclick={() => onopen(section.id)}><span aria-hidden="true">{section.icon}</span></button
		>
	{/each}
</div>

<style>
	.rail {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2rem;
		width: 32px;
		box-sizing: border-box;
		padding-top: 0.4rem;
		background: var(--panel);
		border-right: 1px solid var(--line);
	}
	button {
		width: 26px;
		height: 26px;
		padding: 0;
		border-color: transparent;
		background: transparent;
		color: var(--muted);
		font-size: 0.85rem;
		line-height: 1;
	}
	button:hover {
		color: var(--text);
	}
</style>
