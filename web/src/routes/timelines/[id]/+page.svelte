<script lang="ts">
	import { enhance } from '$app/forms';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { AudioEngine, LOAD_ERRORS, type EngineState, type TapTarget } from '#lib/AudioEngine.ts';
	import { Compiler } from '#lib/Compiler.ts';
	import { downloadImage } from '#lib/Download.ts';
	import ReportPanel from '#lib/ReportPanel.svelte';
	import { buildRequest, reachable, type CompileReport } from '#lib/Request.ts';
	import { referencedPatches, timelineSchema, type Timeline } from '#lib/Schema.ts';
	import { Ring } from '#lib/ScopeMath.ts';
	import TimelineEditor from '#lib/TimelineEditor.svelte';

	let { data, form } = $props();

	// The editors hold a working copy of what was loaded, so later `data` must not overwrite unsaved edits.

	let name = $state(untrack(() => data.timeline.name));
	let revision = $state(untrack(() => data.timeline.revision));
	let text = $state(untrack(() => JSON.stringify(data.timeline.doc, null, 1)));
	let report = $state<CompileReport | null>(null);
	let started = $state(false);
	let engineState = $state<EngineState | null>(null);
	let targets = $state<TapTarget[]>([]);
	// What the editors draw, which is the text as long as that makes a document. Text that doesn't leaves the last drawing alone.
	let doc = $state.raw(untrack(() => timelineSchema.parse(data.timeline.doc)));

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

	function textEdited() {
		const checked = timelineSchema.safeParse(parsed.doc);
		if (checked.success) doc = checked.data;
		edited();
	}

	function drawn(next: Timeline) {
		doc = next;
		text = JSON.stringify(next, null, 1);
		edited();
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
{/if}

<h2>Timeline</h2>
<TimelineEditor
	{doc}
	patches={data.patches}
	{program}
	errors={report?.ok === false ? (report.errors ?? []) : []}
	tick={engineState?.tick ?? 0}
	{targets}
	{rings}
	{engine}
	onchange={drawn}
/>

<details>
	<summary>Timeline as JSON</summary>
	<p class="muted">Edits compile as you type, and audio crossfades to them without stopping.</p>
	<textarea rows="24" bind:value={text} oninput={textEdited} aria-label="Timeline JSON" spellcheck="false"></textarea>
</details>

{#if report?.ok}<ReportPanel {report} />{/if}
