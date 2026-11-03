<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { untrack } from 'svelte';
	import type { Probe } from '#lib/AudioEngine.ts';
	import type { CatalogEntry, LibraryPatch } from '#lib/GraphEdit.ts';
	import GraphEditor from '#lib/GraphEditor.svelte';
	import type { NodesReport } from '#lib/Request.ts';
	import type { Graph, Param } from '#lib/Schema.ts';
	import Scope from '#lib/Scope.svelte';
	import type { Ring } from '#lib/ScopeMath.ts';
	import { actionOn, stay, withView, type Hearing } from '#lib/Workspace.ts';

	// The Patch view: one patch, drawn as a graph or shown as JSON, with scopes on what it makes. A trail back to the song
	// heads it, through the track the patch is heard on.
	let {
		patch,
		name,
		graph,
		text,
		readonly,
		builtin,
		duplicate,
		duplicating,
		example = null,
		dirty,
		users,
		parts,
		use,
		search,
		catalog,
		library,
		assets,
		nodes,
		failed,
		errors,
		probes,
		maxProbes,
		hearing,
		scopes,
		active,
		choose = null,
		song,
		onsong,
		onname,
		ongraph,
		ontext,
		onprobes,
		onparam,
		onpart
	}: {
		patch: { id: string } | null;
		name: string;
		graph: Graph | null; // What is drawn: the text if it parses, and otherwise what it last was
		text: string;
		readonly: boolean;
		builtin: boolean; // One of the library's built-in patches, which can't be changed
		duplicate: string | null; // The library patch Duplicate copies, which for an example's patch is its built-in one
		duplicating: SubmitFunction;
		example?: { name: string; inLibrary: boolean } | null; // The example whose copy in the library Edit a copy goes into
		dirty: boolean;
		users: { id: string; name: string }[]; // Timelines an edit changes, as they are now, unsaved edits included
		parts: { id: string; name: string }[]; // An example's patches, to choose between
		use: string; // What an example does with this patch
		search: string;
		catalog: CatalogEntry[];
		library: LibraryPatch[];
		assets: { id: string; name: string }[];
		nodes: NodesReport | undefined;
		failed: boolean;
		errors: Map<number, string>;
		probes: Probe[];
		maxProbes: number;
		hearing: Hearing;
		scopes: { slot: number; label: string; ring: Ring }[];
		active: boolean; // Whether this view is on screen, so keys are for it
		choose?: { node: number } | null; // A node to choose, from the compile light's link to a problem, which shows the graph
		song: string; // The open timeline's or example's name
		onsong: () => void; // Back to the Song view
		onname: (name: string) => void;
		ongraph: (graph: Graph) => void;
		ontext: (text: string, typing: boolean) => void; // Typing until the field is left, which undoes as one step
		onprobes: (probes: Probe[]) => void;
		onparam: (param: Param, value: number) => void;
		onpart: (id: string) => void;
	} = $props();

	let view = $state<'graph' | 'json'>('graph');

	// A node asked for is in the graph, so that is what shows.
	$effect(() => {
		if (choose) untrack(() => (view = 'graph'));
	});

	// A link, so it can open in another tab, that otherwise switches views without leaving the page.
	function backToSong(event: MouseEvent) {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		onsong();
	}

	const heard = $derived(
		hearing.kind === 'song'
			? `Keys play it on ${hearing.name}, in the song.`
			: hearing.kind === 'alone'
				? 'No track plays it, so keys play it on its own.'
				: hearing.why
	);
	const playable = $derived(hearing.kind !== 'none');
	const copyTitle = $derived.by(() => {
		if (!readonly) return 'Make a copy of this patch, as it is saved';
		if (!example)
			return 'Copy this patch into your library to change it. The song open plays the copy where it played this.';
		return example.inLibrary
			? `Copy this patch into your library's ${example.name}, in place of the original, to change it there`
			: `Add ${example.name} to your library, with a copy of this patch in place of the original, to change it there`;
	});
	const params = $derived(graph?.params ?? []);
</script>

