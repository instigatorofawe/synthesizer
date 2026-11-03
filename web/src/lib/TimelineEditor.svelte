<script lang="ts">
	import { onMount, untrack, type Snippet } from 'svelte';
	import Arrangement, { type Selection } from '#lib/Arrangement.svelte';
	import type { SongControls, TapTarget } from '#lib/AudioEngine.ts';
	import type { Undoable } from '#lib/History.ts';
	import Mixer from '#lib/Mixer.svelte';
	import PianoRoll from '#lib/PianoRoll.svelte';
	import Splitter from '#lib/Splitter.svelte';
	import type { ProgramReport } from '#lib/Request.ts';
	import type { Timeline } from '#lib/Schema.ts';
	import type { Ring } from '#lib/ScopeMath.ts';
	import { matches } from '#lib/Shortcuts.ts';
	import {
		addClip,
		addPlayChange,
		addSlot,
		addTempo,
		addTrack,
		byOwner,
		barOf,
		grids,
		laneChoices,
		makeUnique,
		place,
		placementIndex,
		placeOfError,
		removeClip,
		removePlacement,
		removePlayChange,
		removeSlot,
		removeTempo,
		removeTrack,
		renameClip,
		setClip,
		setPlacement,
		setPlay,
		setPlayChange,
		setSlot,
		setTempo,
		tempoAt,
		setTrack,
		snapTick,
		songLength,
		windowOf,
		ticksPerBar,
		type Clip,
		type PatchLike
	} from '#lib/TimelineEdit.ts';

	let {
		doc,
		patches,
		program,
		errors,
		tick,
		playing = false,
		targets,
		rings,
		engine,
		history = null,
		readonly = false,
		active = true,
		tabs = [],
		heading,
		onchange,
		ontrack = () => {},
		onopen = () => {}
	}: {
		doc: Timeline;
		patches: PatchLike[];
		program: ProgramReport | null;
		errors: { where: string; message: string }[];
		tick: number;
		playing?: boolean; // Whether the song is playing, which the arrangement and the roll follow
		targets: TapTarget[];
		rings: Ring[];
		engine: SongControls;
		history?: Undoable | null; // The timeline's undo, which the page keeps while other things are open
		readonly?: boolean;
		active?: boolean; // Whether keys are for this editor, which they are while its view is on screen
		tabs?: { id: string; label: string; content: Snippet }[]; // More views of the document, after the notes and the mixer
		heading?: Snippet; // At the start of the toolbar
		onchange: (doc: Timeline) => void;
		ontrack?: (id: number | null, first: boolean) => void; // The chosen track, first as the editor opens and then as it changes
		onopen?: (patch: string) => void; // Someone asked to open a patch this timeline uses, in the Patch view
	} = $props();

	const MODES = ['poly', 'mono', 'legato'] as const;
	const PRIORITIES = ['last', 'high', 'low'] as const;

	function opening(): Selection {
		const first = doc.tracks.find((track) => track.placements.length);
		return first ? { track: first.id, placement: 0 } : { track: doc.tracks[0]?.id ?? null, placement: null };
	}

	let selection = $state<Selection>(untrack(opening));
	let clipId = $state<string | null>(
		untrack(() => doc.tracks.find((t) => t.id === selection.track)?.placements[selection.placement ?? -1]?.clip ?? null)
	);
	let grid = $state(untrack(() => grids(doc.ppq)[1].ticks));
	let barWidth = $state(96);
	let loop = $state<{ start: number; end: number } | null>(null);
	let looping = $state(false);
	let tab = $state('notes');
	let dragged = $state<number | null>(null); // The arrangement's height, once someone has dragged it
	// Until then it fits its tracks, up to a size that leaves room for the notes.
	const height = $derived(dragged ?? Math.min(270, 34 + Math.max(doc.tracks.length, 1) * 60 + 20));
	const canUndo = $derived(history?.canUndo ?? false);
	const canRedo = $derived(history?.canRedo ?? false);

	const track = $derived(doc.tracks.find((t) => t.id === selection.track));
	const placed = $derived(selection.placement === null ? undefined : track?.placements[selection.placement]);
	const clip = $derived(doc.clips.find((c) => c.id === clipId));
	// A clip can be placed on several tracks. What it moves and what it plays are worked out for the one it was opened from.
	const home = $derived(
		placed?.clip === clipId ? track : doc.tracks.find((t) => t.placements.some((p) => p.clip === clipId))
	);
	const reported = $derived(program?.tracks.find((t) => t.id === home?.id));
	const uses = $derived(doc.tracks.flatMap((t) => t.placements).filter((p) => p.clip === clipId).length);
	const voicePatches = $derived(
		byOwner(patches.filter((patch) => !patch.graph.nodes.some((node) => node.type === 'in')))
	);
	const choices = $derived(laneChoices(doc, home?.id ?? null, patches));
	const length = $derived(program?.length_ticks ?? songLength(doc));
	const badTracks = $derived(new Set(errors.flatMap((e) => placeOfError(e.where).track ?? [])));
	const badClips = $derived(new Set(errors.flatMap((e) => placeOfError(e.where).clip ?? [])));

	const playhead = $derived.by(() => {
		if (!clip || !placed || placed.clip !== clip.id) return null;
		const { start, length } = windowOf(doc, placed);
		const into = tick - placed.tick;
		return into >= 0 && length > 0 && into < length * placed.repeat ? start + (into % length) : null;
	});

	const number = (event: Event) => Number((event.currentTarget as HTMLInputElement).value);

	// The page records each edit in the timeline's history, which outlasts this editor, as opening another timeline ends it.
	function commit(next: Timeline) {
		if (next !== doc) onchange(next);
	}

	const undo = () => history?.undo();
	const redo = () => history?.redo();

	// The page shows the chosen track's patch, so it hears about every choice of track.
	let told = false;
	$effect(() => {
		const id = selection.track;
		untrack(() => {
			ontrack(id, !told);
			told = true;
		});
	});

	function select(next: Selection) {
		selection = next;
		if (next.placement === null) return;
		const chosen = doc.tracks.find((t) => t.id === next.track)?.placements[next.placement];
		if (chosen) clipId = chosen.clip;
		tab = 'notes';
	}

	function arranged(next: Timeline, moved?: Selection) {
		commit(next);
		if (moved) selection = moved;
	}

	function newTrack() {
		const added = addTrack(doc, (voicePatches.own[0] ?? voicePatches.builtin[0])?.id);
		commit(added.doc);
		selection = { track: added.id, placement: null };
	}

	function newClip(id: number, at: number) {
		const added = addClip(doc, ticksPerBar(doc));
		const next = place(added.doc, id, added.id, at);
		commit(next);
		selection = { track: id, placement: placementIndex(next, id, added.id, at) };
		clipId = added.id;
		tab = 'notes';
	}

	const HEIGHT_KEY = 'modsynth.arrangement';
	onMount(() => {
		const kept = Number(localStorage.getItem(HEIGHT_KEY));
		if (kept > 0) dragged = kept;
	});

	function resize(pixels: number) {
		dragged = Math.max(70, Math.min(900, height + pixels));
		localStorage.setItem(HEIGHT_KEY, String(dragged));
	}

	function unresize() {
		dragged = null;
		localStorage.removeItem(HEIGHT_KEY);
	}

	const ringOf = (id: number) => {
		const target = targets.find((t) => t.chain === `track:${id}`);
		return target ? rings[target.slot] : null;
	};

	function deletePlacement() {
		if (selection.track === null || selection.placement === null) return;
		commit(removePlacement(doc, selection.track, selection.placement));
		selection = { ...selection, placement: null };
	}

	function deleteTrack() {
		if (selection.track === null) return;
		commit(removeTrack(doc, selection.track));
		selection = { track: null, placement: null };
	}

	function deleteClip() {
		if (!clipId) return;
		commit(removeClip(doc, clipId));
		clipId = null;
		selection = { ...selection, placement: null };
	}

	function unique() {
		if (selection.track === null || selection.placement === null) return;
		const made = makeUnique(doc, selection.track, selection.placement);
		commit(made.doc);
		clipId = made.id;
	}

	function rename(name: string) {
		if (!clipId) return;
		const next = renameClip(doc, clipId, name.trim());
		if (next === doc) return;
		commit(next);
		clipId = name.trim();
	}

	const clipChanged = (next: Clip) => commit(setClip(doc, next.id, next));

	function audition(note: number, on: boolean) {
		if (reported?.index === undefined) return;
		if (on) engine.noteOn(reported.index, note);
		else engine.noteOff(reported.index, note);
	}

	function locate(at: number) {
		engine.locate(at);
	}

	function setLoop(start: number, end: number) {
		loop = end > start ? { start, end } : null;
		looping = loop !== null;
		engine.setLoop(start, end);
	}

	function toggleLoop() {
		looping = !looping;
		if (!looping) engine.setLoop(0, 0);
		else if (loop) engine.setLoop(loop.start, loop.end);
		else {
			loop = { start: 0, end: Math.max(length, ticksPerBar(doc)) };
			engine.setLoop(loop.start, loop.end);
		}
	}

	// A loop can be drawn before there is an engine to tell, and a new image can arrive in a new engine.
	$effect(() => {
		if (targets.length && looping && loop) engine.setLoop(loop.start, loop.end);
	});

	// Undo and Redo are the page's keys, since they act on whichever panel is in use.
	function keydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement;
		if (readonly || !active || target.closest('input, textarea, select')) return;
		const deleting = matches(event, 'arrangement.delete') || matches(event, 'arrangement.backspace');
		if (deleting && !target.closest('[data-testid="roll"]')) {
			if (selection.placement === null) return;
			event.preventDefault();
			deletePlacement();
		}
	}
