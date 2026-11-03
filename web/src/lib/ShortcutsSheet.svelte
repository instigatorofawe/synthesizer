<script lang="ts">
	import { label, matches, modKey, sheet } from '#lib/Shortcuts.ts';

	// Every key the editor binds, drawn from Shortcuts.ts so it can't drift from what the keys do, with the piano's keys and the
	// gestures a key changes. ? opens it, and Esc or ? closes it.
	let { onclose }: { onclose: () => void } = $props();

	const mod = modKey();
	const groups = sheet(mod);
	const modName = mod === 'Meta' ? '⌘' : 'Ctrl';
	let dialog: HTMLDialogElement;

	$effect(() => {
		dialog.showModal();
	});

	const GESTURES: { what: string; does: string }[] = [
		{
			what: 'Click in the roll',
			does: 'Add a note as long as the Draw length; drag before letting go to set its length'
		},
		{ what: 'Drag across an empty row', does: 'Draw a clip of whole bars in the arrangement' },
		{ what: `${modName}-drag`, does: 'Copy notes, clips or nodes, leaving the originals where they were' },
		{ what: 'Shift-drag on the graph', does: 'Choose the nodes a box touches; Shift-click adds or takes away one' },
		{ what: `${modName} with the wheel, or a pinch`, does: 'Zoom where the pointer is' },
		{ what: 'Shift with the wheel', does: 'Scroll the roll sideways' },
		{ what: 'Right-click', does: `The menu of what is under the pointer (${label('menu', mod)} for what has focus)` },
		{ what: 'Double-click', does: 'A clip: Expand. Empty canvas: find a node. A head fader or pan: reset it.' }
	];

	function keydown(event: KeyboardEvent) {
		if (matches(event, 'shortcuts', mod)) {
			event.preventDefault();
			dialog.close();
		}
	}
</script>

<dialog bind:this={dialog} aria-label="Keyboard shortcuts" {onclose} onkeydown={keydown}>
	<header>
		<h2>Keyboard shortcuts</h2>
		<button type="button" class="close" aria-label="Close" onclick={() => dialog.close()}>×</button>
	</header>
	<p class="muted">
		Mod is {modName} here. No key needs Alt. A key typed into a field is the field's, and Enter or Esc leaves it.
	</p>
	<div class="columns">
		{#each groups as group (group.scope)}
			<section aria-label={group.name}>
				<h3>{group.name}</h3>
				<dl>
					{#each group.rows as row (row.description)}
						<dt>
							{#each row.keys as key, index (key)}{#if index}<span class="or">or</span>{/if}<kbd>{key}</kbd>{/each}
						</dt>
						<dd>{row.description}</dd>
					{/each}
				</dl>
			</section>
		{/each}
		<section aria-label="The computer keys as a piano">
			<h3>The keys as a piano</h3>
			<dl>
				<dt><kbd>A</kbd> to <kbd>'</kbd></dt>
				<dd>White keys from C: A S D F G H J K L ; '</dd>
				<dt><kbd>W</kbd> to <kbd>P</kbd></dt>
				<dd>Black keys: W E T Y U O P</dd>
				<dt><kbd>{label('octave-down', mod)}</kbd><span class="or">and</span><kbd>{label('octave-up', mod)}</kbd></dt>
				<dd>An octave down and up</dd>
			</dl>
		</section>
		<section aria-label="With the mouse">
			<h3>With the mouse</h3>
			<dl>
				{#each GESTURES as gesture (gesture.what)}
					<dt>{gesture.what}</dt>
					<dd>{gesture.does}</dd>
				{/each}
			</dl>
		</section>
	</div>
</dialog>

<style>
	dialog {
		width: min(980px, 94vw);
		max-height: 88vh;
		overflow: auto;
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 0.8rem 1rem 1rem;
		font-size: 0.8rem;
	}
	dialog::backdrop {
		background: #0008;
	}
	header {
		display: flex;
		align-items: center;
	}
	h2 {
		flex: 1;
		margin: 0;
		font-size: 1rem;
	}
	p {
		margin: 0.3rem 0 0.6rem;
	}
	.close {
		padding: 0 0.5rem;
	}
	.columns {
		columns: 3 18rem;
		column-gap: 1.5rem;
	}
	section {
		break-inside: avoid;
		margin-bottom: 0.9rem;
	}
	h3 {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
		margin: 0 0 0.3rem;
	}
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.25rem 0.6rem;
		margin: 0;
	}
	dt {
		white-space: nowrap;
	}
	dd {
		margin: 0;
	}
	kbd {
		display: inline-block;
		min-width: 1.1em;
		padding: 0 0.3em;
		border: 1px solid var(--line);
		border-bottom-width: 2px;
		border-radius: 4px;
		background: var(--panel);
		font: inherit;
		text-align: center;
	}
	.or {
		margin: 0 0.25em;
		color: var(--muted);
	}
</style>
