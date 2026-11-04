<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { on } from 'svelte/events';
	import { SvelteSet } from 'svelte/reactivity';
	import { leavesFields } from '#lib/Fields.ts';
	import { baseAfter, belongsElsewhere, keyFor, noteForKey } from '#lib/KeyboardKeys.ts';
	import { label, matches, typingIn } from '#lib/Shortcuts.ts';
	import { clampVelocity } from '#lib/StepEntry.ts';
	import { isBlackKey, noteName } from '#lib/Units.ts';

	// Two octaves of keys in the top bar, for whichever view is on screen to play. Each key is a button named by its note,
	// and the computer keyboard plays them too: A to ' from the lowest C shown, with Z and X moving the keys an octave.
	// There is one set of keys on the page, so the page decides where a key is heard, and it listens on the window whichever
	// view is showing. Latch and the velocity they play at sit either side of them, and are the page's too: Latch changes only
	// what is heard, and the velocity is the one new notes are written at.
	let {
		low = 48,
		octaves = 2,
		disabled = false,
		writing = false,
		recording = false,
		where = '',
		onnote,
		hold = false,
		latched = new Set(),
		velocity = $bindable(100),
		onhold = () => {},
		onletgo = () => {},
		stripIn = null,
		sounds = null
	}: {
		low?: number;
		octaves?: number;
		disabled?: boolean;
		writing?: boolean; // Whether step entry writes what the keys play, which they play as they otherwise would
		recording?: boolean; // Whether a take is recording what they play
		where?: string; // Where the keys are heard, or why they can't be
		onnote: (note: number, on: boolean, at: number) => void; // `at` is when, on the page's clock, as a take needs
		hold?: boolean; // Whether a key let go keeps sounding
		latched?: ReadonlySet<number>; // The notes Latch keeps sounding, whose keys are up
		velocity?: number;
		onhold?: (on: boolean) => void;
		onletgo?: () => void; // Esc: let go of every note Latch keeps
		stripIn?: HTMLElement | null; // The Patch view's strip, which the keys are drawn into, wider and bigger, while it is open
		// Where the keys play a kit track: each key's sound, by name, as the roll names them. A key with none is dimmed.
		sounds?: ReadonlyMap<number, string> | null;
	} = $props();

	// What a key is called where it is named: its note, and on a kit track its sound.
	const named = (note: number) => (sounds ? `${noteName(note)}, ${sounds.get(note) ?? 'no sound'}` : noteName(note));

	// In the strip, the keys are bigger and as many octaves as fit, with those the computer keys play in the middle.
	let stripWidth = $state(0);
	$effect(() => {
		if (!stripIn) return;
		const watch = new ResizeObserver(() => (stripWidth = stripIn.clientWidth));
		watch.observe(stripIn);
		return () => watch.disconnect();
	});
	const WHITE = $derived(stripIn ? 24 : 14); // px
	const shownOctaves = $derived(
		stripIn ? Math.max(octaves, Math.min(7, Math.floor((stripWidth - 16) / (7 * WHITE)))) : octaves
	);

	let base = $state(untrack(() => low)); // `low` is where the keys start, and Z and X move them from there
	const start = $derived(
		Math.max(0, Math.min(127 - shownOctaves * 12, base - 12 * Math.floor((shownOctaves - octaves) / 2)))
	);
	const notes = $derived(Array.from({ length: shownOctaves * 12 + 1 }, (_, i) => start + i));
	const whites = $derived(notes.filter((note) => !isBlackKey(note)));
	const held = new SvelteSet<number>();
	const typed = new Map<string, number>(); // The note each key held down started, so moving the octave can't strand it

	// A black key sits over the line between the white keys either side of it.
	const left = (note: number) => whites.indexOf(note - 1) * WHITE + WHITE * (1 - 0.32);

	function press(note: number, at = performance.now()) {
		if (held.has(note)) return;
		held.add(note);
		onnote(note, true, at);
	}

	function release(note: number, at = performance.now()) {
		if (!held.delete(note)) return;
		onnote(note, false, at);
	}

	function keydown(event: KeyboardEvent) {
		if (disabled || belongsElsewhere(event)) return;
		const moved = baseAfter(event.code, base);
		const note = noteForKey(event.code, base);
		if (moved === null && note === null) return;
		event.preventDefault();
		if (event.repeat) return;
		if (moved !== null) {
			base = moved;
		} else if (note !== null && !typed.has(event.code)) {
			typed.set(event.code, note);
			press(note, event.timeStamp);
		}
	}

	function keyup(event: KeyboardEvent) {
		const note = typed.get(event.code);
		if (note === undefined) return;
		typed.delete(event.code);
		release(note, event.timeStamp);
	}

	// The keys are one stop for Tab, as a toolbar's buttons are: the key last moved to takes focus, and the arrows, Home and End
	// move between them. Enter plays the key with focus for as long as it is held.
	let stop = $state<number | null>(null);
	const tabbable = $derived(stop !== null && notes.includes(stop) ? stop : base);

	// Draws the keys into the strip while it is open, and back here once it closes.
	function drawnIn(element: HTMLElement, target: HTMLElement | null) {
		const home = element.parentElement!;
		const place = (to: HTMLElement | null) => (to ?? home).appendChild(element);
		place(target);
		return { update: place, destroy: () => element.remove() };
	}
	let keyboard: HTMLDivElement;
	const entered = new Set<number>(); // Keys Enter holds down

	function keyKeys(event: KeyboardEvent, note: number) {
		const at = notes.indexOf(note);
		let to: number;
		if (event.key === 'ArrowRight' || event.key === 'ArrowUp') to = Math.min(notes.length - 1, at + 1);
		else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') to = Math.max(0, at - 1);
		else if (event.key === 'Home') to = 0;
		else if (event.key === 'End') to = notes.length - 1;
		else if (event.key === 'Enter') {
			event.preventDefault();
			if (!event.repeat && !entered.has(note)) {
				entered.add(note);
				press(note, event.timeStamp);
			}
			return;
		} else return;
		event.preventDefault();
		event.stopPropagation(); // The arrows are the keys' here, not the roll's or the arrangement's
		stop = notes[to];
		keyboard.querySelectorAll<HTMLButtonElement>('.key')[to]?.focus();
	}

	function keyUp(event: KeyboardEvent, note: number) {
		if (event.key !== 'Enter' || !entered.delete(note)) return;
		release(note, event.timeStamp);
	}

	// A key let go while the page wasn't looking would otherwise hold its note for ever.
	function releaseAll() {
		typed.clear();
		entered.clear();
		for (const note of [...held]) release(note);
	}

	$effect(() => {
		if (disabled) releaseAll();
	});

	// Esc lets go of what Latch keeps, on its way to whatever else it closes or leaves, so it is heard first and goes on.
	onMount(() =>
		on(
			window,
			'keydown',
			(event: KeyboardEvent) => {
				if (latched.size && matches(event, 'escape') && !typingIn(event.target, event.key)) onletgo();
			},
			{ capture: true }
		)
	);
