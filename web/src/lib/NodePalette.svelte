<script lang="ts">
	import { searchNodes } from '#lib/NodeHelp.ts';

	// The node search: one combobox, its results under group headings. Typing filters by a node's name, the compiler's name,
	// other words for it and what it does, so "filter" finds biquad. The arrows choose, Enter adds and Esc closes. It closes too
	// when focus goes anywhere else, as a menu does.
	let {
		types,
		left,
		top,
		label = 'Add a node',
		onpick,
		onclose
	}: {
		types: string[]; // The node types it offers
		left: number; // Where it opens, in CSS pixels from its positioned parent
		top: number;
		label?: string;
		onpick: (type: string) => void;
		onclose: (escaped: boolean) => void; // Esc, rather than focus moving elsewhere, which keeps where it went
	} = $props();

	const id = $props.id();
	let root: HTMLDivElement;
	let search: HTMLInputElement;
	let query = $state('');
	let active = $state(0);

	const groups = $derived(searchNodes(query, types));
	const options = $derived(groups.flatMap((group) => group.matches));
	const optionId = (index: number) => `${id}-option-${index}`;

	$effect(() => search.focus());

	function move(by: number) {
		if (!options.length) return;
		active = (active + by + options.length) % options.length;
		document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			move(event.key === 'ArrowDown' ? 1 : -1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (options[active]) onpick(options[active].type);
		} else if (event.key === 'Escape') {
			// Esc is the search's alone: it mustn't also reach the page and deselect what the node would go beside.
			event.preventDefault();
			event.stopPropagation();
			onclose(true);
		}
	}

	function focusout(event: FocusEvent) {
		if (!root.contains(event.relatedTarget as Node | null)) onclose(false);
	}
</script>

<div
	class="palette"
	bind:this={root}
	style:left={`${left}px`}
	style:top={`${top}px`}
	role="dialog"
	aria-label={label}
	data-testid="node-palette"
	onfocusout={focusout}
>
	<input
		bind:this={search}
		role="combobox"
		aria-label="Search nodes"
		aria-expanded="true"
		aria-controls={`${id}-list`}
		aria-autocomplete="list"
		aria-activedescendant={options.length ? optionId(active) : undefined}
		placeholder="Search: filter, envelope, lfo…"
		autocomplete="off"
		spellcheck="false"
		value={query}
		oninput={(e) => {
			query = e.currentTarget.value;
			active = 0;
		}}
		onkeydown={keydown}
	/>
	<div class="list" id={`${id}-list`} role="listbox" aria-label="Nodes">
		{#each groups as group, g (group.group)}
			<div role="group" aria-labelledby={`${id}-group-${g}`}>
				<div class="heading" id={`${id}-group-${g}`}>{group.group}</div>
				{#each group.matches as match (match.type)}
					{@const index = options.indexOf(match)}
					<!-- The search keeps focus, so the options take no keys of their own: the arrows and Enter reach them from it. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div
						class="option"
						class:active={index === active}
						id={optionId(index)}
						role="option"
						tabindex="-1"
						aria-selected={index === active}
						onmousedown={(e) => e.preventDefault()}
						onpointermove={() => (active = index)}
						onclick={() => onpick(match.type)}
					>
						<span class="name">{match.help.name}</span>
						<span class="type">{match.type}</span>
						<span class="about">{match.help.description}</span>
					</div>
				{/each}
			</div>
		{/each}
		{#if !options.length}<p class="none">Nothing matches “{query}”.</p>{/if}
	</div>
</div>

<style>
	.palette {
		position: absolute;
		z-index: 10;
		width: 300px;
		display: flex;
		flex-direction: column;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 6px;
		box-shadow: 0 6px 20px #0008;
		font-size: 0.82rem;
	}
	input {
		margin: 0.4rem;
		padding: 0.3rem 0.45rem;
	}
	.list {
		max-height: 280px;
		overflow-y: auto;
		padding: 0 0 0.3rem;
	}
	.heading {
		padding: 0.35rem 0.6rem 0.15rem;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
	}
	.option {
		display: grid;
		grid-template-columns: auto 1fr;
		column-gap: 0.4rem;
		padding: 0.25rem 0.6rem;
		cursor: pointer;
	}
	.option.active {
		background: #1f6feb33;
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.name {
		font-weight: 600;
		color: var(--text);
	}
	.type {
		color: var(--muted);
		font-family: ui-monospace, monospace;
		font-size: 0.75rem;
		align-self: center;
	}
	.about {
		grid-column: 1 / -1;
		color: var(--muted);
		font-size: 0.75rem;
	}
	.none {
		margin: 0.3rem 0.6rem;
		color: var(--muted);
	}
</style>
