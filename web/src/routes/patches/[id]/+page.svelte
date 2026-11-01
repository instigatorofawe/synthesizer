<script lang="ts">
	import { enhance } from '$app/forms';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { AudioEngine, LOAD_ERRORS, type EngineState, type TapTarget } from '#lib/AudioEngine.ts';
	import { Compiler } from '#lib/Compiler.ts';
	import ReportPanel from '#lib/ReportPanel.svelte';
	import { buildRequest, type CompileReport } from '#lib/Request.ts';
	import type { Graph, Param } from '#lib/Schema.ts';
	import Scope from '#lib/Scope.svelte';
	import { Ring } from '#lib/ScopeMath.ts';

	let { data, form } = $props();

	// The editors hold a working copy of what was loaded, so later `data` must not overwrite unsaved edits.

	let name = $state(untrack(() => data.patch.name));
	let revision = $state(untrack(() => data.patch.revision));
	let text = $state(untrack(() => JSON.stringify(data.patch.graph, null, 1)));
	let report = $state<CompileReport | null>(null);
	let started = $state(false);
	let engineState = $state<EngineState | null>(null);
	let targets = $state<TapTarget[]>([]);
	let parseError = $state('');

	const engine = new AudioEngine();
	const rings = Array.from({ length: 8 }, () => new Ring(48000));
	let compiler: Compiler | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const params = $derived.by((): Param[] => {
		try {
			return (JSON.parse(text) as Graph).params ?? [];
		} catch {
			return [];
		}
	});
	const isInsert = $derived(text.includes('"type": "in"'));
	const keys = [60, 62, 64, 65, 67, 69, 71, 72];

	async function compile() {
		if (!compiler) return;
		let graph: Graph;
		try {
			graph = JSON.parse(text);
			parseError = '';
		} catch (e) {
			parseError = (e as Error).message;
			return;
		}
		// A track with no notes, kept alive by `live`, so the keys below can play it.
		const timeline = { tracks: [{ id: 1, name: name, voices: 8, slots: [data.patch.id] }] };
		const request = buildRequest(
			[{ id: data.patch.id, name, graph }],
			data.assets,
			[{ id: 'preview', name: 'Preview', timeline: timeline as never }],
			{ live: true }
		);
		const result = await compiler.compile(request);
		if (!result) return;
		report = result.report;
		if (result.report.ok && started) engine.load(result.image, result.report);
	}

	function edited() {
		clearTimeout(timer);
		timer = setTimeout(compile, 250);
	}

	async function start() {
		await engine.start();
		started = true;
		await compile();
	}

	onMount(() => {
		compiler = new Compiler();
		engine.onState = (s) => (engineState = s);
		engine.onTap = (slot, block) => rings[slot].push(block.samples, block.start);
		engine.onTargets = (t) => (targets = t);
		compile();
	});

	onDestroy(() => {
		clearTimeout(timer);
		compiler?.close();
		engine.close();
	});
</script>

<h1>{name}</h1>

{#if form?.message}<p class="problem">{form.message}</p>{/if}
{#if form?.saved}<p class="muted">Saved.</p>{/if}
{#if parseError}<p class="problem">{parseError}</p>{/if}
{#if report && !report.ok}
	{#each report.errors ?? [] as problem}
		<p class="problem" data-testid="compile-error"><code>{problem.where}</code> {problem.message}</p>
	{/each}
{/if}

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
		<input name="name" bind:value={name} aria-label="Patch name" />
		<input type="hidden" name="revision" value={revision} />
		<input type="hidden" name="graph" value={text} />
		<button>Save</button>
		<button formaction="?/delete" formnovalidate>Delete</button>
		<span class="grow"></span>
		{#if data.users.length}
			<span class="muted" data-testid="used-by">
				Saving changes {data.users.length} timeline{data.users.length === 1 ? '' : 's'}:
				{data.users.map((u) => u.name).join(', ')}
			</span>
		{/if}
	</div>
</form>

<h2>Preview</h2>
{#if !started}
	<button onclick={start} disabled={isInsert}>Start audio</button>
	{#if isInsert}<span class="muted">This patch has an in node, so it plays as an insert on a timeline.</span>{/if}
{:else}
	<div class="row">
		{#each keys as note}
			<button
				onpointerdown={() => engine.noteOn(0, note)}
				onpointerup={() => engine.noteOff(0, note)}
				onpointerleave={() => engine.noteOff(0, note)}>{note}</button
			>
		{/each}
		{#if engineState}
			<span class="muted">{engineState.voices} voices{LOAD_ERRORS[engineState.error] ? `, ${LOAD_ERRORS[engineState.error]}` : ''}</span>
		{/if}
	</div>
	{#each params as param}
		<label class="row">
			<span style="width: 8rem">{param.name || `param ${param.id}`}</span>
			<input
				class="grow"
				type="range"
				min={param.min}
				max={param.max}
				step={(param.max - param.min) / 500}
				value={param.default}
				oninput={(e) => engine.setParam(0, param.id, Number(e.currentTarget.value))}
			/>
		</label>
	{/each}
	<div class="scopes">
		{#each targets as target (target.slot)}
			<Scope label={target.label} ring={rings[target.slot]} />
		{/each}
	</div>
{/if}

<h2>Graph</h2>
<p class="muted">Milestone 3 replaces this with a graph editor. Edits compile as you type, and audio crossfades to them.</p>
<textarea rows="24" bind:value={text} oninput={edited} aria-label="Graph JSON" spellcheck="false"></textarea>

{#if report?.ok}<ReportPanel {report} />{/if}