</script>

<svelte:window onkeydown={keydown} />

<section class="timeline" aria-label="Timeline editor">
	<div class="toolbar">
		{@render heading?.()}
		{#if !readonly}
			<button type="button" onclick={newTrack}>Add track</button>
			<button type="button" onclick={undo} disabled={!canUndo}>Undo</button>
			<button type="button" onclick={redo} disabled={!canRedo}>Redo</button>
		{/if}
		<label>
			Snap
			<select aria-label="Snap" bind:value={grid}>
				{#each grids(doc.ppq) as choice (choice.label)}<option value={choice.ticks}>{choice.label}</option>{/each}
			</select>
		</label>
		<button type="button" onclick={() => (barWidth = Math.max(24, barWidth / 1.5))} aria-label="Zoom out">−</button>
		<button type="button" onclick={() => (barWidth = Math.min(800, barWidth * 1.5))} aria-label="Zoom in">+</button>
		<button type="button" onclick={toggleLoop} aria-pressed={looping}>Loop {looping ? 'on' : 'off'}</button>
		<span class="muted hint">
			Click the numbers to move the playhead, and drag under them for a loop.
			{#if !readonly}Double-click a row for a new clip. Drag a clip's right edge to repeat it, and hold alt to copy it.{/if}
		</span>
	</div>

	<div class="top" style:height="{height}px">
		<Arrangement
			{doc}
			{selection}
			{barWidth}
			{grid}
			{tick}
			{playing}
			loop={looping ? loop : null}
			{readonly}
			{badTracks}
			{badClips}
			meter={ringOf}
			onselect={select}
			onchange={arranged}
			onnew={newClip}
			onlocate={locate}
			onloop={setLoop}
		/>

		<aside class="inspector">
			<fieldset disabled={readonly}>
				<details>
					<summary>Tempo, {doc.tempo[0]?.bpm} BPM</summary>
					{#each doc.tempo as change, index (index)}
						<div class="line">
							<span class="muted">bar {barOf(change.tick, doc.ppq)}</span>
							<input
								type="number"
								min="1"
								max="1000"
								step="any"
								aria-label={`Tempo at bar ${barOf(change.tick, doc.ppq)}`}
								value={change.bpm}
								onchange={(e) => commit(setTempo(doc, index, { bpm: number(e) }))}
							/>
							{#if doc.tempo.some((t) => t.tick > change.tick)}
								<label class="ramp" title="Glide to the next change's tempo, instead of holding this one until it">
									<input
										type="checkbox"
										aria-label={`Ramp from bar ${barOf(change.tick, doc.ppq)}`}
										checked={change.ramp ?? false}
										onchange={(e) => commit(setTempo(doc, index, { ramp: e.currentTarget.checked }))}
									/>
									ramp
								</label>
							{/if}
							{#if index > 0 && !readonly}
								<button
									type="button"
									aria-label={`Remove tempo at bar ${barOf(change.tick, doc.ppq)}`}
									onclick={() => commit(removeTempo(doc, index))}>×</button
								>
							{/if}
						</div>
					{/each}
					{#if !readonly}
						<button
							type="button"
							onclick={() => {
								const at = snapTick(tick, ticksPerBar(doc));
								commit(addTempo(doc, at, Math.round(tempoAt(doc.tempo, at) * 100) / 100));
							}}
						>
							Add a change at the playhead
						</button>
					{/if}
				</details>

				{#if track}
					<h3>Track</h3>
					<label
						>name <input
							aria-label="Track name"
							value={track.name}
							onchange={(e) => commit(setTrack(doc, track.id, { name: e.currentTarget.value }))}
						/></label
					>
					<label
						>voices <input
							type="number"
							min="1"
							max="256"
							aria-label="Voices"
							value={track.voices}
							onchange={(e) => commit(setTrack(doc, track.id, { voices: number(e) }))}
						/></label
					>
					{@const held = program?.tracks.find((t) => t.id === track.id)?.notes_at_once}
					{@const short = program?.warnings?.find((w) => placeOfError(w.where).track === track.id)}
					{#if held !== undefined}
						<p class="muted" class:short data-testid="notes-at-once">
							Holds up to {held} at once{#if short && short.tick !== undefined}, so with {track.voices} the oldest are cut
								short from bar {barOf(short.tick, doc.ppq)}{/if}.
						</p>
					{/if}
					{#each track.slots as slot, index (index)}
						<div class="line">
							<select
								aria-label={`Patch slot ${index + 1}`}
								value={slot}
								onchange={(e) => commit(setSlot(doc, track.id, index, e.currentTarget.value))}
							>
								{@render voiceChoices()}
								{#if ![...voicePatches.own, ...voicePatches.builtin].some((patch) => patch.id === slot)}<option
										value={slot}>{slot}</option
									>{/if}
							</select>
							{#if !readonly}
								<button
									type="button"
									aria-label={`Open patch slot ${index + 1}`}
									title="Open this patch in the Patch view"
									onclick={() => onopen(slot)}>Open <span aria-hidden="true">◆</span></button
								>
								<button
									type="button"
									aria-label={`Remove patch slot ${index + 1}`}
									onclick={() => commit(removeSlot(doc, track.id, index))}>×</button
								>
							{/if}
						</div>
					{/each}
					{#if !readonly && (voicePatches.own.length || voicePatches.builtin.length)}
						<select
							aria-label="Add a patch slot"
							value=""
							onchange={(e) => {
								if (e.currentTarget.value) commit(addSlot(doc, track.id, e.currentTarget.value));
								e.currentTarget.value = '';
							}}
						>
							<option value="">Add a patch…</option>
							{@render voiceChoices()}
						</select>
					{/if}
					<label>
						mode
						<select
							aria-label="Play mode"
							value={track.play?.mode ?? 'poly'}
							onchange={(e) =>
								commit(setPlay(doc, track.id, { mode: e.currentTarget.value as (typeof MODES)[number] }))}
						>
							{#each MODES as mode (mode)}<option value={mode}>{mode}</option>{/each}
						</select>
					</label>
					{#if track.play && track.play.mode !== 'poly'}
						<label>
							priority
							<select
								aria-label="Note priority"
								value={track.play.priority}
								onchange={(e) =>
									commit(setPlay(doc, track.id, { priority: e.currentTarget.value as (typeof PRIORITIES)[number] }))}
							>
								{#each PRIORITIES as priority (priority)}<option value={priority}>{priority}</option>{/each}
							</select>
						</label>
					{/if}
					<label
						>glide <input
							type="number"
							min="0"
							max="60"
							step="any"
							aria-label="Glide seconds"
							value={track.play?.glide ?? 0}
							onchange={(e) => commit(setPlay(doc, track.id, { glide: number(e) }))}
						/></label
					>
					{#if track.play?.mode === 'legato'}
						<label title="A slurred note brings its velocity, over the glide or 5 ms">
							<input
								type="checkbox"
								aria-label="Slurs bring their velocity"
								checked={track.play.slur_velocity ?? false}
								onchange={(e) =>
									commit(setPlay(doc, track.id, { slur_velocity: e.currentTarget.checked || undefined }))}
							/>
							slurs bring velocity
						</label>
					{/if}
					<label title="What happens to a note whose voice a new one takes: cut off, or faded out over 2 ms">
						stolen voices
						<select
							aria-label="Stolen voices"
							value={track.steal ?? 'cut'}
							onchange={(e) =>
								commit(setTrack(doc, track.id, { steal: e.currentTarget.value === 'fade' ? 'fade' : undefined }))}
						>
							<option value="cut">cut</option>
							<option value="fade">fade</option>
						</select>
					</label>
					{#if !readonly}<button type="button" onclick={deleteTrack}>Delete track</button>{/if}
				{/if}

				{#if clip}
					<h3>Clip</h3>
					<label
						>name <input
							aria-label="Clip name"
							value={clip.id}
							onchange={(e) => rename(e.currentTarget.value)}
						/></label
					>
					<label
						>length <input
							type="number"
							min="1"
							aria-label="Clip length"
							value={clip.length}
							onchange={(e) => commit(setClip(doc, clip.id, { ...clip, length: number(e) }))}
						/></label
					>
					{#if placed && selection.track !== null && selection.placement !== null}
						{@const at = { track: selection.track, index: selection.placement }}
						<label>
							starts
							<input
								type="number"
								min="0"
								aria-label="Clip start"
								value={placed.tick}
								onchange={(e) => {
									const next = setPlacement(doc, at.track, at.index, { tick: number(e) });
									commit(next);
									selection = { track: at.track, placement: placementIndex(next, at.track, placed.clip, number(e)) };
								}}
							/>
						</label>
						<label
							>repeats <input
								type="number"
								min="1"
								aria-label="Repeats"
								value={placed.repeat}
								onchange={(e) => commit(setPlacement(doc, at.track, at.index, { repeat: number(e) }))}
							/></label
						>
						{@const window = windowOf(doc, placed)}
						<div class="placement" role="group" aria-label="What this placement plays">
							<label title="Plays the clip from this tick of it"
								>from <input
									type="number"
									min="0"
									max={clip.length - 1}
									aria-label="Window start"
									value={window.start}
									onchange={(e) =>
										commit(setPlacement(doc, at.track, at.index, { start: number(e), length: undefined }))}
								/></label
							>
							<label title="For this many ticks, each repeat"
								>for <input
									type="number"
									min="1"
									aria-label="Window length"
									value={window.length}
									onchange={(e) => commit(setPlacement(doc, at.track, at.index, { length: number(e) }))}
								/></label
							>
							<label
								>transpose <input
									type="number"
									min="-127"
									max="127"
									aria-label="Transpose"
									value={placed.transpose ?? 0}
									onchange={(e) => commit(setPlacement(doc, at.track, at.index, { transpose: number(e) }))}
								/></label
							>
							<label title="Multiplies every note's velocity"
								>velocity × <input
									type="number"
									min="0"
									max="4"
									step="0.05"
									aria-label="Velocity scale"
									value={placed.velocity ?? 1}
									onchange={(e) => commit(setPlacement(doc, at.track, at.index, { velocity: number(e) }))}
								/></label
							>
						</div>
					{/if}
					{#if uses > 1}<p class="muted" data-testid="clip-uses">
							Placed {uses} times. An edit changes all of them.
						</p>{/if}
					{#each clip.play as change, index (index)}
						<div class="change">
							<input
								type="number"
								min="0"
								aria-label={`Play change ${index + 1} tick`}
								value={change.tick}
								onchange={(e) => clipChanged(setPlayChange(clip, index, { tick: number(e) }))}
							/>
							<select
								aria-label={`Play change ${index + 1} mode`}
								value={change.mode}
								onchange={(e) =>
									clipChanged(setPlayChange(clip, index, { mode: e.currentTarget.value as (typeof MODES)[number] }))}
							>
								{#each MODES as mode (mode)}<option value={mode}>{mode}</option>{/each}
							</select>
							{#if !readonly}
								<button
									type="button"
									aria-label={`Remove play change ${index + 1}`}
									onclick={() => clipChanged(removePlayChange(clip, index))}>×</button
								>
							{/if}
						</div>
					{/each}
					{#if !readonly}
						<div class="tools">
							{#if uses > 1 && placed}<button type="button" onclick={unique}>Make unique</button>{/if}
							<button type="button" onclick={() => clipChanged(addPlayChange(clip, 0))}>Add play change</button>
							{#if placed}<button type="button" onclick={deletePlacement}>Remove from track</button>{/if}
							<button type="button" onclick={deleteClip}>Delete clip</button>
						</div>
					{/if}
				{/if}
			</fieldset>
		</aside>
	</div>

	<Splitter label="Resize the arrangement" onmove={resize} onreset={unresize} />

	<div class="detail">
		<div class="tabs" role="tablist" aria-label="Timeline views">
			<button type="button" role="tab" aria-selected={tab === 'notes'} onclick={() => (tab = 'notes')}>
				Notes{clip ? `: ${clip.id}` : ''}
			</button>
			<button type="button" role="tab" aria-selected={tab === 'mixer'} onclick={() => (tab = 'mixer')}>Mixer</button>
			{#each tabs as extra (extra.id)}
				<button type="button" role="tab" aria-selected={tab === extra.id} onclick={() => (tab = extra.id)}
					>{extra.label}</button
				>
			{/each}
		</div>
		<div class="pane" class:notes={tab === 'notes'} role="tabpanel">
			{#if tab === 'notes'}
				{#if clip}
					{#key clip.id}
						<PianoRoll
							{clip}
							ppq={doc.ppq}
							{grid}
							slots={home?.slots ?? []}
							{choices}
							{playhead}
							{playing}
							canAudition={reported !== undefined}
							{readonly}
							onchange={clipChanged}
							onaudition={audition}
						/>
					{/key}
					{#if !readonly && home && !reported}
						<p class="muted" data-testid="silent-track">
							{home.name || `Track ${home.id}`} has no notes in the image yet, so its keys are silent. An image holds only
							what plays.
						</p>
					{/if}
				{:else}
					<p class="muted empty">
						{readonly
							? 'Choose a clip in the arrangement to see its notes.'
							: 'Choose a clip in the arrangement to edit its notes, or double-click a row for a new one.'}
					</p>
				{/if}
			{:else if tab === 'mixer'}
				<Mixer {doc} {patches} {program} {targets} {rings} {engine} {readonly} onchange={commit} {onopen} />
			{:else}
				{@render tabs.find((extra) => extra.id === tab)?.content()}
			{/if}
		</div>
	</div>
</section>

{#snippet voiceChoices()}
	{#each voicePatches.own as patch (patch.id)}<option value={patch.id}>{patch.name}</option>{/each}
	{#if voicePatches.builtin.length}
		<optgroup label="Built in">
			{#each voicePatches.builtin as patch (patch.id)}<option value={patch.id}>{patch.name}</option>{/each}
		</optgroup>
	{/if}
{/snippet}

<style>
	.short {
		color: var(--warn, #e3b341);
	}
	.placement {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
	}
	.timeline {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.toolbar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		padding: 0.25rem 0;
		min-width: 0;
	}
	.toolbar button,
	.toolbar select {
		padding: 0.1rem 0.5rem;
	}
	.toolbar :global(button),
	.toolbar :global(label),
	.toolbar :global(form) {
		flex: none;
		white-space: nowrap;
	}
	.hint {
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 0.75rem;
	}
	.top {
		flex: none;
		max-height: calc(100% - 9rem);
		min-height: 70px;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 250px;
		gap: 0.5rem;
		padding-bottom: 0.4rem;
		box-sizing: border-box;
	}
	.inspector {
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 0.5rem;
		min-height: 0;
		overflow: auto;
		font-size: 0.8rem;
	}
	.detail {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.tabs {
		flex: none;
		display: flex;
		gap: 0.15rem;
		padding-top: 0.3rem;
		border-bottom: 1px solid var(--line);
	}
	.tabs button {
		border: 1px solid transparent;
		border-bottom: 0;
		border-radius: 5px 5px 0 0;
		padding: 0.15rem 0.7rem;
		font-size: 0.8rem;
		background: transparent;
		color: var(--muted);
	}
	.tabs button[aria-selected='true'] {
		background: var(--panel);
		border-color: var(--line);
		color: var(--text);
	}
	.pane {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding-top: 0.4rem;
	}
	.pane.notes {
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.empty {
		font-size: 0.85rem;
	}
	fieldset {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.inspector h3 {
		margin: 0.6rem 0 0.3rem;
		font-size: 0.85rem;
	}
	.inspector label,
	.line {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.3rem;
		margin-bottom: 0.2rem;
	}
	.inspector input,
	.inspector select {
		width: 8rem;
		min-width: 0;
		padding: 0.1rem 0.3rem;
		font-size: 0.78rem;
		box-sizing: border-box;
	}
	.inspector .line select {
		flex: 1;
	}
	.ramp {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		font-size: 0.75rem;
		color: var(--muted);
	}
	.inspector .ramp input {
		width: auto;
		margin: 0;
	}
	.inspector button {
		padding: 0.1rem 0.4rem;
		font-size: 0.75rem;
	}
	.change {
		display: flex;
		gap: 0.2rem;
		margin-bottom: 0.2rem;
	}
	.change input,
	.change select {
		width: auto;
		flex: 1;
	}
	.tools {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.3rem;
	}
	.inspector p {
		margin: 0.2rem 0;
		font-size: 0.75rem;
	}
</style>