<section class="patch" aria-label="Patch editor">
	<header>
		<nav class="trail" aria-label="Where this patch is heard">
			<a href={withView(search, 'song')} onclick={backToSong} title="Back to the song, as it was left">
				<span aria-hidden="true">♫</span>
				{song || 'Song'}
			</a>
			{#if patch}
				<span class="sep" aria-hidden="true">›</span>
				{#if hearing.kind === 'song'}
					<span class="track" title="The track that plays it, which keys play it on">{hearing.name}</span>
					<span class="sep" aria-hidden="true">›</span>
				{/if}
				<span aria-hidden="true" class="diamond">◆</span>
				{#if readonly}
					<strong class="title" aria-current="page">{name}</strong>
				{:else}
					<input class="name" aria-label="Patch name" value={name} oninput={(e) => onname(e.currentTarget.value)} />
				{/if}
			{/if}
		</nav>
		{#if patch}
			{#if dirty}<span class="dot" title="Unsaved changes">•</span>{/if}
			{#if parts.length > 1}
				<div class="parts" role="group" aria-label="Patches in this recipe">
					{#each parts as part (part.id)}
						<button type="button" aria-pressed={part.id === patch.id} onclick={() => onpart(part.id)}
							>{part.name}</button
						>
					{/each}
				</div>
			{/if}
			{#if builtin}<span class="tag" title="One of the examples' patches, which can't be changed">built in</span>{/if}
			{#if use}
				<span class="muted info" data-testid="patch-use">{use}</span>
			{:else if builtin}
				<span class="muted info" data-testid="used-by" title={users.map((u) => u.name).join(', ')}>
					{users.length
						? `Used by ${users.length} timeline${users.length === 1 ? '' : 's'}: ${users.map((u) => u.name).join(', ')}`
						: 'Not used by a timeline'}
				</span>
			{:else if users.length}
				<span class="muted info" data-testid="used-by" title={users.map((u) => u.name).join(', ')}>
					Saving changes {users.length} timeline{users.length === 1 ? '' : 's'}: {users.map((u) => u.name).join(', ')}
				</span>
			{/if}
			<span class="grow"></span>
			<div class="views" role="tablist" aria-label="Patch views">
				<button type="button" role="tab" aria-selected={view === 'graph'} onclick={() => (view = 'graph')}>Graph</button
				>
				<button type="button" role="tab" aria-selected={view === 'json'} onclick={() => (view = 'json')}>JSON</button>
			</div>
			<!-- A patch that can't be changed is changed by Edit a copy, which puts the copy where the original plays. -->
			{#if duplicate}
				<form
					method="POST"
					action={actionOn(search, readonly ? 'editCopy' : 'duplicatePatch')}
					use:enhance={duplicating}
				>
					<input type="hidden" name="id" value={duplicate} />
					{#if readonly && example}<input type="hidden" name="recipe" value={example.name} />{/if}
					<button class="duplicate" title={copyTitle}>{readonly ? 'Edit a copy' : 'Duplicate'}</button>
				</form>
			{/if}
			{#if !readonly}
				<form method="POST" action={actionOn(search, 'deletePatch')} use:enhance={stay}>
					<input type="hidden" name="id" value={patch.id} />
					<input type="hidden" name="back" value={withView(search, 'patch')} />
					<button class="delete">Delete patch</button>
				</form>
			{/if}
		{:else}
			<span class="muted">Choose a patch in the browser, or a track in the song, to see how it is made.</span>
		{/if}
	</header>

	{#if patch}
		<div class="body">
			{#if view === 'json'}
				<textarea
					aria-label="Graph JSON"
					spellcheck="false"
					{readonly}
					value={text}
					oninput={(e) => ontext(e.currentTarget.value, true)}
					onchange={(e) => ontext(e.currentTarget.value, false)}></textarea>
			{:else if graph}
				{#key patch.id}
					<GraphEditor
						{graph}
						self={patch.id}
						{catalog}
						{library}
						{assets}
						{nodes}
						{failed}
						{errors}
						{probes}
						{maxProbes}
						{readonly}
						{active}
						{choose}
						onchange={ongraph}
						{onprobes}
					>
						{#snippet side()}
							<p class="muted heard" data-testid="hearing" data-kind={hearing.kind}>{heard}</p>
							{#if hearing.kind === 'song' && !probes.length && !readonly}
								<p class="muted heard">Choose a node and probe an output to watch it inside a voice.</p>
							{/if}
							{#each scopes as scope (scope.slot)}
								<Scope label={scope.label} ring={scope.ring} compact />
							{/each}
							{#each probes.filter((probe) => !scopes.some((scope) => scope.label === probe.label)) as probe (probe.label)}
								<p class="muted waiting" data-testid="probe-waiting">
									<span>{probe.label}</span>
									{hearing.kind === 'none' ? "can't be watched here." : 'shows once the patch plays.'}
								</p>
							{/each}
							{#if params.length && playable}
								<h4>Controls</h4>
								{#each params as param (param.id)}
									<label class="control">
										<span>{param.name || `param ${param.id}`}</span>
										<input
											type="range"
											min={param.min}
											max={param.max}
											step={(param.max - param.min) / 500}
											value={param.default}
											aria-label={`Control ${param.name || param.id}`}
											oninput={(e) => onparam(param, Number(e.currentTarget.value))}
										/>
									</label>
								{/each}
							{/if}
						{/snippet}
					</GraphEditor>
				{/key}
			{/if}
		</div>
	{/if}
</section>

<style>
	.patch {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		padding: 0 0.6rem 0.4rem;
		box-sizing: border-box;
	}
	header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.4rem;
		min-width: 0;
		font-size: 0.82rem;
	}
	.trail {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
		flex: 0 1 auto;
	}
	.trail a,
	.track,
	.title {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.trail a {
		flex: 0 1 auto;
		max-width: 12rem;
		color: var(--accent);
		text-decoration: none;
	}
	.trail a:hover {
		text-decoration: underline;
	}
	.track {
		max-width: 10rem;
	}
	.sep,
	.diamond {
		color: var(--muted);
	}
	.name {
		width: 12rem;
		padding: 0.15rem 0.4rem;
		font-weight: 600;
	}
	.dot {
		color: #d29922;
	}
	.tag {
		font-size: 0.65rem;
		color: var(--muted);
		border: 1px solid var(--line);
		border-radius: 3px;
		padding: 0 0.2rem;
		white-space: nowrap;
	}
	.info {
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 0.75rem;
	}
	.parts {
		display: flex;
		gap: 0.2rem;
		flex-wrap: wrap;
	}
	.parts button,
	.views button,
	.duplicate,
	.delete {
		padding: 0.1rem 0.5rem;
		font-size: 0.78rem;
	}
	.parts button[aria-pressed='true'] {
		border-color: var(--accent);
		background: #1f6feb33;
	}
	.views {
		display: flex;
	}
	.views button {
		border-radius: 0;
	}
	.views button:first-child {
		border-radius: 5px 0 0 5px;
	}
	.views button:last-child {
		border-radius: 0 5px 5px 0;
		border-left: 0;
	}
	.views button[aria-selected='true'] {
		background: #1f6feb33;
		border-color: var(--accent);
	}
	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	textarea {
		flex: 1;
		min-height: 0;
		resize: none;
	}
	.heard {
		font-size: 0.75rem;
		margin: 0 0 0.4rem;
	}
	.waiting {
		font-size: 0.75rem;
		margin: 0.3rem 0;
		padding: 0.4rem;
		border: 1px dashed var(--line);
		border-radius: 6px;
	}
	.waiting span {
		color: var(--text);
	}
	.control {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin-bottom: 0.2rem;
	}
	.control span {
		flex: 0 0 5rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.75rem;
	}
	.control input {
		flex: 1;
		min-width: 0;
		width: auto;
	}
	h4 {
		margin: 0.6rem 0 0.2rem;
		font-size: 0.78rem;
		color: var(--muted);
	}
</style>
