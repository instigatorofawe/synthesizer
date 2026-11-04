<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import ContextMenu, { type MenuItem } from '#lib/ContextMenu.svelte';
	import { actionOn, stay, withoutPlace, withParams } from '#lib/Workspace.ts';

	// The Song tab's ▾: what is done to the song as a whole, which is rare, so it stays out of the toolbars. A saved timeline is
	// renamed, exported and deleted from here, and an example added to the library. The actions that the server does are forms,
	// kept on the page out of sight, which an item sends. Import MIDI file… is here whatever is open, since it makes a song of
	// its own rather than changing this one: it asks for a file, which the page imports.
	let {
		search,
		timeline,
		example,
		rendering,
		canRender,
		onrename,
		onwav,
		onmidi
	}: {
		search: string;
		timeline: { id: string } | null; // The saved timeline open
		example: { name: string; inLibrary: string | null } | null; // Or the example, and its copy in the library if it has one
		rendering: number | null; // How far a WAV export has got
		canRender: boolean; // Whether the song has compiled, so there is something to render
		onrename: () => void; // Goes to the name, to type another
		onwav: () => void;
		onmidi: (file: File) => void; // A MIDI file chosen, to make a song of
	} = $props();

	let at = $state.raw<{ x: number; y: number } | null>(null);
	let exportForm = $state<HTMLFormElement>();
	let deleteForm = $state<HTMLFormElement>();
	let addForm = $state<HTMLFormElement>();
	let midiField = $state<HTMLInputElement>();

	const midi: MenuItem = { label: 'Import MIDI file…', action: () => midiField?.click() };

	const wav = $derived<MenuItem>({
		label: rendering === null ? 'Export WAV' : `Rendering ${Math.round(rendering * 100)}%`,
		action: onwav,
		disabled: !canRender || rendering !== null
	});

	const items = $derived.by((): MenuItem[] => {
		if (example) {
			const library: MenuItem = example.inLibrary
				? {
						label: 'Open in the library',
						action: () =>
							void goto(withParams(search, { timeline: example.inLibrary, recipe: null, part: null, patch: null }))
					}
				: { label: 'Add to library', action: () => addForm?.requestSubmit() };
			return [library, wav, midi];
		}
		if (!timeline) return [];
		return [
			{ label: 'Rename', action: onrename },
			wav,
			{ label: 'Export saved version', action: () => exportForm?.requestSubmit() },
			midi,
			{ label: 'Delete song', action: () => deleteForm?.requestSubmit() }
		];
	});

	// It opens under the ▾. A second press on the ▾ shuts it, which the menu would otherwise take as a press outside it and then
	// open again.
	function toggle(event: MouseEvent) {
		if (at) {
			at = null;
			return;
		}
		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		at = { x: box.left, y: box.bottom + 2 };
	}
</script>

{#if items.length}
	<button
		type="button"
		class="opener"
		aria-label="Song menu"
		aria-haspopup="menu"
		aria-expanded={at !== null}
		title={example
			? 'Add this example to the library, export it, or import a MIDI file'
			: 'Rename, export or delete this song, or import a MIDI file'}
		onpointerdown={(event) => {
			if (at) event.stopPropagation();
		}}
		onclick={toggle}><span aria-hidden="true">▾</span></button
	>
{/if}

{#if at}
	<ContextMenu x={at.x} y={at.y} label="Song" {items} onclose={() => (at = null)} />
{/if}

<!-- Emptied once a file is taken, so choosing the same file again imports it again. -->
<input
	bind:this={midiField}
	class="unseen"
	type="file"
	accept=".mid,.midi,audio/midi,audio/x-midi"
	tabindex="-1"
	aria-label="MIDI file"
	onchange={(event) => {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = '';
		if (file) onmidi(file);
	}}
/>

<div hidden>
	{#if timeline}
		<form method="POST" action={actionOn(search, 'exportTimeline')} use:enhance={stay} bind:this={exportForm}>
			<input type="hidden" name="id" value={timeline.id} />
		</form>
		<!-- The song that opens instead has tracks and clips of its own, so the deleted one's place doesn't go with it. -->
		<form method="POST" action={actionOn(search, 'deleteTimeline')} use:enhance={stay} bind:this={deleteForm}>
			<input type="hidden" name="id" value={timeline.id} />
			<input type="hidden" name="back" value={withoutPlace(search)} />
		</form>
	{/if}
	{#if example && !example.inLibrary}
		<form method="POST" action={actionOn(search, 'addRecipe')} use:enhance bind:this={addForm}>
			<input type="hidden" name="name" value={example.name} />
		</form>
	{/if}
</div>

<style>
	/* The file field Import MIDI file… opens, out of sight. */
	.unseen {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		opacity: 0;
	}
	/* 24 px square, the least a target should be, inside the room the Song tab leaves at its end. */
	.opener {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 0;
		border-radius: 3px;
		background: transparent;
		color: var(--muted);
		line-height: 1.3;
	}
	.opener:hover,
	.opener[aria-expanded='true'] {
		color: var(--text);
		background: #ffffff1a;
	}
</style>
