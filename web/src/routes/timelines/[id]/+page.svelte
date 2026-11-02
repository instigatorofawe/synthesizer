<script lang="ts">
	import { enhance } from '$app/forms';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { AudioEngine, LOAD_ERRORS, type EngineState, type TapTarget } from '#lib/AudioEngine.ts';
	import { Compiler } from '#lib/Compiler.ts';
	import { downloadImage } from '#lib/Download.ts';
	import ReportPanel from '#lib/ReportPanel.svelte';
	import { buildRequest, reachable, type ChainReport, type CompileReport } from '#lib/Request.ts';
	import { referencedPatches, timelineSchema, type Graph, type Param, type Timeline } from '#lib/Schema.ts';
	import Scope from '#lib/Scope.svelte';
	import { Ring } from '#lib/ScopeMath.ts';

	let { data, form } = $props();

	// The editors hold a working copy of what was loaded, so later `data` must not overwrite unsaved edits.

	let name = $state(untrack(() => data.timeline.name));
	let revision = $state(untrack(() => data.timeline.revision));
	let text = $state(untrack(() => JSON.stringify(data.timeline.doc, null, 1)));
	let report = $state<CompileReport | null>(null);
	let started = $state(false);
	let engineState = $state<EngineState | null>(null);
	let targets = $state<TapTarget[]>([]);
	let looping = $state(false);

	const engine = new AudioEngine();
	const rings = Array.from({ length: 8 }, () => new Ring(48000));
	let compiler: Compiler | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const program = $derived(report?.ok ? report.programs[0] : null);
	const length = $derived(program?.length_ticks ?? 0);

	// Parsed once per edit, so the template and handlers read it freely without touching state.
	const parsed = $derived.by((): { doc: Timeline | null; error: string } => {
		try {
			return { doc: JSON.parse(text), error: '' };
		} catch (e) {
			return { doc: null, error: (e as Error).message };
		}
	});

	function paramsFor(track: ChainReport): Param[] {
		const source = parsed.doc?.tracks.find((t) => t.id === track.id);
		const seen = new Map<number, Param>();
		for (const slot of source?.slots ?? []) {
			const graph = data.patches.find((p) => p.id === slot)?.graph as Graph | undefined;
			for (const param of graph?.params ?? []) {
				if (param.scope === 'track' && !seen.has(param.id)) seen.set(param.id, param);
			}
		}
		return [...seen.values()];
	}

	function paramValue(track: ChainReport, param: Param) {
		return parsed.doc?.tracks.find((t) => t.id === track.id)?.params?.[String(param.id)] ?? param.default;
	}

	function setGain(track: ChainReport, gain: number) {
		const source = parsed.doc?.tracks.find((t) => t.id === track.id);
		const route = track.mix.find((r) => r.to === (source?.output ?? 'master'));
		if (!route) return;
		const pan = source?.pan ?? 0;
		engine.setMix(route.left, gain * Math.sin(((1 - pan) * Math.PI) / 4));
		engine.setMix(route.right, gain * Math.sin(((1 + pan) * Math.PI) / 4));
	}

	async function compile() {
		if (!compiler) return;
		const timeline = parsed.doc;
		if (!timeline) return;
		// A document that doesn't fit the schema goes whole, so that the compiler is what says what's wrong with it.
		const checked = timelineSchema.safeParse(timeline);
		const reached = checked.success
			? reachable(referencedPatches(checked.data), data.patches, data.assets)
			: { patches: data.patches, assets: data.assets };
		const request = buildRequest(reached.patches, reached.assets, [{ id: data.timeline.id, name, timeline }]);
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

	function toggleLoop() {
		looping = !looping;
		engine.setLoop(0, looping ? length : 0);
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

	$effect(() => {
		if (form?.exported) downloadImage(form.exported.image, `${name}.msimg`);
	});
</script>

<h1>{name}</h1>

{#if form?.message}<p class="problem">{form.message}</p>{/if}
{#if form?.saved}<p class="muted">Saved.</p>{/if}
{#if parsed.error}<p class="problem">{parsed.error}</p>{/if}
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
		<input name="name" bind:value={name} aria-label="Timeline name" />
		<input type="hidden" name="revision" value={revision} />
		<input type="hidden" name="doc" value={text} />
		<button>Save</button>
		<button formaction="?/export">Export saved version</button>
		<button formaction="?/delete" formnovalidate>Delete</button>
	</div>
</form>

<h2>Transport</h2>
{#if !started}
	<button onclick={start}>Start audio</button>
{:else}
	<div class="row">
		<button onclick={() => engine.play()}>Play</button>
		<button onclick={() => engine.stop()}>Stop</button>
		<button onclick={toggleLoop} aria-pressed={looping}>Loop {looping ? 'on' : 'off'}</button>
		<input
			class="grow"
			type="range"
			min="0"
			max={Math.max(length, 1)}
			value={engineState?.tick ?? 0}
			onchange={(e) => engine.locate(Number(e.currentTarget.value))}
			aria-label="Position"
		/>
		{#if engineState}
			<span class="muted" data-testid="state">
				tick <span data-testid="tick">{engineState.tick}</span>,
				<span data-testid="voices">{engineState.voices}</span> voices, generation
				<span data-testid="generation">{engineState.generation}</span>
				{#if engineState.guardTrips}, {engineState.guardTrips} guard trips{/if}
				{#if LOAD_ERRORS[engineState.error]}, {LOAD_ERRORS[engineState.error]}{/if}
			</span>
		{/if}
	</div>

	{#if program}
		<div class="columns">
			{#each program.tracks as track (track.id)}
				<section>
					<h3>{track.name || `Track ${track.id}`}</h3>
					<label class="row">
						<span style="width: 6rem">gain</span>
						<input
							class="grow"
							type="range"
							min="0"
							max="1.5"
							step="0.01"
							value={parsed.doc?.tracks.find((t) => t.id === track.id)?.gain ?? 1}
							oninput={(e) => setGain(track, Number(e.currentTarget.value))}
						/>
					</label>
					{#each paramsFor(track) as param (param.id)}
						<label class="row">
							<span style="width: 6rem">{param.name || `param ${param.id}`}</span>
							<input
								class="grow"
								type="range"
								min={param.min}
								max={param.max}
								step={(param.max - param.min) / 500}
								value={paramValue(track, param)}
								oninput={(e) => engine.setParam(track.index ?? 0, param.id, Number(e.currentTarget.value))}
							/>
						</label>
					{/each}
				</section>
			{/each}
		</div>
	{/if}

	<h2>Scopes</h2>
	<div class="scopes">
		{#each targets as target (target.slot)}
			<Scope label={target.label} ring={rings[target.slot]} />
		{/each}
	</div>
{/if}

<h2>Document</h2>
<p class="muted">
	Milestone 4 replaces this with the timeline, piano roll and mixer. Edits compile as you type, and audio crossfades to
	them without stopping.
</p>
<textarea rows="24" bind:value={text} oninput={edited} aria-label="Timeline JSON" spellcheck="false"></textarea>

{#if report?.ok}<ReportPanel {report} />{/if}
