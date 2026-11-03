<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { ariaKeys, label as keyLabel, type ShortcutId } from '#lib/Shortcuts.ts';

	export interface MenuItem {
		label: string;
		action: () => void;
		disabled?: boolean;
		keys?: ShortcutId; // The key that does the same, shown at the item's right, as a desktop menu shows it
	}

	let {
		x,
		y,
		label,
		items,
		onclose
	}: {
		x: number; // Where it opens, in the window's pixels
		y: number;
		label: string;
		items: MenuItem[];
		onclose: () => void;
	} = $props();

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
	style:left="{left}px"
	style:top="{top}px"
	onkeydown={keydown}
	oncontextmenu={(event) => event.preventDefault()}
>
	{#each items as item, index (item.label)}
		<button
			type="button"
			role="menuitem"
			tabindex="-1"
			data-index={index}
			disabled={item.disabled}
			onclick={() => choose(item)}
			aria-keyshortcuts={item.keys ? ariaKeys(item.keys) : undefined}
			onpointerenter={(event) => event.currentTarget.focus({ preventScroll: true })}
			><span>{item.label}</span>{#if item.keys}<span class="keys" aria-hidden="true">{keyLabel(item.keys)}</span
				>{/if}</button
		>
	{/each}
</div>

<style>
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
	button {
		display: flex;
		justify-content: space-between;
		gap: 1.5rem;
		border: 0;
		border-radius: 4px;
		background: transparent;
		text-align: left;
		padding: 0.3rem 0.6rem;
		font-size: 0.8rem;
		outline: none;
	}
	.keys {
		color: var(--muted);
	}
	button:focus-visible,
	button:focus {
		background: #1f6feb50;
	}
</style>
