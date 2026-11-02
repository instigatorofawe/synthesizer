<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

{#if form?.message}<p class="problem">{form.message}</p>{/if}

<div class="columns">
	<section>
		<h2>Patches</h2>
		<p class="muted">Global. Any timeline can use any patch, and an image holds only the ones it reaches.</p>
		<ul class="list">
			{#each data.patches as patch}
				<li>
					<a href="/patches/{patch.id}">{patch.name}</a>
					<span class="muted">used by {patch.timelines}</span>
				</li>
			{/each}
		</ul>
		<form method="POST" action="?/createPatch" use:enhance class="row">
			<input name="name" placeholder="New patch" aria-label="New patch name" required />
			<button>Add</button>
		</form>
	</section>

	<section>
		<h2>Samples</h2>
		<p class="muted">
			WAV files become one playable instrument, with a zone for each. A file's sampler chunk or a name like Piano_C4.wav says which
			key it was recorded at.
		</p>
		<ul class="list">
			{#each data.assets as asset (asset.id)}
				<li class="row">
					<span>{asset.name}</span>
					<span class="muted">
						{(asset.frames / asset.rate).toFixed(2)} s, {asset.channels === 1 ? 'mono' : 'stereo'}, used by {asset.patches}
					</span>
					<form method="POST" action="?/deleteAsset" use:enhance>
						<input type="hidden" name="id" value={asset.id} />
						<button aria-label={`Delete ${asset.name}`}>×</button>
					</form>
				</li>
			{/each}
		</ul>
		<form method="POST" action="?/importSamples" enctype="multipart/form-data" use:enhance class="row">
			<input type="file" name="files" accept=".wav,audio/wav" multiple aria-label="WAV files" />
			<input name="name" placeholder="Instrument name" aria-label="Instrument name" />
			<button>Import</button>
		</form>
	</section>

	<section>
		<h2>Timelines</h2>
		<p class="muted">Each compiles to one Program.</p>
		<ul class="list">
			{#each data.timelines as timeline}
				<li><a href="/timelines/{timeline.id}">{timeline.name}</a></li>
			{/each}
		</ul>
		<form method="POST" action="?/createTimeline" use:enhance class="row">
			<input name="name" placeholder="New timeline" aria-label="New timeline name" required />
			<button>Add</button>
		</form>
	</section>

	<section>
		<h2>Bundles</h2>
		<p class="muted">Several Programs compiled together with one shared set of patches.</p>
		<ul class="list">
			{#each data.bundles as bundle}
				<li><a href="/bundles/{bundle.id}">{bundle.name}</a></li>
			{/each}
		</ul>
		<form method="POST" action="?/createBundle" use:enhance class="row">
			<input name="name" placeholder="New bundle" aria-label="New bundle name" required />
			<button>Add</button>
		</form>
	</section>
</div>
