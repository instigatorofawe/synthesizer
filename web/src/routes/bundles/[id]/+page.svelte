<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import { downloadImage } from '#lib/Download.ts';
	import ReportPanel from '#lib/ReportPanel.svelte';

	let { data, form } = $props();

	// The editors hold a working copy of what was loaded, so later `data` must not overwrite unsaved edits.

	let name = $state(untrack(() => data.bundle.name));
	let revision = $state(untrack(() => data.bundle.revision));
	let selected = $state(untrack(() => data.bundle.timelines.map((t) => t.id)));

	function toggle(id: string, on: boolean) {
		selected = on ? [...selected, id] : selected.filter((s) => s !== id);
	}

	$effect(() => {
		if (form?.exported) downloadImage(form.exported.image, `${name}.msimg`);
	});
</script>

<h1>{name}</h1>

{#if form?.message}<p class="problem">{form.message}</p>{/if}
{#if form?.saved}<p class="muted">Saved.</p>{/if}

<form
	method="POST"
	action="?/save"
	use:enhance={() =>
		({ result, update }) => {
			if (result.type === 'success' && typeof result.data?.revision === 'number') revision = result.data.revision;
			return update({ reset: false });
		}}
>
	<div class="row">
		<input name="name" bind:value={name} aria-label="Bundle name" />
		<input type="hidden" name="revision" value={revision} />
		<button>Save</button>
		<button formaction="?/delete" formnovalidate>Delete</button>
	</div>
	<h2>Programs</h2>
	<p class="muted">A Program's position here is how a device selects it, so the order you tick them in is kept.</p>
	<ul class="list">
		{#each data.all as timeline}
			<li>
				<label>
					<input
						type="checkbox"
						checked={selected.includes(timeline.id)}
						onchange={(e) => toggle(timeline.id, e.currentTarget.checked)}
					/>
					{timeline.name}
				</label>
			</li>
		{/each}
	</ul>
	{#each selected as id}<input type="hidden" name="timeline" value={id} />{/each}
</form>

<h2>Export</h2>
<form method="POST" action="?/export" use:enhance={() => ({ update }) => update({ reset: false })} class="row">
	<label><input type="checkbox" name="thin" /> Programs only, for a receiver that already holds these patches</label>
	<button>Export saved bundle</button>
</form>

{#if form?.exported}<ReportPanel report={form.exported.report} />{/if}
