<script lang="ts">
	import { rank, type Openable } from '#lib/QuickOpen.ts';
	import { label } from '#lib/Shortcuts.ts';

	// Mod+K: a song, an example or a patch opened by typing part of its name, as an editor's quick open does. The arrows choose,
	// Enter opens, and Esc closes. What it opens is a link like the browser's, so it goes where the browser's would.
	let { items, onclose }: { items: Openable[]; onclose: () => void } = $props();

	let dialog: HTMLDialogElement;
	let list: HTMLUListElement;
	let typed = $state('');
	let active = $state(0);
	const found = $derived(rank(items, typed));
	const uid = $props.id();

	$effect(() => {
		dialog.showModal();
	});

	$effect(() => {
		void typed;
		active = 0;
	});

	function keydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (!found.length) return;
			active = (active + (event.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length;
			list.querySelectorAll('a')[active]?.scrollIntoView({ block: 'nearest' });
		} else if (event.key === 'Enter') {
			event.preventDefault();
			list.querySelectorAll('a')[active]?.click();
		}
	}
</script>

<dialog bind:this={dialog} aria-label="Quick open" {onclose}>
	<input
		type="search"
		role="combobox"
		aria-label="Open by name"
		aria-expanded="true"
		aria-controls={`${uid}-found`}
		aria-activedescendant={found.length ? `${uid}-${active}` : undefined}
		placeholder={`A song, an example or a patch, by name (${label('quick-open')})`}
		autocomplete="off"
		bind:value={typed}
		onkeydown={keydown}
	/>
	<ul bind:this={list} id={`${uid}-found`} role="listbox" aria-label="Found">
		{#each found as item, index (item.href)}
			<li id={`${uid}-${index}`} role="option" aria-selected={index === active}>
				<a href={item.href} tabindex="-1" onclick={() => dialog.close()} onpointerenter={() => (active = index)}>
					<span class="name">{item.name}</span>
					<span class="kind">{item.kind}</span>
				</a>
			</li>
		{:else}
			<li class="none">Nothing is called that.</li>
		{/each}
	</ul>
</dialog>

<style>
	dialog {
		width: min(560px, 90vw);
		margin-top: 12vh;
		padding: 0.5rem;
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--line);
		border-radius: 8px;
	}
	dialog::backdrop {
		background: #0006;
	}
	input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.4rem 0.6rem;
		font-size: 0.9rem;
	}
	ul {
		list-style: none;
		margin: 0.4rem 0 0;
		padding: 0;
		max-height: 50vh;
		overflow-y: auto;
	}
	a {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.3rem 0.6rem;
		border-radius: 4px;
		color: var(--text);
		text-decoration: none;
		font-size: 0.85rem;
	}
	[aria-selected='true'] a {
		background: #1f6feb50;
	}
	.kind {
		color: var(--muted);
		font-size: 0.75rem;
	}
	.none {
		padding: 0.3rem 0.6rem;
		color: var(--muted);
		font-size: 0.85rem;
	}
</style>
