<script lang="ts">
	import { enhance } from '$app/forms';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { AudioEngine, LOAD_ERRORS, type EngineState, type Probe, type TapTarget } from '#lib/AudioEngine.ts';
	import { Compiler } from '#lib/Compiler.ts';
	import { nodeOfError } from '#lib/GraphEdit.ts';
	import GraphEditor from '#lib/GraphEditor.svelte';
	import ReportPanel from '#lib/ReportPanel.svelte';
	import { buildRequest, reachable, type CompileReport, type NodesReport } from '#lib/Request.ts';
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
	let nodes = $state<NodesReport | undefined>(undefined); // From the last compile that worked
	let probes = $state<Probe[]>([]);

	const engine = new AudioEngine();
	const rings = Array.from({ length: 8 }, () => new Ring(48000));
	let compiler: Compiler | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const graph = $derived.by((): Graph | null => {
		try {
			const parsed = JSON.parse(text) as Graph;
			return Array.isArray(parsed.nodes) ? { ...parsed, params: parsed.params ?? [], edges: parsed.edges ?? [] } : null;
		} catch {
			return null;
		}
	});
	const params = $derived<Param[]>(graph?.params ?? []);
	const isInsert = $derived(graph?.nodes.some((node) => node.type === 'in') ?? false);
	const keys = [60, 62, 64, 65, 67, 69, 71, 72];
	const MAX_PROBES = 6; // Eight tap slots, less the master and this patch's track

	// An error with no node here stays in the list at the top. One with a node goes there too, and on the node.
	const errors = $derived.by(() => {
		const found = new Map<number, string>();
		for (const problem of report?.ok === false ? (report.errors ?? []) : []) {
			const node = nodeOfError(problem.where, data.patch.id);
			if (node !== null) found.set(node, problem.message);
		}
		return found;
	});

	async function compile() {
		if (!compiler) return;
		let parsed: Graph;
		try {
			parsed = JSON.parse(text);
			parseError = '';
		} catch (e) {
			parseError = (e as Error).message;
			return;
		}
		// A track with no notes, kept alive by `live`, so the keys below can play it.
		const timeline = { tracks: [{ id: 1, name: name, voices: 8, slots: [data.patch.id] }] };
		const library = data.library.map((patch) => (patch.id === data.patch.id ? { id: patch.id, name, graph: parsed } : patch));
		const reached = reachable([data.patch.id], library, data.assets);
		const request = buildRequest(
			reached.patches,
			reached.assets,
			[{ id: 'preview', name: 'Preview', timeline: timeline as never }],
			{ live: true }
		);
		const result = await compiler.compile(request);
		if (!result) return;
		report = result.report;
		if (result.report.ok) nodes = result.report.sidecar?.[data.patch.id];
		if (result.report.ok && started) engine.load(result.image, result.report);
	}

	function drawn(next: Graph) {
		text = JSON.stringify(next, null, 1);
		edited();
	}

	function probesChanged(next: Probe[]) {
		probes = next;
		engine.setProbes(data.patch.id, next);
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
		engine.onState = (s) => {
			engineState = s;
			// A shared LFO waits for the transport, and nothing else on this page starts it. A new engine, which an image of
			// another frame size needs, starts stopped, so this has to go on watching.
			if (s.generation !== 0 && !s.playing) engine.play();
		};
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
			<span class="muted" data-testid="engine" data-playing={engineState.playing}>{engineState.voices} voices{LOAD_ERRORS[engineState.error] ? `, ${LOAD_ERRORS[engineState.error]}` : ''}</span>
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
{#if graph}
	<GraphEditor
		{graph}
		self={data.patch.id}
		catalog={data.catalog}
		library={data.library}
		assets={data.assets}
		{nodes}
		failed={report?.ok === false}
		{errors}
		{probes}
		maxProbes={MAX_PROBES}
		onchange={drawn}
		onprobes={probesChanged}
	/>
{/if}
<details open={graph === null}>
	<summary>Graph as JSON</summary>
	<textarea rows="24" bind:value={text} oninput={edited} aria-label="Graph JSON" spellcheck="false"></textarea>
</details>

{#if report?.ok}<ReportPanel {report} />{/if}
