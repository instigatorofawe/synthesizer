<script lang="ts">
	// A bar between two panels, dragged or moved with the arrow keys, that reports how far it moved. Double-click asks for the
	// size it started at.
	let { label, onmove, onreset }: { label: string; onmove: (pixels: number) => void; onreset?: () => void } = $props();

	let from: number | null = null;

	function down(event: PointerEvent) {
		from = event.clientY;
		(event.currentTarget as Element).setPointerCapture(event.pointerId);
		event.preventDefault();
	}

	function move(event: PointerEvent) {
		if (from === null) return;
		onmove(event.clientY - from);
		from = event.clientY;
	}

	function key(event: KeyboardEvent) {
		const step = event.shiftKey ? 64 : 16;
		if (event.key === 'ArrowUp') onmove(-step);
		else if (event.key === 'ArrowDown') onmove(step);
		else return;
		event.preventDefault();
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	class="splitter"
	role="separator"
	aria-orientation="horizontal"
	aria-label={label}
	tabindex="0"
	onpointerdown={down}
	onpointermove={move}
	onpointerup={() => (from = null)}
	onpointercancel={() => (from = null)}
	onkeydown={key}
	ondblclick={() => onreset?.()}
></div>

<style>
	.splitter {
		flex: none;
		height: 6px;
		cursor: row-resize;
		background: var(--bg);
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
		touch-action: none;
		outline: none;
	}
	.splitter:hover,
	.splitter:focus-visible {
		background: #1f6feb55;
	}
</style>
