<script lang="ts" module>
	import type { ShortcutId } from '#lib/Shortcuts.ts';

	export interface MenuItem {
		label: string;
		action: () => void;
		disabled?: boolean;
		keys?: ShortcutId; // The key that does the same, shown at the item's right, as a desktop menu shows it
	}

	// A right-click on anything that is edited by pointing (a clip, a row, a head, a note, a point, a node, a wire, a ruler)
	// opens its menu, in an example or a built-in patch too, so a right-click never does nothing. There the items that would
	// change it are greyed out, and the menu says why. Fields, buttons, links and the panels of them keep the browser's menu.
	export const EXAMPLE_NOTE = "An example can't be changed. Add to library, in the Song menu ▾, makes a copy that can.";
	export const BUILTIN_NOTE = "A built-in patch can't be changed. Edit a copy makes one that can.";

	// A menu the keyboard opened, by the menu key or Shift+F10, which has no pointer to open at.
	export const byKeys = (event: MouseEvent) => event.clientX === 0 && event.clientY === 0;
</script>

<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { ariaKeys, label as keyLabel } from '#lib/Shortcuts.ts';

	let {
		x,
		y,
		label,
		items,
		note,
		onclose
	}: {
		x: number; // Where it opens, in the window's pixels
		y: number;
		label: string;
		items: MenuItem[];
		note?: string; // Why some items are greyed out, above them
		onclose: () => void;
	} = $props();

	const uid = $props.id();
	const noteId = `${uid}-note`;
	let menu: HTMLDivElement;
	let left = $state(untrack(() => x));
	let top = $state(untrack(() => y));
	let opener: HTMLElement | SVGElement | null = null; // The piano roll, which takes focus, is an SVG element

	const enabled = () => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];

	// It opens where it was asked for, moved in from the window's edges, and its first item takes the keys.
	onMount(() => {
		const focused = document.activeElement;
		opener = focused instanceof HTMLElement || focused instanceof SVGElement ? focused : null;
		const box = menu.getBoundingClientRect();
		left = Math.max(0, Math.min(x, innerWidth - box.width - 4));
		top = Math.max(0, Math.min(y, innerHeight - box.height - 4));
		enabled()[0]?.focus({ preventScroll: true });
	});

	// Closed from the keyboard, focus goes back to what had it, so the keys carry on where they were.
	function close(refocus: boolean) {
		onclose();
		if (refocus) opener?.focus({ preventScroll: true });
	}

	function choose(item: MenuItem) {
		close(true);
		item.action();
	}

	// Every key is the menu's while it has focus: Delete in an open menu shouldn't also delete what is chosen behind it.
	function keydown(event: KeyboardEvent) {
		event.stopPropagation();
		const list = enabled();
		const at = list.indexOf(document.activeElement as HTMLButtonElement);
		let to: number | null = null;
		if (event.key === 'ArrowDown') to = (at + 1) % list.length;
		else if (event.key === 'ArrowUp') to = at <= 0 ? list.length - 1 : at - 1;
		else if (event.key === 'Home') to = 0;
		else if (event.key === 'End') to = list.length - 1;
		else if (event.key === 'Escape' || event.key === 'Tab') close(true);
		else if (event.key === 'Enter' || event.key === ' ') {
			const item = items[Number(list[at]?.dataset.index)];
			if (item) choose(item);
		} else return;
		event.preventDefault();
		if (to !== null) list[to]?.focus();
	}

	function outside(event: PointerEvent) {
		if (!menu.contains(event.target as Node)) close(false);
	}
</script>

<svelte:window onpointerdown={outside} onresize={() => close(false)} />

<div
	bind:this={menu}
	class="menu"
	role="menu"
	tabindex="-1"
	aria-label={label}
	aria-describedby={note ? noteId : undefined}
	data-testid="context-menu"
	style:left="{left}px"
	style:top="{top}px"
	onkeydown={keydown}
	oncontextmenu={(event) => event.preventDefault()}
>
	{#if note}<p class="note" id={noteId}>{note}</p>{/if}
	<!-- An item's key is drawn beside it rather than in it, so the item is called what it does, and says its key as
		 `aria-keyshortcuts`. -->
	{#each items as item, index (item.label)}
		<div class="item">
			<button
				type="button"
				role="menuitem"
				tabindex="-1"
				data-index={index}
				disabled={item.disabled}
				class:keyed={!!item.keys}
				onclick={() => choose(item)}
				aria-keyshortcuts={item.keys ? ariaKeys(item.keys) : undefined}
				onpointerenter={(event) => event.currentTarget.focus({ preventScroll: true })}>{item.label}</button
			>
			{#if item.keys}<span class="keys" aria-hidden="true">{keyLabel(item.keys)}</span>{/if}
		</div>
	{/each}
</div>

<style>
	.note {
		max-width: 16rem;
		margin: 0.15rem 0.4rem 0.3rem;
		font-size: 0.72rem;
		color: var(--muted);
	}
	.menu {
		position: fixed;
		z-index: 100;
		display: flex;
		flex-direction: column;
		min-width: 10rem;
		padding: 0.25rem;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 6px;
		box-shadow: 0 6px 18px #00000080;
		outline: none;
	}
	.item {
		position: relative;
		display: flex;
	}
	button {
		flex: 1;
		border: 0;
		border-radius: 4px;
		background: transparent;
		text-align: left;
		padding: 0.3rem 0.6rem;
		font-size: 0.8rem;
		outline: none;
	}
	button.keyed {
		padding-right: 5rem;
	}
	.keys {
		position: absolute;
		right: 0.6rem;
		top: 50%;
		transform: translateY(-50%);
		color: var(--muted);
		font-size: 0.75rem;
		pointer-events: none;
	}
	button:focus-visible,
	button:focus {
		background: #1f6feb50;
	}
</style>
