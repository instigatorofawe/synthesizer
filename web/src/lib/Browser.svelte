<script lang="ts">
	import { enhance } from '$app/forms';
	import { actionOn, draftKey, isInsert, withParams } from '#lib/Workspace.ts';
	import type { Graph } from '#lib/Schema.ts';

	// The sidebar: the library on top and the examples that ship with the app below. Everything in it is a link that changes what
	// the page shows, so the page, its audio and its unsaved edits stay where they are.
	let {
		search,
		examples,
		timelines,
		patches,
		samples,
		bundles,
		dirty,
		openTimeline,
		openRecipe,
		shownPatch
	}: {
		search: string; // The page's address now, which every link here changes a part of
		examples: { name: string; recipes: { name: string; listen_for: string }[] }[];
		timelines: { id: string; name: string }[];
		patches: { id: string; name: string; graph: Graph; users: { id: string; name: string }[] }[];
		samples: { id: string; name: string; frames: number; rate: number; channels: number; patches: number }[];
		bundles: { id: string; name: string }[];
		dirty: Set<string>; // Draft keys of what is unsaved
		openTimeline: string | null;
		openRecipe: string | null;
		shownPatch: string | null;
	} = $props();

	let filter = $state('');

	const matches = (name: string) => !filter.trim() || name.toLowerCase().includes(filter.trim().toLowerCase());

	const timelineHref = (id: string) => withParams(search, { timeline: id, recipe: null, patch: null, part: null });
	const recipeHref = (name: string) => withParams(search, { recipe: name, timeline: null, patch: null, part: null });
	const patchHref = (id: string) => withParams(search, { patch: id, part: null });
	const bundleHref = (id: string) => withParams(search, { bundle: id });

	const shownTimelines = $derived(timelines.filter((t) => matches(t.name)));
	const shownPatches = $derived(patches.filter((p) => matches(p.name)));
	const shownSamples = $derived(samples.filter((s) => matches(s.name)));
	const shownBundles = $derived(bundles.filter((b) => matches(b.name)));
	const shownExamples = $derived(
		examples
			.map((group) => ({ ...group, recipes: group.recipes.filter((r) => matches(r.name)) }))
			.filter((g) => g.recipes.length)
	);
</script>

