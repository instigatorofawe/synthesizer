<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import type { CompileReport } from '#lib/Request.ts';
	import ReportPanel from '#lib/ReportPanel.svelte';
	import { actionOn, stay } from '#lib/Workspace.ts';

	// A bundle over the editor: which timelines go in it, in the order a device numbers them, and its export.
	let {
		bundle,
		timelines,
		search,
		report,
		onclose
	}: {
		bundle: { id: string; name: string; revision: number; timelines: string[] };
		timelines: { id: string; name: string }[];
		search: string;
		report: CompileReport | null; // From the last export
		onclose: () => void;
	} = $props();

	let name = $state(untrack(() => bundle.name));
	let selected = $state(untrack(() => [...bundle.timelines]));
	let dialog: HTMLDialogElement;

	function toggle(id: string, on: boolean) {
		selected = on ? [...selected, id] : selected.filter((s) => s !== id);
	}

	$effect(() => {
		dialog.showModal();
	});
</script>

<dialog bind:this={dialog} aria-label={`Bundle ${bundle.name}`} {onclose} oncancel={onclose}>
	<header>
		<h2>Bundle</h2>
		<button type="button" class="close" aria-label="Close" onclick={() => dialog.close()}>×</button>
	</header>

	<form method="POST" action={actionOn(search, 'saveBundle')} use:enhance={stay}>
		<input type="hidden" name="id" value={bundle.id} />
		<input type="hidden" name="revision" value={bundle.revision} />
		<div class="row">
			<input name="name" bind:value={name} aria-label="Bundle name" />
			<button>Save bundle</button>
		</div>
		<h3>Programs</h3>
		<p class="muted">A Program's position here is how a device selects it, so the order you tick them in is kept.</p>
		<ul class="list">
			{#each timelines as timeline (timeline.id)}
				<li>
					<label>
						<input
							type="checkbox"
							checked={selected.includes(timeline.id)}
							onchange={(e) => toggle(timeline.id, e.currentTarget.checked)}
						/>
						{timeline.name}
						{#if selected.includes(timeline.id)}<span class="muted">#{selected.indexOf(timeline.id)}</span>{/if}
					</label>
				</li>
			{/each}
		</ul>
		{#each selected as id (id)}<input type="hidden" name="timeline" value={id} />{/each}
	</form>

	<h3>Export</h3>
	<form method="POST" action={actionOn(search, 'exportBundle')} use:enhance={stay} class="row">
		<input type="hidden" name="id" value={bundle.id} />
		<label><input type="checkbox" name="thin" /> Programs only, for a receiver that already holds these patches</label>
		<button>Export saved bundle</button>
	</form>
	{#if report}<ReportPanel {report} />{/if}

	<form method="POST" action={actionOn(search, 'deleteBundle')} use:enhance={stay} class="danger">
		<input type="hidden" name="id" value={bundle.id} />
		<input type="hidden" name="back" value={search} />
		<button>Delete bundle</button>
	</form>
</dialog>

<style>
	dialog {
		width: min(640px, 90vw);
		max-height: 85vh;
		overflow: auto;
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 0.8rem 1rem 1rem;
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
	h3 {
		font-size: 0.9rem;
		margin: 1rem 0 0.3rem;
	}
	.close {
		padding: 0 0.5rem;
	}
	.danger {
		margin-top: 1rem;
	}
</style>
