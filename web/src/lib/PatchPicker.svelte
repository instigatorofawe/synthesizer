<script lang="ts">
	import { untrack } from 'svelte';
	import { filterGroups, patchGroups, type ExampleGroup } from '#lib/PatchGroups.ts';
	import type { PatchLike } from '#lib/TimelineEdit.ts';

	// One way to choose a patch, wherever one is chosen: a field that filters as it is typed in, over a list grouped by where
	// each patch comes from, with an action at the bottom. In a slot it shows the patch chosen and opens when it is clicked,
	// typed in or arrowed into. Opened by a button, as + Track and a track head's ▾ open it, it starts open below that
	// button, and Esc or leaving it cancels. The list floats above the page, so a scrolling inspector doesn't cut it off.
	let {
		label,
		value = null,
		patches,
		used = [],
		examples = [],
		action = '',
		placeholder = 'Search patches',
		anchor = null,
		disabled = false,
		onchoose,
		onaction = () => {},
		oncancel = () => {}
	}: {
		label: string; // The field's name, which a screen reader reads and a test finds it by
		value?: string | null; // The patch chosen, which a slot shows while its list is closed
		patches: PatchLike[];
		used?: string[]; // What the open song plays, in order, for "On this song"
		examples?: ExampleGroup[]; // How the browser groups the examples, which the built-in patches follow
		action?: string; // What the last entry does, such as "New patch for this track", or nothing for none
		placeholder?: string;
		anchor?: HTMLElement | null; // The button that opened it, for a picker that isn't a slot. Focus goes back there.
		disabled?: boolean;
		onchoose: (id: string) => void;
		onaction?: (typed: string) => void; // With what was typed, which can name what it makes
		oncancel?: () => void;
	} = $props();

	type Option = { kind: 'patch'; patch: PatchLike } | { kind: 'action' };

	const uid = $props.id();
	const popup = untrack(() => anchor !== null);
	let open = $state(popup);
	let query = $state('');
	let typed = $state(false); // Whether the field holds what was typed, rather than the chosen patch's name
	let active = $state(-1); // The option Enter takes, which the arrows move
	let leaving = false; // Focus is going back to the anchor on purpose, which isn't leaving to cancel
	let pointer = { x: -1, y: -1 };
	let root = $state<HTMLElement>();
	let field = $state<HTMLInputElement>();
	let panel = $state<HTMLElement>();
	let place = $state({ left: 0, top: 0 as number | null, bottom: null as number | null, width: 280, height: 360 });

	const nameOf = (id: string | null) => (id === null ? '' : (patches.find((patch) => patch.id === id)?.name ?? id));
	const groups = $derived(patchGroups(patches, used, examples));
	const shown = $derived(typed ? filterGroups(groups, query) : groups);
	const starts = $derived.by(() => {
		let at = 0;
		return shown.map((group) => {
			const start = at;
			at += group.patches.length;
			return start;
		});
	});
	const options = $derived<Option[]>([
		...shown.flatMap((group) => group.patches.map((patch) => ({ kind: 'patch' as const, patch }))),
		...(action ? [{ kind: 'action' as const }] : [])
	]);
	const named = $derived(typed ? query.trim() : '');
	const text = $derived(typed ? query : popup ? '' : nameOf(value));
	const optionId = (index: number) => `${uid}-option-${index}`;
	// A picker a button opened starts on the patch it would change.
	if (popup) active = current();

	function current() {
		return Math.max(
			0,
			options.findIndex((option) => option.kind === 'patch' && option.patch.id === value)
		);
	}

	function show() {
		if (open || disabled) return;
		typed = false;
		query = '';
		open = true;
		active = current();
		field?.select();
	}

	// A slot closes and shows its patch again. A picker a button opened is done, and its owner takes it away.
	function close() {
		if (popup) {
			oncancel();
			return;
		}
		open = false;
		typed = false;
		query = '';
	}

	// Focus goes back to the button that opened it, so the keyboard carries on from there.
	function back() {
		if (!popup) return;
		leaving = true;
		anchor?.focus();
	}

	function choose(index: number) {
		const option = options[index];
		if (!option) return;
		const name = named;
		back();
		if (!popup) {
			open = false;
			typed = false;
			query = '';
		}
		if (option.kind === 'action') onaction(name);
		else onchoose(option.patch.id);
	}

	function typing(event: Event & { currentTarget: HTMLInputElement }) {
		query = event.currentTarget.value;
		typed = true;
		open = true;
		active = options.length ? 0 : -1;
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (!open) return show();
			if (!options.length) return;
			const step = event.key === 'ArrowDown' ? 1 : -1;
			active = (active + step + options.length) % options.length;
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (!open) show();
			else if (active >= 0) choose(active);
		} else if (event.key === 'Escape' && open) {
			// Esc closes this and nothing else, so it doesn't also reach the page's own Esc.
			event.preventDefault();
			event.stopPropagation();
			back();
			close();
		}
	}

	function focusout(event: FocusEvent) {
		if (leaving || !open) return;
		const to = event.relatedTarget as Node | null;
		if (to && root?.contains(to)) return;
		close();
	}

	function hover(event: PointerEvent, index: number) {
		// Scrolling the list under a still pointer is not the pointer choosing.
		if (event.clientX === pointer.x && event.clientY === pointer.y) return;
		pointer = { x: event.clientX, y: event.clientY };
		active = index;
	}

	// Below what it belongs to, or above where there's more room there, and inside the window.
	function position() {
		const at = (popup ? anchor : field)?.getBoundingClientRect();
		if (!at) return;
		const width = Math.max(at.width, popup ? 290 : 260);
		const below = window.innerHeight - at.bottom - 8;
		const above = at.top - 8;
		const up = below < 240 && above > below;
		place = {
			left: Math.max(8, Math.min(at.left, window.innerWidth - width - 8)),
			top: up ? null : at.bottom + 2,
			bottom: up ? window.innerHeight - at.top + 2 : null,
			width,
			height: Math.min(420, up ? above : below)
		};
	}

	$effect(() => {
		if (!open || !panel) return;
		const shownPanel = panel;
		untrack(() => {
			position();
			if (!shownPanel.matches(':popover-open')) shownPanel.showPopover();
			if (popup) field?.focus();
		});
		window.addEventListener('resize', position);
		window.addEventListener('scroll', position, true);
		return () => {
			window.removeEventListener('resize', position);
			window.removeEventListener('scroll', position, true);
			if (shownPanel.matches(':popover-open')) shownPanel.hidePopover();
		};
	});

	$effect(() => {
		if (disabled && open) untrack(close);
	});

	// The option the arrows reach stays in sight.
	$effect(() => {
		if (open && active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
	});
</script>

{#snippet combobox()}
	<input
		bind:this={field}
		class="field"
		type="text"
		role="combobox"
		aria-label={label}
		aria-expanded={open}
		aria-controls={`${uid}-list`}
		aria-autocomplete="list"
		aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
		autocomplete="off"
		spellcheck="false"
		data-patch={popup ? undefined : (value ?? '')}
		{placeholder}
		{disabled}
		value={text}
		onclick={show}
		oninput={typing}
		onkeydown={keydown}
	/>
{/snippet}

{#snippet list()}
	<!-- The field keeps focus while the list is used and takes the keys for it, as a combobox's does, so a press here
	     mustn't take focus, and an option needs no keys of its own. -->
	<ul
		class="options"
		role="listbox"
		id={`${uid}-list`}
		aria-label="Patches"
		onmousedown={(event) => event.preventDefault()}
	>
		{#each shown as group, g (group.key)}
			{#if group.builtin && !shown[g - 1]?.builtin}
				<li role="presentation" class="heading" id={`${uid}-builtin`}>Built in</li>
			{/if}
			<li role="presentation">
				<ul
					role="group"
					aria-labelledby={group.builtin
						? `${uid}-builtin${group.label ? ` ${uid}-group-${g}` : ''}`
						: `${uid}-group-${g}`}
				>
					{#if group.label}
						<li role="presentation" class="heading" class:sub={group.builtin} id={`${uid}-group-${g}`}>
							{group.label}
						</li>
					{/if}
					{#each group.patches as patch, p (patch.id)}
						{@const index = starts[g] + p}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<li
							role="option"
							id={optionId(index)}
							aria-selected={index === active}
							class:active={index === active}
							class:current={patch.id === value}
							data-patch={patch.id}
							title={patch.name}
							onclick={() => choose(index)}
							onpointermove={(event) => hover(event, index)}
						>
							{patch.name}
						</li>
					{/each}
				</ul>
			</li>
		{/each}
		{#if typed && !shown.length}
			<li role="presentation" class="none">No patch matches.</li>
		{/if}
		{#if action}
			{@const index = options.length - 1}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<li
				role="option"
				id={optionId(index)}
				aria-selected={index === active}
				class="action"
				class:active={index === active}
				onclick={() => choose(index)}
				onpointermove={(event) => hover(event, index)}
			>
				<span class="plus" aria-hidden="true">+</span>{action}{#if named}<span class="muted">, named “{named}”</span
					>{/if}
			</li>
		{/if}
	</ul>
{/snippet}

<div class="picker" class:popup bind:this={root} onfocusout={focusout}>
	{#if !popup}{@render combobox()}{/if}
	<div
		class="panel"
		popover="manual"
		bind:this={panel}
		style:left="{place.left}px"
		style:top={place.top === null ? 'auto' : `${place.top}px`}
		style:bottom={place.bottom === null ? 'auto' : `${place.bottom}px`}
		style:width="{place.width}px"
		style:max-height="{place.height}px"
	>
		{#if popup}{@render combobox()}{/if}
		{@render list()}
	</div>
</div>

<style>
	.picker {
		flex: 1;
		min-width: 0;
		display: flex;
	}
	.picker.popup {
		display: contents;
	}
	.field {
		flex: 1;
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
		text-overflow: ellipsis;
	}
	.picker:not(.popup) .field {
		cursor: pointer;
		padding-right: 1.1rem;
		background: var(--panel)
			url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0h8L4 5z' fill='%237d8590'/%3E%3C/svg%3E")
			no-repeat right 0.4rem center;
	}
	.picker:not(.popup) .field:focus {
		cursor: text;
	}
	.panel {
		position: fixed;
		inset: auto;
		margin: 0;
		padding: 0;
		box-sizing: border-box;
		flex-direction: column;
		background: var(--panel);
		color: var(--text);
		border: 1px solid var(--line);
		border-radius: 6px;
		box-shadow: 0 8px 24px #000a;
		font-size: 0.8rem;
		overflow: hidden;
	}
	.panel:popover-open {
		display: flex;
	}
	.panel > .field {
		flex: none;
		margin: 0.4rem;
		width: auto;
		padding: 0.25rem 0.5rem;
	}
	.options {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		list-style: none;
		margin: 0;
		padding: 0.2rem 0;
	}
	.options ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.heading {
		padding: 0.45rem 0.6rem 0.15rem;
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
	}
	.heading.sub {
		padding-top: 0.25rem;
		padding-left: 1rem;
		text-transform: none;
		letter-spacing: 0;
		font-style: italic;
	}
	[role='option'] {
		padding: 0.2rem 0.6rem 0.2rem 1rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
	}
	[role='option'].current {
		box-shadow: inset 2px 0 0 var(--accent);
	}
	[role='option'].active {
		background: #1f6feb40;
	}
	.plus {
		margin-right: 0.3rem;
	}
	.action {
		margin-top: 0.2rem;
		border-top: 1px solid var(--line);
		padding-top: 0.35rem;
		padding-bottom: 0.35rem;
		color: var(--accent);
	}
	.none {
		padding: 0.4rem 0.6rem;
		color: var(--muted);
	}
</style>
