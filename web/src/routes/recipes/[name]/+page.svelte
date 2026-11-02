<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { AudioEngine, LOAD_ERRORS, type EngineState, type TapTarget } from '#lib/AudioEngine.ts';
	import { Compiler, type Compiled } from '#lib/Compiler.ts';
	import ReportPanel from '#lib/ReportPanel.svelte';
	import Scope from '#lib/Scope.svelte';
	import { Ring } from '#lib/ScopeMath.ts';

	let { data, form } = $props();

	let compiled = $state<Compiled | null>(null);
	let engineState = $state<EngineState | null>(null);
	let targets = $state<TapTarget[]>([]);

	const engine = new AudioEngine();
	const rings = Array.from({ length: 8 }, () => new Ring(48000));
	let compiler: Compiler | undefined;
	let loaded = false;
	let waiting = false; // Play was pressed before the image was live, so the next state report starts it

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
	{#if data.timeline}
		<a href="/timelines/{data.timeline}">Open in the library</a>
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

<div class="scopes">
	{#each targets as target (target.slot)}
		<Scope label={target.label} ring={rings[target.slot]} />
	{/each}
</div>

{#if compiled?.report.ok}<ReportPanel report={compiled.report} />{/if}
