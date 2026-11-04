<script lang="ts">
	// Where a compact Scope will be, until the engine says what it watches: the same caption and the same height, so nothing
	// below moves when audio starts and the scope takes its place.
	let { label, message }: { label: string; message: string } = $props();
</script>

<figure class="placeholder">
	<figcaption><span>{label}</span></figcaption>
	<p class="muted">{message}</p>
</figure>

<style>
	/* Scope.svelte's compact figure: a 1 px border, its caption, and a 60 px canvas. */
	.placeholder {
		margin: 0;
		border: 1px dashed var(--line);
		border-radius: 6px;
	}
	figcaption {
		display: flex;
		align-items: center;
		padding: 0.3rem 0.5rem;
		font-size: 0.8rem;
		color: var(--muted);
	}
	p {
		height: 60px;
		margin: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		text-align: center;
		font-size: 0.72rem;
	}
</style>
