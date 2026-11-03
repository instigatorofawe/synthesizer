<script lang="ts" module>
	// The browser's lists, which its rail has an icon for each of.
	export const SECTIONS = [
		{ id: 'timelines', name: 'Timelines', icon: '♫' },
		{ id: 'patches', name: 'Patches', icon: '◆' },
		{ id: 'samples', name: 'Samples', icon: '∿' },
		{ id: 'builtins', name: 'Built-in patches', icon: '▣' },
		{ id: 'bundles', name: 'Bundles', icon: '▤' },
		{ id: 'examples', name: 'Examples', icon: '▶' }
	] as const;

	export type Section = (typeof SECTIONS)[number]['id'];

	// What each list is for.
	const SAMPLES =
		"WAV files become one playable instrument, with a zone for each. A file's sampler chunk or a name like Piano_C4.wav says which key it was recorded at.";
	const BUILTINS =
		"Every example's patches, for any timeline to play. They can't be changed: Edit a copy makes one that can.";
	const BUNDLES = 'Several timelines compiled into one image, for a device to choose between.';
	const EXAMPLES =
		'Short pieces that ship with the app. Each plays as it is, its patches are built in, and adding one to the library copies its timeline to change.';
</script>

<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { tick, untrack } from 'svelte';
	import { matches as pressed } from '#lib/Shortcuts.ts';
	import { actionOn, draftKey, isInsert, withoutPlace, withParams, withView } from '#lib/Workspace.ts';
	import type { Graph } from '#lib/Schema.ts';

	// The sidebar: the library on top and the examples that ship with the app below. Everything in it is a link that changes what
	// the page shows, so the page, its audio and its unsaved edits stay where they are. A timeline or an example opens in the
	// Song view, and a patch in the Patch view. It is narrow and short, so it fits a laptop's height with the examples shut:
	// what each list is for is behind a ? in its heading, and what makes a timeline, a patch or a bundle behind a +.
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
		shownPatch,
		usersOf,
		reveal = null
	}: {
		search: string; // The page's address now, which every link here changes a part of
		examples: { name: string; recipes: { name: string; listen_for: string }[] }[];
		timelines: { id: string; name: string }[];
		patches: { id: string; name: string; graph: Graph; builtin?: boolean; users: { id: string; name: string }[] }[];
		samples: {
			id: string;
			name: string;
			frames: number;
			rate: number;
			channels: number;
			patches: number;
			builtin?: boolean;
		}[];
		bundles: { id: string; name: string }[];
		dirty: Set<string>; // Draft keys of what is unsaved
		openTimeline: string | null;
		openRecipe: string | null;
		shownPatch: string | null;
		// The timelines a patch is used by with unsaved edits counted, which a patch's tooltip says. It is asked only of the
		// patch under the pointer, since an edit changes it, and the rest say what is saved.
		usersOf?: (id: string) => { name: string }[];
		reveal?: Section | null; // A list to open and scroll to as the browser opens, when its rail asked for one
	} = $props();

	let filter = $state('');
	let scroller: HTMLDivElement;
	let pointing = $state<string | null>(null); // The patch under the pointer

	const usedWords = (users: { name: string }[]) =>
		users.length ? `Used by ${users.map((u) => u.name).join(', ')}` : 'Not used by a timeline';

	// The list whose name field is open, from the + in its heading. It takes focus as it opens, Enter makes the thing, and Esc
	// or leaving it empty closes it.
	type Adding = 'timeline' | 'patch' | 'bundle';
	let adding = $state<Adding | null>(null);
	let field = $state<HTMLInputElement>();

	async function add(what: Adding, details: HTMLDetailsElement | null) {
		if (adding === what) {
			adding = null;
			return;
		}
		if (details) details.open = true;
		adding = what;
		await tick();
		field?.focus();
	}

	function fieldKey(event: KeyboardEvent, opener: string) {
		if (!pressed(event, 'escape')) return;
		event.preventDefault();
		adding = null;
		scroller.querySelector<HTMLButtonElement>(`[data-opens="${opener}"]`)?.focus();
	}

	// Once what was asked for is made the field goes. A name refused leaves it open to change.
	const made: SubmitFunction =
		() =>
		async ({ result, update }) => {
			await update();
			if (result.type !== 'failure' && result.type !== 'error') adding = null;
		};

	// What each list is for, which its ? shows, and which an empty list shows of itself.
	let about = $state<ReadonlySet<string>>(new Set());
	function toggleAbout(id: string) {
		const next = new Set(about);
		if (!next.delete(id)) next.add(id);
		about = next;
	}

	// Import is a button: it asks for WAV files, and sends them as they are chosen. The instrument is named after the first,
	// and its name can be changed where it opens.
	let files = $state<HTMLInputElement>();
	let importForm = $state<HTMLFormElement>();

	$effect(() => {
		const section = reveal;
		if (!section) return;
		untrack(() => {
			const at = scroller.querySelector<HTMLElement>(`[data-section="${section}"]`);
			if (at instanceof HTMLDetailsElement) at.open = true;
			at?.scrollIntoView({ block: 'start' });
		});
	});

	const matches = (name: string) => !filter.trim() || name.toLowerCase().includes(filter.trim().toLowerCase());

	// Another song has its own tracks and clips, so the place in this one stays behind. The song open goes back to where it is.
	const inSong = $derived(withView(withoutPlace(search), 'song'));
	const timelineHref = (id: string) =>
		withView(
			withParams(id === openTimeline ? search : withoutPlace(search), {
				timeline: id,
				recipe: null,
				patch: null,
				part: null
			}),
			'song'
		);
	const recipeHref = (name: string) =>
		withView(
			withParams(name === openRecipe ? search : withoutPlace(search), {
				recipe: name,
				timeline: null,
				patch: null,
				part: null
			}),
			'song'
		);
	const patchHref = (id: string) => withView(withParams(search, { patch: id, part: null }), 'patch');
	const bundleHref = (id: string) => withParams(search, { bundle: id });

	const shownTimelines = $derived(timelines.filter((t) => matches(t.name)));
	// The built-in patches are every example's, which every library has and nobody can change, so they sit apart from the
	// library's own. Their recordings are only theirs to use, so the samples list leaves them out.
	const ownPatches = $derived(patches.filter((p) => !p.builtin));
	const builtinPatches = $derived(patches.filter((p) => p.builtin));
	const ownSamples = $derived(samples.filter((s) => !s.builtin));
	const shownPatches = $derived(ownPatches.filter((p) => matches(p.name)));
	const shownBuiltins = $derived(builtinPatches.filter((p) => matches(p.name)));
	const shownSamples = $derived(ownSamples.filter((s) => matches(s.name)));
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

