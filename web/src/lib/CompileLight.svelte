<script lang="ts">
	import type { Snippet } from 'svelte';
	import { lightOf, type Problem } from '#lib/Problems.ts';
	import { matches } from '#lib/Shortcuts.ts';

	// The compile light, in the top bar where the status bar was: at a glance, whether what is on screen compiles. It says when
	// an edit is compiling, until the image made from it is playing, so what is heard is known to be the newest edit. A click
	// lists the problems, each a link to where it is, and what the engine is doing.
	//
	// The list stays on the page while it is shut, so what it says can be read without opening it.
	let {
		busy,
		heard = 'none',
		problems,
		size,
		details
	}: {
		busy: boolean; // An edit is compiling, or its image is on its way to the engine
		heard?: 'none' | 'older' | 'newest'; // Whether the image playing is the newest edit's: none before one plays
		problems: Problem[];
		size: string; // How big the last image that compiled is, or nothing if none has
		details?: Snippet; // What the engine is doing, under the list
	} = $props();

	let open = $state(false);
	let root: HTMLDivElement;
	let button: HTMLButtonElement;

	const light = $derived(lightOf(busy, problems, size));
	// Once nothing is on its way, an older image playing is shown by a hollow lamp, and said: what is heard isn't what is on
	// screen, as after a refused edit, or when the engine refused the newest image.
	const older = $derived(!busy && heard === 'older');
	const ordered = $derived([
		...problems.filter((problem) => problem.severity === 'error'),
		...problems.filter((problem) => problem.severity === 'warning')
	]);
	const summary = $derived.by(() => {
		if (light.state === 'compiling') return 'Compiling the newest edit.';
		if (light.state === 'idle') return 'Nothing is open to compile.';
		if (light.state === 'fine' && older)
			return `It compiles, to a ${size} image, but an older image is the one playing.`;
		if (light.state === 'fine') return `Everything on screen compiles, to a ${size} image.`;
		const made = size ? ` The last ${size} image that compiled is the one playing.` : '';
		return light.state === 'problems' ? `It doesn't all compile.${made}` : `It compiles, but may not sound as meant.`;
	});

	function go(problem: Problem) {
		open = false;
		problem.go?.();
	}

	function outside(event: PointerEvent) {
		if (open && !root.contains(event.target as Node)) open = false;
	}

	// Esc shuts the list, and goes no further: it was for the list.
	function keydown(event: KeyboardEvent) {
		if (!open || !matches(event, 'escape')) return;
		event.preventDefault();
		event.stopPropagation();
		open = false;
		button.focus();
	}
</script>

<svelte:window onpointerdown={outside} />

<div
	class="light"
	bind:this={root}
	data-testid="status"
	aria-busy={busy}
	data-heard={heard}
	role="presentation"
	onkeydown={keydown}
>
	<button
		bind:this={button}
		type="button"
		class={`lamp ${light.state}`}
		class:older
		aria-label={`Compile status: ${light.label || 'nothing to compile'}${older ? ', an older image playing' : ''}`}
		aria-expanded={open}
		aria-controls="compile-status"
		title={`${summary} Click for the problems and the engine.`}
		onclick={() => (open = !open)}
	>
		<span class="dot" aria-hidden="true"></span>
		<span class="label">{light.label}</span>
	</button>
	<section id="compile-status" class="panel" aria-label="Compile status" hidden={!open}>
		<p class="summary">{summary}</p>
		{#if ordered.length}
			<ul>
				{#each ordered as problem (problem.key)}
					<li class={problem.severity} data-testid={problem.testid}>
						{#if problem.go}
							<button type="button" class="place" title="Show where it is" onclick={() => go(problem)}
								>{problem.place}</button
							>
						{:else}
							<span class="place">{problem.place}</span>
						{/if}
						<span class="message">{problem.message}</span>
					</li>
				{/each}
			</ul>
		{/if}
		{@render details?.()}
	</section>
</div>

<style>
	.light {
		position: relative;
	}
	.lamp {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 6.5rem;
		padding: 0.2rem 0.6rem;
		font-variant-numeric: tabular-nums;
	}
	.dot {
		flex: none;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: #3fb950;
	}
	.idle .dot {
		background: #30363d;
	}
	.compiling .dot {
		background: #58a6ff;
		animation: pulse 0.9s ease-in-out infinite alternate;
	}
	.warnings .dot {
		background: #d29922;
	}
	.problems .dot {
		background: #f85149;
	}
	/* An older image playing: the lamp's colour stays what the problems say, as a ring. */
	.older .dot {
		background: transparent;
		box-shadow: inset 0 0 0 2px #3fb950;
	}
	.older.warnings .dot {
		box-shadow: inset 0 0 0 2px #d29922;
	}
	.older.problems .dot {
		box-shadow: inset 0 0 0 2px #f85149;
	}
	.problems .label {
		color: #ff7b72;
	}
	.warnings .label {
		color: #e3b341;
	}
	.label {
		color: var(--muted);
	}
	@keyframes pulse {
		from {
			opacity: 0.35;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.compiling .dot {
			animation: none;
		}
	}
	/* Under the light, against the right of the page, over the views. */
	.panel {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 40;
		width: 30rem;
		max-width: calc(100vw - 2rem);
		max-height: 60vh;
		overflow: auto;
		padding: 0.5rem 0.7rem;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 6px;
		box-shadow: 0 6px 18px #00000080;
		white-space: normal;
		font-size: 0.8rem;
	}
	.panel[hidden] {
		display: none;
	}
	.summary {
		margin: 0 0 0.4rem;
	}
	ul {
		list-style: none;
		margin: 0 0 0.4rem;
		padding: 0;
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.15rem 0.5rem;
		padding: 0.3rem 0.4rem;
		border-left: 3px solid #f85149;
		background: #f851490f;
		margin-bottom: 0.25rem;
		border-radius: 0 4px 4px 0;
	}
	li.warning {
		border-left-color: #d29922;
		background: #d299220f;
	}
	.place {
		font-weight: 600;
	}
	button.place {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		text-decoration: underline;
		text-align: left;
	}
	.message {
		min-width: 0;
		overflow-wrap: anywhere;
	}
</style>
