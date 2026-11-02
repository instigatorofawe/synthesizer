<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { AudioEngine, LOAD_ERRORS, type EngineState, type Probe, type TapTarget } from '#lib/AudioEngine.ts';
	import { Compiler, type Compiled } from '#lib/Compiler.ts';
	import GraphEditor from '#lib/GraphEditor.svelte';
	import ReportPanel from '#lib/ReportPanel.svelte';
	import Scope from '#lib/Scope.svelte';
	import { Ring } from '#lib/ScopeMath.ts';
	import { patchUses, type PatchUse } from '#lib/TimelineEdit.ts';
	import TimelineEditor from '#lib/TimelineEditor.svelte';

	let { data, form } = $props();

	let compiled = $state<Compiled | null>(null);
	let engineState = $state<EngineState | null>(null);
	let targets = $state<TapTarget[]>([]);
	let chosen = $state(0);
	let probes = $state<Probe[]>([]);

	const engine = new AudioEngine();
	const rings = Array.from({ length: 8 }, () => new Ring(48000));
	const NO_ERRORS = new Map<number, string>();
	let compiler: Compiler | undefined;
	let loaded = false;
	let waiting = false; // Play was pressed before the image was live, so the next state report starts it

	const patch = $derived(data.patches[chosen]);
	const uses = $derived(patchUses(data.timeline, patch.id));
	const program = $derived(compiled?.report.programs[0]);

	// A probe follows a voice, so it can only reach a patch a track plays.
	const voice = $derived.by(() => {
		const use = uses.find((candidate) => candidate.kind === 'voice');
		if (!use || use.kind !== 'voice') return null;
		const track = program?.tracks.find((t) => t.id === use.track.id)?.index;
		return track === undefined ? null : { track, slot: use.slot };
	});
	const maxProbes = $derived(voice ? Math.max(0, 8 - targets.filter((t) => t.chain).length) : 0);

	function usedAs(use: PatchUse) {
		if (use.kind === 'insert') return `an insert on ${use.chain}`;
		const slot = use.track.slots.length > 1 ? `, slot ${use.slot + 1}` : '';
		return `the voice of ${use.track.name || `track ${use.track.id}`}${slot}`;
	}

	function begin() {
		waiting = false;
		engine.locate(0);
		engine.play();
	}

	async function play() {
		if (!compiled?.report.ok) return;
		await engine.start();
		if (!loaded) {
			loaded = true;
			engine.load(compiled.image, compiled.report);
		}
		if (engine.state.generation !== 0) begin();
		else waiting = true;
	}

	function probesChanged(next: Probe[]) {
		probes = next;
		engine.setProbes(patch.id, next, voice ?? undefined);
	}

	function choose(index: number) {
		chosen = index;
		probesChanged([]);
	}

	onMount(async () => {
		compiler = new Compiler();
		engine.onState = (s) => {
			engineState = s;
			if (waiting && s.generation !== 0) begin();
		};
		engine.onTap = (slot, block) => rings[slot].push(block.samples, block.start);
		engine.onTargets = (t) => (targets = t);
		compiled = await compiler.compile(JSON.stringify(data.project));
	});

	onDestroy(() => {
		compiler?.close();
		engine.close();
	});
</script>

<h1>{data.entry.name}</h1>
<p>{data.entry.listen_for}</p>

{#if form?.message}<p class="problem">{form.message}</p>{/if}
{#each compiled?.report.errors ?? [] as problem}
	<p class="problem" data-testid="compile-error"><code>{problem.where}</code> {problem.message}</p>
{/each}

<div class="row">
	<button onclick={play} disabled={!compiled?.report.ok}>Play</button>
	<button onclick={() => engine.stop()}>Stop</button>
	{#if data.inLibrary}
		<a href="/timelines/{data.inLibrary}">Open in the library</a>
	{:else}
		<form method="POST" action="?/add">
			<button>Add to library</button>
		</form>
	{/if}
	<a href="/recipes">All recipes</a>
	{#if engineState}
		<span class="muted" data-testid="voices">{engineState.voices}</span>
		<span class="muted">voices{LOAD_ERRORS[engineState.error] ? `, ${LOAD_ERRORS[engineState.error]}` : ''}</span>
	{/if}
</div>

<h2>Timeline</h2>
<TimelineEditor
	doc={data.timeline}
	patches={data.patches}
	program={program ?? null}
	errors={[]}
	tick={engineState?.tick ?? 0}
	{targets}
	{rings}
	{engine}
	readonly
	onchange={() => {}}
/>

<h2>{data.patches.length === 1 ? 'Patch' : 'Patches'}</h2>
{#if data.patches.length > 1}
	<div class="row" role="group" aria-label="Patches in this recipe">
		{#each data.patches as candidate, index (candidate.id)}
			<button aria-pressed={index === chosen} onclick={() => choose(index)}>{candidate.name}</button>
		{/each}
	</div>
{/if}
<p class="muted" data-testid="patch-use">
	{patch.name} is {uses.length ? uses.map(usedAs).join(' and ') : 'not used by the timeline'}.
	{#if !voice && uses.length}Probes follow a voice, so an insert can't be probed.{/if}
</p>

<div class="scopes">
	{#each targets.filter((target) => !target.chain) as target (target.slot)}
		<Scope label={target.label} ring={rings[target.slot]} />
	{/each}
</div>

{#key patch.id}
	<GraphEditor
		graph={patch.graph}
		self={patch.id}
		catalog={data.catalog}
		library={data.patches}
		assets={data.assets}
		nodes={compiled?.report.sidecar?.[patch.id]}
		failed={compiled?.report.ok === false}
		errors={NO_ERRORS}
		{probes}
		{maxProbes}
		readonly
		onchange={() => {}}
		onprobes={probesChanged}
	/>
{/key}
<details>
	<summary>Patch as JSON</summary>
	<textarea rows="16" readonly value={JSON.stringify(patch.graph, null, 1)} aria-label="Graph JSON" spellcheck="false"></textarea>
</details>

{#if compiled?.report.ok}<ReportPanel report={compiled.report} />{/if}