{#snippet unsaved(key: string)}
	{#if dirty.has(key)}<span class="dot" title="Unsaved changes" aria-label="unsaved">•</span>{/if}
{/snippet}

<nav class="browser" aria-label="Browser">
	<input class="filter" type="search" placeholder="Filter" aria-label="Filter the browser" bind:value={filter} />

	<div class="scroll">
		<h2>Library</h2>

		<details open>
			<summary>Timelines <span class="count">{timelines.length}</span></summary>
			<ul aria-label="Timelines">
				{#each shownTimelines as timeline (timeline.id)}
					<li>
						<a href={timelineHref(timeline.id)} aria-current={timeline.id === openTimeline ? 'page' : undefined}>
							{timeline.name}{@render unsaved(draftKey('timeline', timeline.id))}
						</a>
					</li>
				{/each}
			</ul>
			<form method="POST" action={actionOn(search, 'createTimeline')} use:enhance class="add">
				<input type="hidden" name="back" value={search} />
				<input name="name" placeholder="New timeline" aria-label="New timeline name" required />
				<button aria-label="Add timeline">+</button>
			</form>
		</details>

		<details open>
			<summary>Patches <span class="count">{patches.length}</span></summary>
			<ul aria-label="Patches">
				{#each shownPatches as patch (patch.id)}
					<li>
						<a
							href={patchHref(patch.id)}
							aria-current={patch.id === shownPatch ? 'true' : undefined}
							title={patch.users.length
								? `Used by ${patch.users.map((u) => u.name).join(', ')}`
								: 'Not used by a timeline'}
						>
							{patch.name}{@render unsaved(draftKey('patch', patch.id))}
							{#if isInsert(patch.graph)}<span class="tag">insert</span>{/if}
						</a>
					</li>
				{/each}
			</ul>
			<form method="POST" action={actionOn(search, 'createPatch')} use:enhance class="add">
				<input type="hidden" name="back" value={search} />
				<input name="name" placeholder="New patch" aria-label="New patch name" required />
				<button aria-label="Add patch">+</button>
			</form>
		</details>

		<details open>
			<summary>Samples <span class="count">{samples.length}</span></summary>
			<p class="muted note">
				WAV files become one playable instrument, with a zone for each. A file's sampler chunk or a name like
				Piano_C4.wav says which key it was recorded at.
			</p>
			<ul aria-label="Samples">
				{#each shownSamples as sample (sample.id)}
					<li class="sample">
						<span
							title={`${(sample.frames / sample.rate).toFixed(2)} s, ${sample.channels === 1 ? 'mono' : 'stereo'}, used by ${sample.patches}`}
						>
							{sample.name}
						</span>
						<form method="POST" action={actionOn(search, 'deleteAsset')} use:enhance>
							<input type="hidden" name="id" value={sample.id} />
							<button class="remove" aria-label={`Delete ${sample.name}`}>×</button>
						</form>
					</li>
				{/each}
			</ul>
			<form
				method="POST"
				action={actionOn(search, 'importSamples')}
				enctype="multipart/form-data"
				use:enhance
				class="import"
			>
				<input type="hidden" name="back" value={search} />
				<input type="file" name="files" accept=".wav,audio/wav" multiple aria-label="WAV files" />
				<div class="add">
					<input name="name" placeholder="Instrument name" aria-label="Instrument name" />
					<button>Import</button>
				</div>
			</form>
		</details>

		<details open>
			<summary>Bundles <span class="count">{bundles.length}</span></summary>
			<p class="muted note">Several timelines compiled into one image, for a device to choose between.</p>
			<ul aria-label="Bundles">
				{#each shownBundles as bundle (bundle.id)}
					<li><a href={bundleHref(bundle.id)}>{bundle.name}</a></li>
				{/each}
			</ul>
			<form method="POST" action={actionOn(search, 'createBundle')} use:enhance class="add">
				<input type="hidden" name="back" value={search} />
				<input name="name" placeholder="New bundle" aria-label="New bundle name" required />
				<button aria-label="Add bundle">+</button>
			</form>
		</details>

		<h2>Examples</h2>
		<p class="muted note">
			Short pieces that ship with the app. Each plays as it is, and adding one to the library makes copies to change.
		</p>
		{#each shownExamples as group (group.name)}
			<details open={filter.trim() !== '' || group.recipes.some((r) => r.name === openRecipe) || undefined}>
				<summary>{group.name} <span class="count">{group.recipes.length}</span></summary>
				<ul>
					{#each group.recipes as recipe (recipe.name)}
						<li>
							<a
								href={recipeHref(recipe.name)}
								title={recipe.listen_for}
								aria-current={recipe.name === openRecipe ? 'page' : undefined}
							>
								{recipe.name}
							</a>
						</li>
					{/each}
				</ul>
			</details>
		{/each}
	</div>
</nav>

<style>
	.browser {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--panel);
		border-right: 1px solid var(--line);
		font-size: 0.82rem;
	}
	.filter {
		margin: 0.5rem;
		padding: 0.25rem 0.5rem;
		font-size: 0.8rem;
	}
	.scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0 0.5rem 1rem;
	}
	h2 {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
		margin: 0.8rem 0 0.3rem;
	}
	details {
		margin-bottom: 0.3rem;
	}
	summary {
		cursor: pointer;
		padding: 0.2rem 0;
		font-weight: 600;
	}
	.count {
		color: var(--muted);
		font-weight: 400;
		font-size: 0.72rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li a,
	.sample > span {
		display: block;
		padding: 0.15rem 0.4rem 0.15rem 0.8rem;
		border-radius: 4px;
		color: var(--text);
		text-decoration: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	li a:hover {
		background: #1a212b;
	}
	li a[aria-current] {
		background: #1f6feb33;
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.sample {
		display: flex;
		align-items: center;
	}
	.sample > span {
		flex: 1;
		min-width: 0;
	}
	.remove {
		padding: 0 0.35rem;
		font-size: 0.75rem;
		border-color: transparent;
		background: transparent;
	}
	.dot {
		color: #d29922;
		margin-left: 0.25rem;
	}
	.tag {
		margin-left: 0.35rem;
		font-size: 0.65rem;
		color: var(--muted);
		border: 1px solid var(--line);
		border-radius: 3px;
		padding: 0 0.2rem;
	}
	.add {
		display: flex;
		gap: 0.25rem;
		margin: 0.3rem 0 0.2rem 0.8rem;
	}
	.add input {
		flex: 1;
		min-width: 0;
		padding: 0.15rem 0.4rem;
		font-size: 0.78rem;
	}
	.add button {
		padding: 0.1rem 0.5rem;
		font-size: 0.78rem;
	}
	.import {
		margin-left: 0.8rem;
	}
	.import input[type='file'] {
		width: 100%;
		box-sizing: border-box;
		font-size: 0.72rem;
		padding: 0.15rem;
		margin-top: 0.3rem;
	}
	.import .add {
		margin-left: 0;
	}
	.note {
		font-size: 0.72rem;
		margin: 0.1rem 0 0.3rem 0.8rem;
	}
</style>
