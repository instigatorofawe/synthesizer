<script lang="ts">
	import type { SongControls, TapTarget } from '#lib/AudioEngine.ts';
	import { rangeEscape } from '#lib/Drag.ts';
	import { GM } from '#lib/GeneralMidi.ts';
	import ParamSlider from '#lib/ParamSlider.svelte';
	import { bringing } from '#lib/PatchDrag.svelte.ts';
	import { TECHNIQUES } from '#lib/PatchGroups.ts';
	import { unitOf } from '#lib/ParamValues.ts';
	import type { ProgramReport } from '#lib/Request.ts';
	import type { Param, Timeline } from '#lib/Schema.ts';
	import Scope from '#lib/Scope.svelte';
	import ScopePlaceholder from '#lib/ScopePlaceholder.svelte';
	import type { Ring } from '#lib/ScopeMath.ts';
	import {
		addBus,
		decibels,
		addInsert,
		addSlot,
		addSend,
		busKey,
		faderGain,
		faderPosition,
		MASTER,
		mixWrites,
		moveInsert,
		removeBus,
		removeInsert,
		removeSend,
		byOwner,
		setChain,
		setGlobal,
		setInsert,
		setInsertPatch,
		setSend,
		setSlot,
		setTrackParam,
		soloed,
		trackKey,
		type Bus,
		type Insert,
		type PatchLike,
		type Track
	} from '#lib/TimelineEdit.ts';

	let {
		doc,
		patches,
		program,
		targets,
		rings,
		engine,
		readonly = false,
		solo = new Set(),
		onchange,
		onopen = () => {},
		onsolo = () => {}
	}: {
		doc: Timeline;
		patches: PatchLike[];
		program: ProgramReport | null;
		targets: TapTarget[];
		rings: Ring[];
		engine: SongControls;
		readonly?: boolean;
		solo?: ReadonlySet<number>; // The tracks soloed, which every other track is muted for
		onchange: (doc: Timeline) => void;
		onopen?: (patch: string) => void; // Show an insert's patch in the patch editor
		onsolo?: (track: number) => void; // Solo a track, or stop soloing it
	} = $props();

	let newBus = $state('');

	// A patch dragged from the browser onto a strip: an insert joins the strip's effects, after those it has, and a patch that
	// plays notes plays on a track's strip, as one chosen by its head's ▾ does. Nothing changes an example.
	let dropping = $state<string | null>(null); // The strip a drop would go on
	function takes(event: DragEvent, track: Track | null) {
		const what = bringing(event);
		return !readonly && what?.kind === 'patch' && (what.patch.insert || track !== null) ? what.patch : null;
	}
	const dropOn = (key: string, track: Track | null = null) => ({
		ondragover: (event: DragEvent) => {
			if (!takes(event, track)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
			dropping = key;
		},
		ondragleave: (event: DragEvent) => {
			if (!(event.currentTarget as Element).contains(event.relatedTarget as Node | null)) dropping = null;
		},
		ondrop: (event: DragEvent) => {
			dropping = null;
			const patch = takes(event, track);
			if (!patch) return;
			event.preventDefault();
			if (patch.insert) onchange(addInsert(doc, key, patch.id));
			else if (track)
				onchange(track.slots.length ? setSlot(doc, track.id, 0, patch.id) : addSlot(doc, track.id, patch.id));
		}
	});

	const number = (event: Event) => Number((event.currentTarget as HTMLInputElement).value);

	const patchOf = (id: string) => patches.find((patch) => patch.id === id);
	const insertPatches = $derived(
		byOwner(patches.filter((patch) => patch.graph.nodes.some((node) => node.type === 'in')))
	);
	// The built-in ones as the patch picker has them: the standard set's effects by name, then the examples' own.
	const builtinInserts = $derived(
		[
			{
				label: 'Effects',
				patches: insertPatches.builtin
					.filter((patch) => patch.id.startsWith(GM.prefix))
					.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
			},
			{ label: TECHNIQUES, patches: insertPatches.builtin.filter((patch) => !patch.id.startsWith(GM.prefix)) }
		].filter((group) => group.patches.length)
	);
	const hasSidechain = (id: string) =>
		patchOf(id)?.graph.nodes.some((node) => node.type === 'in' && node.index === 1) ?? false;
	const chainNames = $derived([
		...doc.tracks.map((track) => ({ key: trackKey(track.id), name: track.name || `Track ${track.id}` })),
		...doc.buses.map((bus) => ({ key: busKey(bus.id), name: bus.id }))
	]);

	// The unit of what a parameter drives, in the first of these patches that declares it.
	function unitIn(ids: string[], param: Param): string {
		const graph = ids.map((id) => patchOf(id)?.graph).find((g) => g?.params.some((p) => p.id === param.id));
		return graph ? unitOf(graph, param.id) : '';
	}

	function trackParams(track: Track): Param[] {
		const seen = new Map<number, Param>();
		for (const slot of track.slots) {
			for (const param of patchOf(slot)?.graph.params ?? []) {
				if (param.scope === 'track' && !seen.has(param.id)) seen.set(param.id, param);
			}
		}
		return [...seen.values()];
	}

	const globals = $derived.by(() => {
		const seen = new Map<number, Param>();
		for (const track of doc.tracks) {
			for (const slot of track.slots) {
				for (const param of patchOf(slot)?.graph.params ?? []) {
					if (param.scope === 'global') seen.set(param.id, param);
				}
			}
		}
		return [...seen.values()];
	});

	// A control moves the mix registers as it is dragged and compiles when it is let go, so the sound follows the hand and the
	// document only takes the value that was settled on. Those registers hold what the document would, so the swap changes nothing.
	// A track that a solo keeps quiet stays quiet while its fader moves.
	function live(next: Timeline, key: string) {
		if (!program) return;
		for (const { register, value } of mixWrites(soloed(next, solo), program, key)) engine.setMix(register, value);
	}

	function liveParam(track: Track, param: Param, value: number) {
		const index = program?.tracks.find((t) => t.id === track.id)?.index;
		if (index !== undefined) engine.setParam(index, param.id, value);
	}

	function liveInsert(insert: Insert, param: Param, value: number) {
		const index = program?.inserts.find((known) => known.id === insert.id)?.index;
		if (index !== undefined) engine.setInsertParam(index, param.id, value);
	}

	// A global belongs to the Program, and reaches it through any track that plays a patch declaring it.
	function liveGlobal(param: Param, value: number) {
		const owner = doc.tracks.find((track) =>
			track.slots.some((slot) => patchOf(slot)?.graph.params.some((p) => p.id === param.id))
		);
		const index = program?.tracks.find((t) => t.id === owner?.id)?.index;
		if (index !== undefined) engine.setParam(index, param.id, value);
	}

	function addNamedBus() {
		const next = addBus(doc, newBus.trim());
		if (next !== doc) {
			newBus = '';
			onchange(next);
		}
	}

	function outputsFor(key: string) {
		return doc.buses.filter((bus) => busKey(bus.id) !== key);
	}

	function sendable(chain: Track | Bus, key: string) {
		return outputsFor(key).filter((bus) => !chain.sends.some((send) => send.bus === bus.id));
	}
</script>

{#snippet scope(key: string, label: string)}
	{@const target = targets.find((candidate) => candidate.chain === key)}
	{#if target}
		<Scope {label} ring={rings[target.slot]} compact />
	{:else}
		<ScopePlaceholder {label} message={program ? 'Not compiled, or no scope left' : 'No scope until audio starts'} />
	{/if}
{/snippet}

<!-- Its travel is cubic in gain, so it moves evenly through what is heard, and its value is still the gain. -->
{#snippet fader(key: string, label: string, gain: number)}
	{@const at = (event: Event) => Number(faderGain(number(event)).toPrecision(4))}
	<label class="fader">
		<span class="value">{decibels(gain)}</span>
		<input
			type="range"
			min="0"
			max={Math.max(1, faderPosition(gain))}
			step="0.001"
			value={faderPosition(gain)}
			aria-label={`Fader for ${label}`}
			aria-valuetext={decibels(gain)}
			oninput={(e) => live(setChain(doc, key, { gain: at(e) }), key)}
			onchange={(e) => onchange(setChain(doc, key, { gain: at(e) }))}
			use:rangeEscape={() => live(doc, key)}
		/>
	</label>
{/snippet}

{#snippet inserts(key: string, label: string, list: Insert[])}
	<h5>Inserts</h5>
	{#each list as insert, index (index)}
		{@const patch = patchOf(insert.patch)}
		<div class="insert">
			<select
				aria-label={`Insert ${index + 1} on ${label}`}
				value={insert.patch}
				onchange={(e) => onchange(setInsertPatch(doc, key, index, e.currentTarget.value))}
			>
				{@render choices()}
				{#if !patch}<option value={insert.patch}>{insert.patch}</option>{/if}
			</select>
			{#if !readonly}
				<div class="tools">
					<button
						type="button"
						aria-label={`Edit insert ${index + 1} on ${label}`}
						title="Show this patch above"
						onclick={() => onopen(insert.patch)}>Edit</button
					>
					<button
						type="button"
						aria-label={`Move insert ${index + 1} on ${label} up`}
						onclick={() => onchange(moveInsert(doc, key, index, -1))}>↑</button
					>
					<button
						type="button"
						aria-label={`Move insert ${index + 1} on ${label} down`}
						onclick={() => onchange(moveInsert(doc, key, index, 1))}>↓</button
					>
					<button
						type="button"
						aria-label={`Remove insert ${index + 1} on ${label}`}
						onclick={() => onchange(removeInsert(doc, key, index))}>×</button
					>
				</div>
			{/if}
			{#if hasSidechain(insert.patch)}
				<label class="line">
					key
					<select
						aria-label={`Sidechain of insert ${index + 1} on ${label}`}
						value={insert.key ?? ''}
						onchange={(e) => onchange(setInsert(doc, key, index, { key: e.currentTarget.value || undefined }))}
					>
						<option value="">none</option>
						{#each chainNames.filter((chain) => chain.key !== key) as chain (chain.key)}
							<option value={chain.key}>{chain.name}</option>
						{/each}
					</select>
				</label>
			{/if}
			{#each patch?.graph.params ?? [] as param (param.id)}
				<div class="line">
					<span>{param.name || `param ${param.id}`}</span>
					<ParamSlider
						{param}
						value={insert.params?.[String(param.id)] ?? param.default}
						unit={unitIn([insert.patch], param)}
						label={param.name || `param ${param.id}`}
						oninput={(value) => liveInsert(insert, param, value)}
						onchange={(value) =>
							onchange(setInsert(doc, key, index, { params: { ...insert.params, [String(param.id)]: value } }))}
					/>
				</div>
			{/each}
		</div>
	{/each}
	{#if !readonly && (insertPatches.own.length || insertPatches.builtin.length)}
		<select
			aria-label={`Add an insert to ${label}`}
			value=""
			onchange={(e) => {
				if (e.currentTarget.value) onchange(addInsert(doc, key, e.currentTarget.value));
				e.currentTarget.value = '';
			}}
		>
			<option value="">Add an insert…</option>
			{@render choices()}
		</select>
	{/if}
{/snippet}

{#snippet choices()}
	{#each insertPatches.own as candidate (candidate.id)}<option value={candidate.id}>{candidate.name}</option>{/each}
	{#each builtinInserts as group (group.label)}
		<optgroup label={group.label}>
			{#each group.patches as candidate (candidate.id)}<option value={candidate.id}>{candidate.name}</option>{/each}
		</optgroup>
	{/each}
{/snippet}

{#snippet routing(key: string, label: string, chain: Track | Bus)}
	<div class="line">
		<button
			type="button"
			aria-pressed={chain.mute}
			aria-label={`Mute ${label}`}
			onclick={() => {
				const next = setChain(doc, key, { mute: !chain.mute });
				live(next, key);
				onchange(next);
			}}>{chain.mute ? 'Muted' : 'Mute'}</button
		>
		<input
			class="grow"
			type="range"
			min="-1"
			max="1"
			step="0.01"
			value={chain.pan}
			aria-label={`Pan for ${label}`}
			oninput={(e) => live(setChain(doc, key, { pan: number(e) }), key)}
			onchange={(e) => onchange(setChain(doc, key, { pan: number(e) }))}
			use:rangeEscape={() => live(doc, key)}
		/>
	</div>
	<label class="line">
		out
		<select
			aria-label={`Output of ${label}`}
			value={chain.output}
			onchange={(e) => onchange(setChain(doc, key, { output: e.currentTarget.value }))}
		>
			<option value={MASTER}>master</option>
			{#each outputsFor(key) as bus (bus.id)}<option value={busKey(bus.id)}>{bus.id}</option>{/each}
		</select>
	</label>
	{#if chain.sends.length || sendable(chain, key).length}<h5>Sends</h5>{/if}
	{#each chain.sends as send, index (index)}
		<label class="line">
			<span>{send.bus}</span>
			<input
				class="grow"
				type="range"
				min="0"
				max={Math.max(1, send.gain)}
				step="0.01"
				value={send.gain}
				aria-label={`Send from ${label} to ${send.bus}`}
				oninput={(e) => live(setSend(doc, key, index, { gain: number(e) }), key)}
				onchange={(e) => onchange(setSend(doc, key, index, { gain: number(e) }))}
				use:rangeEscape={() => live(doc, key)}
			/>
			<button
				type="button"
				class="pre"
				aria-pressed={send.pre ?? false}
				aria-label={`Send from ${label} to ${send.bus} before the fader`}
				title="Pre-fader: the send takes this chain before its fader and pan"
				onclick={() => onchange(setSend(doc, key, index, { pre: send.pre ? undefined : true }))}>pre</button
			>
			{#if !readonly}
				<button
					type="button"
					aria-label={`Remove send from ${label} to ${send.bus}`}
					onclick={() => onchange(removeSend(doc, key, index))}>×</button
				>
			{/if}
		</label>
	{/each}
	{#if !readonly && sendable(chain, key).length}
		<select
			aria-label={`Add a send from ${label}`}
			value=""
			onchange={(e) => {
				if (e.currentTarget.value) onchange(addSend(doc, key, e.currentTarget.value));
				e.currentTarget.value = '';
			}}
		>
			<option value="">Add a send…</option>
			{#each sendable(chain, key) as bus (bus.id)}<option value={bus.id}>{bus.id}</option>{/each}
		</select>
	{/if}
{/snippet}

<!-- A drag let go of elsewhere, or given up, leaves no strip lit. -->
<svelte:window ondragend={() => (dropping = null)} ondrop={() => (dropping = null)} />

<div class="mixer" data-testid="mixer">
	{#each doc.tracks as track (track.id)}
		{@const key = trackKey(track.id)}
		{@const label = track.name || `Track ${track.id}`}
		<section class="strip" class:dropping={dropping === key} data-testid={`strip-${key}`} {...dropOn(key, track)}>
			<div class="title">
				<h4>{label}</h4>
				<!-- Outside the fieldset: a solo changes nothing saved, so an example can be soloed too. -->
				<button
					type="button"
					class="solo"
					aria-pressed={solo.has(track.id)}
					aria-label={`Solo ${label}`}
					title="Hear only the soloed tracks. A solo isn't saved."
					onclick={() => onsolo(track.id)}>Solo</button
				>
			</div>
			{@render scope(key, label)}
			<fieldset disabled={readonly}>
				{@render fader(key, label, track.gain)}
				{@render routing(key, label, track)}
				{@render inserts(key, label, track.inserts)}
				{#if trackParams(track).length}<h5>Parameters</h5>{/if}
				{#each trackParams(track) as param (param.id)}
					<div class="line">
						<span>{param.name || `param ${param.id}`}</span>
						<ParamSlider
							{param}
							value={track.params[String(param.id)] ?? param.default}
							unit={unitIn(track.slots, param)}
							label={param.name || `param ${param.id}`}
							oninput={(value) => liveParam(track, param, value)}
							onchange={(value) => onchange(setTrackParam(doc, track.id, param.id, value))}
						/>
					</div>
				{/each}
			</fieldset>
		</section>
	{/each}

	{#each doc.buses as bus (bus.id)}
		{@const key = busKey(bus.id)}
		<section class="strip bus" class:dropping={dropping === key} data-testid={`strip-${key}`} {...dropOn(key)}>
			<h4>{bus.id}</h4>
			{@render scope(key, bus.id)}
			<fieldset disabled={readonly}>
				{@render fader(key, bus.id, bus.gain)}
				{@render routing(key, bus.id, bus)}
				{@render inserts(key, bus.id, bus.inserts)}
				{#if !readonly}
					<button type="button" onclick={() => onchange(removeBus(doc, bus.id))}>Delete bus</button>
				{/if}
			</fieldset>
		</section>
	{/each}

	<section class="strip master" class:dropping={dropping === MASTER} data-testid="strip-master" {...dropOn(MASTER)}>
		<h4>Master</h4>
		{@render scope(MASTER, 'Master')}
		<fieldset disabled={readonly}>
			{@render fader(MASTER, 'Master', doc.master.gain)}
			{@render inserts(MASTER, 'Master', doc.master.inserts)}
			{#if globals.length}<h5>Globals</h5>{/if}
			{#each globals as param (param.id)}
				<div class="line">
					<span>{param.name || `param ${param.id}`}</span>
					<ParamSlider
						{param}
						value={doc.globals[String(param.id)] ?? param.default}
						unit={unitIn(
							doc.tracks.flatMap((track) => track.slots),
							param
						)}
						label={param.name || `param ${param.id}`}
						oninput={(value) => liveGlobal(param, value)}
						onchange={(value) => onchange(setGlobal(doc, param.id, value))}
					/>
				</div>
			{/each}
		</fieldset>
	</section>

	{#if !readonly}
		<form
			class="newbus"
			onsubmit={(e) => {
				e.preventDefault();
				addNamedBus();
			}}
		>
			<input bind:value={newBus} placeholder="New bus" aria-label="New bus name" />
			<button>Add bus</button>
		</form>
	{/if}
</div>

<style>
	.mixer {
		display: flex;
		gap: 0.5rem;
		overflow-x: auto;
		padding-bottom: 0.4rem;
		align-items: flex-start;
	}
	.strip.dropping {
		box-shadow: inset 0 0 0 2px var(--accent);
	}
	.strip {
		flex: none;
		width: 210px;
		box-sizing: border-box;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 0.4rem;
		font-size: 0.78rem;
	}
	.strip.bus {
		border-color: #1f6feb80;
	}
	.strip.master {
		border-color: #d2992280;
	}
	.title {
		display: flex;
		align-items: baseline;
		gap: 0.3rem;
	}
	.title h4 {
		flex: 1;
		min-width: 0;
	}
	.solo {
		flex: none;
		padding: 0 0.35rem;
		font-size: 0.72rem;
	}
	.solo[aria-pressed='true'] {
		background: #1f6feb;
		border-color: #1f6feb;
		color: #fff;
	}
	h4 {
		margin: 0 0 0.3rem;
		font-size: 0.85rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	h5 {
		margin: 0.5rem 0 0.15rem;
		font-size: 0.72rem;
		color: var(--muted);
		font-weight: 600;
	}
	fieldset {
		border: 0;
		margin: 0.3rem 0 0;
		padding: 0;
		min-width: 0;
	}
	.fader {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.3rem;
	}
	.fader input {
		flex: 1;
		min-width: 0;
	}
	.value {
		width: 3.8rem;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.line {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin-bottom: 0.2rem;
	}
	.line > span {
		flex: 0 0 4.2rem;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--muted);
	}
	.line input[type='range'] {
		flex: 1;
		min-width: 0;
	}
	.line select {
		flex: 1;
		min-width: 0;
	}
	button,
	select {
		padding: 0.1rem 0.3rem;
		font-size: 0.75rem;
		max-width: 100%;
	}
	.insert {
		border-left: 2px solid var(--line);
		padding-left: 0.3rem;
		margin-bottom: 0.3rem;
	}
	.insert > select {
		width: 100%;
	}
	.tools {
		display: flex;
		gap: 0.2rem;
		margin: 0.15rem 0;
	}
	.newbus {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		width: 120px;
	}
	.newbus input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.2rem 0.3rem;
		font-size: 0.78rem;
	}
</style>