</script>

<svelte:window onkeydown={keydown} onkeyup={keyup} onblur={releaseAll} />

<button
	type="button"
	class="hold"
	aria-pressed={hold}
	data-held={latched.size}
	title={hold
		? `Latch: a key let go keeps sounding until it is played again. Turn Latch off, or press ${label('escape')}, to let go of them all.`
		: 'Latch: keep each note sounding after its key is let go, until it is played again or Latch is turned off'}
	onclick={() => onhold(!hold)}>Latch</button
>

<div class="keyshome">
	<div
		bind:this={keyboard}
		use:drawnIn={stripIn}
		class="keyboard"
		class:wide={!!stripIn}
		style:--white="{WHITE}px"
		class:writing
		class:recording
		style:width="{whites.length * WHITE}px"
		role="group"
		aria-label="Keys"
		title={`${writing ? 'Step entry: keys write notes at the cursor in the roll. ' : ''}${recording ? 'Recording: the take writes what the keys play. ' : ''}${where ? `${where} ` : ''}Play from the computer keyboard: A to ', with Z and X for an octave down or up. Tab reaches these keys, the arrows move along them, and Enter plays one.`}
	>
		{#each notes as note (note)}
			<button
				type="button"
				class="key"
				class:black={isBlackKey(note)}
				class:down={held.has(note)}
				class:latched={latched.has(note) && !held.has(note)}
				class:nosound={!!sounds && !sounds.has(note)}
				style:left="{isBlackKey(note) ? left(note) : whites.indexOf(note) * WHITE}px"
				aria-label={noteName(note)}
				aria-keyshortcuts={keyFor(note, base) || undefined}
				tabindex={note === tabbable ? 0 : -1}
				title={keyFor(note, base) ? `${named(note)} (${keyFor(note, base)})` : named(note)}
				{disabled}
				onpointerdown={(event) => press(note, event.timeStamp)}
				onpointerup={(event) => release(note, event.timeStamp)}
				onpointerleave={(event) => release(note, event.timeStamp)}
				onkeydown={(event) => keyKeys(event, note)}
				onkeyup={(event) => keyUp(event, note)}
				onfocus={() => (stop = note)}
				onblur={(event) => {
					if (entered.delete(note)) release(note, event.timeStamp);
				}}
			>
				{#if note % 12 === 0}<span>{noteName(note)}</span>{:else if stripIn && keyFor(note, base)}<span class="letter"
						>{keyFor(note, base)}</span
					>{/if}
			</button>
		{/each}
	</div>
</div>
<label
	class="velocity"
	use:leavesFields
	title={`How hard the keys play, and new notes are written, from 1 to 127. ${label('softer')} and ${label('louder')} step it by 10.`}
>
	<span>Vel</span>
	<input
		type="number"
		min="1"
		max="127"
		aria-label="Velocity of the keys"
		value={velocity}
		onchange={(e) => {
			velocity = clampVelocity(Number(e.currentTarget.value) || velocity);
			e.currentTarget.value = String(velocity);
		}}
	/>
</label>

<style>
	.keyboard {
		position: relative;
		height: 26px;
		flex: none;
		user-select: none;
	}
	/* Step entry is on, so what is played is written too. */
	.keyboard.writing {
		outline: 2px solid #3fb950;
		outline-offset: 1px;
		border-radius: 2px;
	}
	/* A take is recording what is played. */
	.keyboard.recording {
		outline: 2px solid #f85149;
		outline-offset: 1px;
		border-radius: 2px;
	}
	.keyshome {
		display: contents;
	}
	.key {
		position: absolute;
		top: 0;
		width: var(--white);
		height: 26px;
		padding: 0;
		border-radius: 0 0 3px 3px;
		border: 1px solid #30363d;
		background: #c9d1d9;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		touch-action: none;
	}
	.key span {
		font-size: 7px;
		color: #0d1117;
		pointer-events: none;
	}
	.key.black {
		width: calc(var(--white) * 0.64);
		height: 16px;
		background: #21262d;
		z-index: 1;
	}
	.key:active:not(:disabled),
	.key:hover:not(:disabled) {
		background: #79c0ff;
		border-color: #30363d;
	}
	.key.black:hover:not(:disabled) {
		background: #1f6feb;
	}
	.key.down:not(:disabled) {
		background: #79c0ff;
	}
	.key.black.down:not(:disabled) {
		background: #1f6feb;
	}
	.key:disabled {
		opacity: 0.5;
	}
	/* A key the kit track has no sound for. */
	.key.nosound:not(:disabled) {
		opacity: 0.45;
	}
	/* In the Patch view's strip: bigger keys, their notes' names and the computer keys that play them. */
	.keyboard.wide {
		height: 64px;
	}
	.wide .key {
		height: 64px;
		padding-bottom: 3px;
	}
	.wide .key.black {
		height: 40px;
	}
	.wide .key span {
		font-size: 10px;
	}
	.wide .key .letter {
		color: #57606a;
	}
	.wide .key.black .letter {
		color: #8b949e;
	}
	/* A note Latch keeps sounding after its key came up. */
	.key.latched:not(:disabled) {
		background: #56d364;
	}
	.key.black.latched:not(:disabled) {
		background: #2ea043;
	}
	.hold {
		padding: 0.1rem 0.3rem;
		font-size: 0.72rem;
	}
	.hold[aria-pressed='true'] {
		color: var(--text);
		background: #23863633;
		border-color: #3fb950;
	}
	/* Narrow, as the top bar has to fit 1280 px: three digits and no spinner, since ↑ and ↓ step it, and C and V by tens. */
	.velocity {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		font-size: 0.72rem;
		color: var(--muted);
	}
	.velocity input {
		width: 2.1rem;
		padding: 0.1rem 0.15rem;
		font-variant-numeric: tabular-nums;
		text-align: right;
		appearance: textfield;
	}
	.velocity input::-webkit-inner-spin-button,
	.velocity input::-webkit-outer-spin-button {
		appearance: none;
		margin: 0;
	}
</style>