{#snippet patchLink(patch: (typeof patches)[number])}
	<li>
		<a
			href={patchHref(patch.id)}
			aria-current={patch.id === shownPatch ? 'true' : undefined}
			title={usedWords(pointing === patch.id && usersOf ? usersOf(patch.id) : patch.users)}
			onpointerenter={() => (pointing = patch.id)}
			onpointerleave={() => (pointing = null)}
		>
			{patch.name}{@render unsaved(draftKey('patch', patch.id))}
			{#if isInsert(patch.graph)}<span class="tag">insert</span>{/if}
		</a>
	</li>
{/snippet}

<!-- A list's ? says what it is for, and an empty list says so of itself. -->
{#snippet aboutButton(id: string, name: string, text: string)}
	<button
		type="button"
		class="tool"
		aria-label={`About ${name}`}
		aria-expanded={about.has(id)}
		aria-controls={`about-${id}`}
		title={text}
		onclick={() => toggleAbout(id)}>?</button
	>
{/snippet}

{#snippet aboutText(id: string, text: string, empty: boolean)}
	{#if empty || about.has(id)}<p class="muted note" id={`about-${id}`}>{text}</p>{/if}
{/snippet}

<!-- A + in a list's heading, which opens its name field. A press on it keeps focus in the field, so a second one closes it. -->
{#snippet adder(what: Adding)}
	<button
		type="button"
		class="tool"
		data-opens={what}
		aria-label={`New ${what}`}
		aria-expanded={adding === what}
		title={`Make a ${what}`}
		onmousedown={(event) => event.preventDefault()}
		onclick={(event) => void add(what, event.currentTarget.closest('details'))}>+</button
	>
{/snippet}

{#snippet nameField(what: Adding, action: string, back: string)}
	{#if adding === what}
		<form method="POST" action={actionOn(search, action)} use:enhance={made} class="add">
			<input type="hidden" name="back" value={back} />
			<input
				bind:this={field}
				name="name"
				placeholder="Name, then Enter"
				aria-label={`New ${what} name`}
				autocomplete="off"
				required
				onkeydown={(event) => fieldKey(event, what)}
				onblur={(event) => {
					if (!event.currentTarget.value.trim()) adding = null;
				}}
			/>
		</form>
	{/if}
{/snippet}

<nav class="browser" aria-label="Browser">
	<input class="filter" type="search" placeholder="Filter" aria-label="Filter the browser" bind:value={filter} />

	<div class="scroll" bind:this={scroller}>
		<h2>Library</h2>

		<details open data-section="timelines">
			<summary>Timelines <span class="count">{timelines.length}</span></summary>
			<div class="tools">{@render adder('timeline')}</div>
			{@render nameField('timeline', 'createTimeline', inSong)}
			<ul aria-label="Timelines">
				{#each shownTimelines as timeline (timeline.id)}
					<li>
						<a href={timelineHref(timeline.id)} aria-current={timeline.id === openTimeline ? 'page' : undefined}>
							{timeline.name}{@render unsaved(draftKey('timeline', timeline.id))}
						</a>
					</li>
				{/each}
			</ul>
		</details>

		<details open data-section="patches">
			<summary>Patches <span class="count">{ownPatches.length}</span></summary>
			<div class="tools">{@render adder('patch')}</div>
			{@render nameField('patch', 'createPatch', withView(search, 'patch'))}
			<ul aria-label="Patches">
				{#each shownPatches as patch (patch.id)}{@render patchLink(patch)}{/each}
			</ul>
		</details>

		<details open data-section="samples">
			<summary>Samples <span class="count">{ownSamples.length}</span></summary>
			<div class="tools">
				{#if ownSamples.length}{@render aboutButton('samples', 'samples', SAMPLES)}{/if}
				<button
					type="button"
					class="tool"
					aria-label="Import samples"
					title="Import WAV files as one instrument"
					onclick={() => files?.click()}>+</button
				>
			</div>
			{@render aboutText('samples', SAMPLES, !ownSamples.length)}
			<form
				method="POST"
				action={actionOn(search, 'importSamples')}
				enctype="multipart/form-data"
				use:enhance
				bind:this={importForm}
			>
				<input type="hidden" name="back" value={withView(search, 'patch')} />
				<input
					bind:this={files}
					class="unseen"
					type="file"
					name="files"
					accept=".wav,audio/wav"
					multiple
					tabindex="-1"
					aria-label="WAV files"
					onchange={(event) => event.currentTarget.files?.length && importForm?.requestSubmit()}
				/>
			</form>
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
		</details>

		<details
			open={filter.trim() !== '' || builtinPatches.some((p) => p.id === shownPatch) || undefined}
			data-testid="builtins"
			data-section="builtins"
		>
			<summary>Built-in patches <span class="count">{builtinPatches.length}</span></summary>
			<div class="tools">{@render aboutButton('builtins', 'built-in patches', BUILTINS)}</div>
			{@render aboutText('builtins', BUILTINS, false)}
			<ul aria-label="Built-in patches">
				{#each shownBuiltins as patch (patch.id)}{@render patchLink(patch)}{/each}
			</ul>
		</details>

		<details open data-section="bundles">
			<summary>Bundles <span class="count">{bundles.length}</span></summary>
			<div class="tools">
				{#if bundles.length}{@render aboutButton('bundles', 'bundles', BUNDLES)}{/if}
				{@render adder('bundle')}
			</div>
			{@render aboutText('bundles', BUNDLES, !bundles.length)}
			{@render nameField('bundle', 'createBundle', search)}
			<ul aria-label="Bundles">
				{#each shownBundles as bundle (bundle.id)}
					<li><a href={bundleHref(bundle.id)}>{bundle.name}</a></li>
				{/each}
			</ul>
		</details>

		<h2 data-section="examples">
			Examples {@render aboutButton('examples', 'examples', EXAMPLES)}
		</h2>
		{@render aboutText('examples', EXAMPLES, false)}
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
		position: relative;
		margin-bottom: 0.3rem;
	}
	summary {
		cursor: pointer;
		padding: 0.2rem 3rem 0.2rem 0;
		font-weight: 600;
	}
	/* A list's ? and +, at the right of its heading. They are the list's, so they come after its name, and go with it when it
	   is shut. */
	.tools {
		position: absolute;
		top: 0;
		right: 0;
		display: flex;
		gap: 0.1rem;
	}
	.tool {
		width: 20px;
		height: 20px;
		padding: 0;
		border-color: transparent;
		background: transparent;
		color: var(--muted);
		font-size: 0.8rem;
		line-height: 1;
	}
	.tool:hover,
	.tool[aria-expanded='true'] {
		color: var(--text);
	}
	h2 .tool {
		width: 18px;
		height: 18px;
		margin-left: 0.2rem;
		font-size: 0.72rem;
		vertical-align: middle;
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
		margin: 0.1rem 0 0.2rem 0.8rem;
	}
	.add input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.15rem 0.4rem;
		font-size: 0.78rem;
	}
	/* The file field Import opens, out of sight. */
	.unseen {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		opacity: 0;
	}
	.note {
		font-size: 0.72rem;
		margin: 0.1rem 0 0.3rem 0.8rem;
	}
</style>
