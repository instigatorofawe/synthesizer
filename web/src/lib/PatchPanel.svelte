<script lang="ts">
	import { enhance } from '$app/forms';
	import type { Probe } from '#lib/AudioEngine.ts';
	import type { CatalogEntry, LibraryPatch } from '#lib/GraphEdit.ts';
	import GraphEditor from '#lib/GraphEditor.svelte';
	import Keyboard from '#lib/Keyboard.svelte';
	import type { NodesReport } from '#lib/Request.ts';
	import type { Graph, Param } from '#lib/Schema.ts';
	import Scope from '#lib/Scope.svelte';
	import type { Ring } from '#lib/ScopeMath.ts';
	import { actionOn, stay, type Hearing } from '#lib/Workspace.ts';

	// The upper panel: one patch, drawn as a graph or shown as JSON, with keys to play it and scopes on what it makes.
	let {
		patch,
		name,
		graph,
		text,
		readonly,
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
		onname,
		ongraph,
		ontext,
		onprobes,
		onnote,
		onparam,
		onpart
	}: {
		patch: { id: string } | null;
		name: string;
		graph: Graph | null; // What is drawn: the text if it parses, and otherwise what it last was
		text: string;
		readonly: boolean;
		dirty: boolean;
		users: { id: string; name: string }[]; // Timelines a saved edit changes
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
		active: boolean;
		onname: (name: string) => void;
		ongraph: (graph: Graph) => void;
		ontext: (text: string) => void;
		onprobes: (probes: Probe[]) => void;
		onnote: (note: number, on: boolean) => void;
		onparam: (param: Param, value: number) => void;
		onpart: (id: string) => void;
	} = $props();

	let view = $state<'graph' | 'json'>('graph');

	const heard = $derived(
		hearing.kind === 'song'
			? `Keys play it on ${hearing.name}, in the song.`
			: hearing.kind === 'alone'
				? 'No track plays it, so keys play it on its own.'
				: hearing.why
	);
	const playable = $derived(hearing.kind !== 'none');
	const params = $derived(graph?.params ?? []);
</script>

<section class="patch" aria-label="Patch editor">
	<header>
		<span class="kind">Patch</span>
		{#if patch}
			{#if readonly}
				<strong class="title">{name}</strong>
			{:else}
				<input class="name" aria-label="Patch name" value={name} oninput={(e) => onname(e.currentTarget.value)} />
			{/if}
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
			{#if use}
				<span class="muted info" data-testid="patch-use">{use}</span>
			{:else if users.length}
				<span class="muted info" data-testid="used-by" title={users.map((u) => u.name).join(', ')}>
					Saving changes {users.length} timeline{users.length === 1 ? '' : 's'}: {users.map((u) => u.name).join(', ')}
				</span>
			{/if}
			<span class="grow"></span>
			<Keyboard disabled={!playable} {onnote} />
			<div class="views" role="tablist" aria-label="Patch views">
				<button type="button" role="tab" aria-selected={view === 'graph'} onclick={() => (view = 'graph')}>Graph</button
				>
				<button type="button" role="tab" aria-selected={view === 'json'} onclick={() => (view = 'json')}>JSON</button>
			</div>
			{#if !readonly}
				<form method="POST" action={actionOn(search, 'deletePatch')} use:enhance={stay}>
					<input type="hidden" name="id" value={patch.id} />
					<input type="hidden" name="back" value={search} />
					<button class="delete">Delete patch</button>
				</form>
			{/if}
		{:else}
			<span class="muted">Choose a patch in the browser, or a track below, to see how it is made.</span>
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
					oninput={(e) => ontext(e.currentTarget.value)}></textarea>
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
	.kind {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
	}
	.title {
		white-space: nowrap;
	}
	.name {
		width: 12rem;
		padding: 0.15rem 0.4rem;
		font-weight: 600;
	}
	.dot {
		color: #d29922;
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
