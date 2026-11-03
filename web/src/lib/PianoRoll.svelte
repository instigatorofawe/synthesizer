<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import AutomationLane from '#lib/AutomationLane.svelte';
	import ContextMenu, { type MenuItem } from '#lib/ContextMenu.svelte';
	import { followScroll } from '#lib/Follow.ts';
	import { isMod, onMac } from '#lib/Modifier.ts';
	import {
		addNote,
		addPoint,
		describeLane,
		duplicateNotes,
		growToHold,
		humanize,
		isBlackKey,
		lanesOf,
		moveNotes,
		noteName,
		noteValue,
		position,
		quantize,
		rampVelocities,
		removeLane,
		removeNotes,
		resizeNotes,
		scaleVelocities,
		setNotes,
		snapTick,
		ticksPerBar,
		type Clip,
		type LaneChoice,
		type Note
	} from '#lib/TimelineEdit.ts';

	let {
		clip,
		ppq,
		grid,
		slots,
		choices,
		playhead,
		playing = false,
		canAudition,
		readonly = false,
		draw = $bindable(),
		cangrow = () => true,
		onchange,
		onaudition,
		onundo = () => {}
	}: {
		clip: Clip;
		ppq: number;
		grid: number;
		slots: string[]; // The track's patches, for notes that choose one
		choices: LaneChoice[];
		playhead: number | null; // In ticks from the start of the clip
		playing?: boolean; // Whether the song is playing, which the roll follows while it plays this clip
		canAudition: boolean;
		readonly?: boolean;
		draw: number; // How long a clicked note is, in ticks. It follows the last note added, resized or chosen, as FL Studio's does.
		cangrow?: (length: number) => boolean; // Whether the clip can be this long without running into the clip after it
		onchange: (clip: Clip) => void;
		onaudition: (note: number, on: boolean) => void;
		onundo?: () => void; // The timeline's own undo, for the Undo beside "Clip is now 2 bars"
	} = $props();

	const KEY = 12;
	const KEYS = 48;
	const HEIGHT = 128 * KEY;
	const VELOCITY = 56;
	const EDGE = 6;
	const AUDITION_MS = 220;
	const PAST_BARS = 4; // Shown past the clip's end, so there is room to put a note that grows it
	const DRAG = 4; // Pixels a press moves before it is a drag rather than a click
	const NOTICE_MS = 6000;

	type Point = { x: number; y: number };
	type Gesture =
		// A copy moves `indices` of `base`, which holds the originals and the copies, so the originals stay where they were.
		| { kind: 'move'; anchor: number; from: Point; base: Clip; indices: Set<number>; copy: boolean; clip: Clip }
		| { kind: 'size'; anchor: number; from: Point; clip: Clip }
		| { kind: 'velocity'; clip: Clip; indices: Set<number>; lane: Element }
		| { kind: 'length'; clip: Clip }
		| { kind: 'band'; from: Point; at: Point }
		| { kind: 'draw'; from: Point; note: Note; drawn: boolean; clip: Clip };

	let roll: SVGSVGElement;
	let scroller: HTMLDivElement;
	let beatWidth = $state(64);
	let chosen = $state.raw(new Set<number>());
	let gesture = $state.raw<Gesture | null>(null);
	let ghost = $state.raw<{ tick: number; note: number } | null>(null); // The empty cell under the pointer
	let menu = $state.raw<{ x: number; y: number } | null>(null);
	let notice = $state<string | null>(null); // Said after a clip grows, with an Undo beside it
	let offer = $state.raw<{ note: Note; length: number } | null>(null); // A note that would have grown the clip into the next
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	let mod = $state('Ctrl'); // What the hint calls Mod, which only the browser knows

	const perTick = $derived(beatWidth / ppq);
	const bar = $derived(ticksPerBar({ ppq }));
	const shown = $derived(gesture && 'clip' in gesture ? gesture.clip : clip);
	const widthTicks = $derived(
		Math.max(shown.length + PAST_BARS * bar, ...shown.notes.map((n) => n.tick + n.dur + ppq))
	);
	const width = $derived(widthTicks * perTick);
	const beats = $derived(Math.ceil(widthTicks / ppq));
	const lanes = $derived(lanesOf(clip));
	const free = $derived(choices.filter((choice) => !lanes.some((lane) => lane.key === choice.key)));
	const one = $derived(chosen.size ? clip.notes[[...chosen][0]] : undefined);
	const heldKeys = new Set<number>();

	function canvas(event: { clientX: number; clientY: number }, element: Element = roll) {
		const box = element.getBoundingClientRect();
		return { x: event.clientX - box.left, y: event.clientY - box.top };
	}

	const rowOf = (note: number) => (127 - note) * KEY;
	const noteAt = (y: number) => Math.min(127, Math.max(0, 127 - Math.floor(y / KEY)));

	// The cell under the pointer, at the line of the grid before it, which is where a click puts a note.
	function cellAt(event: { clientX: number; clientY: number }) {
		const at = canvas(event);
		return { tick: Math.max(0, Math.floor(at.x / perTick / grid) * grid), note: noteAt(at.y) };
	}

	const describe = (note: Pick<Note, 'tick' | 'note' | 'dur'>) =>
		`${noteName(note.note)} · ${noteValue(note.dur, ppq)} · ${position(note.tick, ppq)}`;

	// What the ghost says: the note a click would add, or the one being drawn. Past the end it says what that does to the clip.
	const ghostLabel = $derived.by(() => {
		const note = gesture?.kind === 'draw' ? gesture.note : ghost && { ...ghost, dur: draw };
		if (!note) return null;
		const grown = growToHold(clip, note.tick, ppq);
		if (grown === clip) return describe(note);
		return `${describe(note)} · ${cangrow(grown.length) ? `makes the clip ${bars(grown.length)}` : 'past the end'}`;
	});

	const bars = (length: number) => `${length / bar} bar${length === bar ? '' : 's'}`;

	function pressNote(event: PointerEvent, index: number, kind: 'move' | 'size') {
		event.stopPropagation();
		roll.focus({ preventScroll: true });
		ghost = null;
		offer = null;
		// A right-click chooses the note for its menu, and Ctrl-click is a right-click on a Mac.
		const secondary = event.button !== 0 || (event.ctrlKey && onMac());
		if (event.shiftKey && !secondary) {
			const next = new Set(chosen);
			if (next.has(index)) next.delete(index);
			else next.add(index);
			chosen = next;
		} else if (!chosen.has(index)) {
			chosen = new Set([index]);
		}
		if (readonly || secondary) return;
		if (!event.shiftKey) draw = clip.notes[index].dur;
		const from = canvas(event);
		if (kind === 'move' && isMod(event)) {
			// The copies go on the end, and they are what moves.
			const order = [...chosen].sort((a, b) => a - b);
			const base = { ...clip, notes: [...clip.notes, ...order.map((i) => clip.notes[i])] };
			const indices = new Set(order.map((_, k) => clip.notes.length + k));
			const anchor = clip.notes.length + order.indexOf(index);
			gesture = { kind, anchor, from, base, indices, copy: true, clip: base };
		} else if (kind === 'move') {
			gesture = { kind, anchor: index, from, base: clip, indices: chosen, copy: false, clip };
		} else {
			gesture = { kind, anchor: index, from, clip };
		}
	}

	// A click on empty grid adds a note there, as long as the Draw length, and dragging before letting go sets its length.
	function pressGround(event: PointerEvent) {
		roll.focus({ preventScroll: true });
		offer = null;
		if (event.button !== 0 || (event.ctrlKey && onMac())) return;
		if (event.shiftKey) {
			gesture = { kind: 'band', from: canvas(event), at: canvas(event) };
			return;
		}
		if (readonly) {
			chosen = new Set();
			return;
		}
		const { tick, note } = cellAt(event);
		// A note already there is too short to hit, or the first click of a double-click put it there.
		const there = clip.notes.findIndex((n) => n.tick === tick && n.note === note);
		if (there >= 0) {
			chosen = new Set([there]);
			return;
		}
		const added = { tick, note, vel: 100, dur: draw };
		ghost = null;
		chosen = new Set([clip.notes.length]);
		gesture = { kind: 'draw', from: canvas(event), note: added, drawn: false, clip: addNote(clip, added) };
		audition(note);
	}

	// A double-click on empty grid adds a note too. Its first click almost always has, so this adds one only if it hasn't.
	function doubleGround(event: MouseEvent) {
		if (readonly) return;
		const { tick, note } = cellAt(event);
		if (clip.notes.some((n) => n.tick === tick && n.note === note)) return;
		place({ tick, note, vel: 100, dur: draw });
	}

	function tell(text: string) {
		clearTimeout(noticeTimer);
		grownText = null;
		notice = text;
		noticeTimer = setTimeout(() => (notice = null), NOTICE_MS);
	}

	// A note past the end grows the clip to the bar that holds it, unless that would run a placement of the clip into the
	// next one on its track. Then the note waits, with an offer to lengthen the clip anyway.
	function place(note: Note) {
		const grown = growToHold(clip, note.tick, ppq);
		if (grown !== clip && !cangrow(grown.length)) {
			chosen = new Set();
			offer = { note, length: grown.length };
			return;
		}
		draw = note.dur;
		chosen = new Set([clip.notes.length]);
		onchange(addNote(grown, note));
		if (grown !== clip) tell(`Clip is now ${bars(grown.length)}`);
	}

	function lengthen() {
		if (!offer) return;
		const { note, length } = offer;
		offer = null;
		draw = note.dur;
		chosen = new Set([clip.notes.length]);
		onchange(addNote({ ...clip, length: Math.max(clip.length, length) }, note));
		tell(`Clip is now ${bars(Math.max(clip.length, length))}`);
	}

	function undoGrowth() {
		clearTimeout(noticeTimer);
		notice = null;
		chosen = new Set();
		onundo();
	}

	onDestroy(() => clearTimeout(noticeTimer));

	// The notice is about the edit that grew the clip, and its Undo undoes the last edit. So the next change to the clip takes
	// the notice away, before its Undo can take back something else.
	let grownText: string | null = null;
	$effect(() => {
		const text = notice === null ? null : JSON.stringify(clip);
		untrack(() => {
			if (text === null) grownText = null;
			else if (grownText === null) grownText = text;
			else if (text !== grownText) notice = null;
		});
	});

	// The ghost follows the pointer over empty grid, from cell to cell.
	function hover(event: PointerEvent) {
		const empty = (event.target as Element).classList.contains('lane');
		const cell = readonly || gesture || menu || !empty ? null : cellAt(event);
		if (cell?.tick !== ghost?.tick || cell?.note !== ghost?.note) ghost = cell;
	}

	function audition(note: number) {
		if (!canAudition) return;
		onaudition(note, true);
		setTimeout(() => onaudition(note, false), AUDITION_MS);
	}

	function moved(g: Extract<Gesture, { kind: 'move' }>, at: Point): Clip {
		const anchor = g.base.notes[g.anchor];
		const wanted = snapTick(anchor.tick + (at.x - g.from.x) / perTick, grid) - anchor.tick;
		const last = Math.max(...[...g.indices].map((i) => g.base.notes[i].tick));
		const dt = Math.min(wanted, clip.length - 1 - last);
		return moveNotes(g.base, g.indices, dt, Math.round((g.from.y - at.y) / KEY));
	}

	// Whether a move has left every note where it was, which a click on a note does.
	const still = (g: Extract<Gesture, { kind: 'move' }>) =>
		[...g.indices].every(
			(i) => g.clip.notes[i].tick === g.base.notes[i].tick && g.clip.notes[i].note === g.base.notes[i].note
		);

	function resized(g: Extract<Gesture, { kind: 'size' }>, at: Point): Clip {
		const anchor = clip.notes[g.anchor];
		const end = snapTick(anchor.tick + anchor.dur + (at.x - g.from.x) / perTick, grid);
		return resizeNotes(clip, chosen, end - anchor.tick - anchor.dur, grid);
	}

	function pointerMove(event: PointerEvent) {
		if (!gesture) return;
		if (gesture.kind === 'move') gesture = { ...gesture, clip: moved(gesture, canvas(event)) };
		else if (gesture.kind === 'size') gesture = { ...gesture, clip: resized(gesture, canvas(event)) };
		else if (gesture.kind === 'band') gesture = { ...gesture, at: canvas(event) };
		else if (gesture.kind === 'draw') {
			const at = canvas(event);
			if (!gesture.drawn && Math.abs(at.x - gesture.from.x) < DRAG) return;
			// The note reaches the end of the cell under the pointer, so it covers what the pointer has crossed.
			const end = (Math.floor(at.x / perTick / grid) + 1) * grid;
			const note = { ...gesture.note, dur: Math.max(grid, end - gesture.note.tick) };
			gesture = { ...gesture, drawn: true, note, clip: addNote(clip, note) };
		} else if (gesture.kind === 'velocity') {
			const { indices, lane } = gesture;
			gesture = { ...gesture, clip: setNotes(clip, indices, { vel: velocityFor(event, lane) }) };
		} else if (gesture.kind === 'length') {
			const length = Math.max(grid, snapTick(canvas(event).x / perTick, grid));
			gesture = { ...gesture, clip: { ...clip, length } };
		}
	}

	function finishBand(from: Point, at: Point) {
		const [left, right] = [Math.min(from.x, at.x) / perTick, Math.max(from.x, at.x) / perTick];
		const [top, bottom] = [Math.min(from.y, at.y), Math.max(from.y, at.y)];
		const inside = new Set<number>();
		clip.notes.forEach((note, index) => {
			const y = rowOf(note.note);
			if (note.tick < right && note.tick + note.dur > left && y < bottom && y + KEY > top) inside.add(index);
		});
		chosen = inside;
	}

	function pointerUp() {
		for (const note of heldKeys) onaudition(note, false);
		heldKeys.clear();
		const held = gesture;
		gesture = null;
		if (!held) return;
		if (held.kind === 'band') return finishBand(held.from, held.at);
		if (held.kind === 'draw') return place(held.note);
		if (held.kind === 'move' && still(held)) return;
		if (held.clip === clip) return;
		if (held.kind === 'size') draw = held.clip.notes[held.anchor].dur;
		if (held.kind === 'move') chosen = held.indices;
		onchange(held.clip);
	}

	function velocityFor(event: PointerEvent, element: Element) {
		return Math.min(127, Math.max(1, Math.round((1 - canvas(event, element).y / VELOCITY) * 127)));
	}

	function pressVelocity(event: PointerEvent, index: number) {
		event.stopPropagation();
		if (readonly) return;
		const lane = (event.currentTarget as Element).closest('svg') as Element;
		const indices = chosen.has(index) ? chosen : new Set([index]);
		gesture = { kind: 'velocity', clip: setNotes(clip, indices, { vel: velocityFor(event, lane) }), indices, lane };
	}

	function nudge(ticks: number, notes: number) {
		if (chosen.size) onchange(moveNotes(clip, chosen, ticks, notes));
	}

	function keydown(event: KeyboardEvent) {
		if (readonly) return;
		const command = event.metaKey || event.ctrlKey;
		if (event.key === 'Delete' || event.key === 'Backspace') {
			event.preventDefault();
			const gone = chosen;
			chosen = new Set();
			if (gone.size) onchange(removeNotes(clip, gone));
		} else if (command && event.key === 'a') {
			event.preventDefault();
			chosen = new Set(clip.notes.keys());
		} else if (command && event.key === 'd') {
			event.preventDefault();
			const copied = duplicateNotes(clip, chosen);
			chosen = copied.chosen;
			onchange(copied.clip);
		} else if (event.key === 'Escape') {
			// The first Esc lets go of what is held or offered, and the next lets go of the notes.
			if (gesture?.kind === 'draw') chosen = new Set();
			if (gesture) gesture = null;
			else if (offer) offer = null;
			else chosen = new Set();
		} else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			event.preventDefault();
			nudge(0, (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 12 : 1));
		} else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			nudge((event.key === 'ArrowLeft' ? -1 : 1) * grid, 0);
		}
	}

	function noteMenu(event: MouseEvent, index: number) {
		event.preventDefault();
		event.stopPropagation();
		gesture = null;
		if (!chosen.has(index)) chosen = new Set([index]);
		if (!readonly) menu = { x: event.clientX, y: event.clientY };
	}

	// Shift+F10 or the menu key opens the chosen notes' menu, at the first of them.
	function rollMenu(event: MouseEvent) {
		event.preventDefault();
		gesture = null;
		if (readonly || event.target !== roll || !chosen.size) return;
		const first = roll.querySelector(`[data-testid="note-${Math.min(...chosen)}"] .body`);
		const box = (first ?? roll).getBoundingClientRect();
		menu = { x: box.left, y: box.bottom };
	}

	const noteItems = (): MenuItem[] => [
		{
			label: 'Delete',
			action: () => {
				const gone = chosen;
				chosen = new Set();
				onchange(removeNotes(clip, gone));
			}
		},
		{
			label: 'Duplicate',
			action: () => {
				const copied = duplicateNotes(clip, chosen);
				chosen = copied.chosen;
				onchange(copied.clip);
			}
		}
	];

	function pressKey(event: PointerEvent, note: number) {
		if (!canAudition) return;
		event.preventDefault();
		heldKeys.add(note);
		onaudition(note, true);
	}

	function field(name: 'tick' | 'note' | 'vel' | 'dur', text: string) {
		const value = Number(text);
		if (Number.isInteger(value) && chosen.size) onchange(setNotes(clip, chosen, { [name]: value }));
	}

	// What the shaping tools last used, which is where they start next time.
	let rampFrom = $state(40);
	let rampTo = $state(110);
	let scaleBy = $state(0.8);
	let nudges = $state(0);

	function shape(next: Clip) {
		if (chosen.size && next !== clip) onchange(next);
	}

	function slotChanged(text: string) {
		const next = setNotes(clip, chosen, { slot: text === '' ? undefined : Number(text) });
		onchange({
			...next,
			notes: next.notes.map(({ slot, ...note }) => (slot === undefined ? note : { ...note, slot }))
		});
	}

	function addLane(key: string) {
		const choice = free.find((candidate) => candidate.key === key);
		if (choice) onchange(addPoint(clip, choice, 0, choice.start));
	}

	// The roll scrolls both ways, and everything below it follows it across.
	const followers = new Set<HTMLElement>();
	function follows(element: HTMLElement) {
		followers.add(element);
		element.scrollLeft = scroller?.scrollLeft ?? 0;
		return { destroy: () => followers.delete(element) };
	}
	function scrolled() {
		for (const element of followers) element.scrollLeft = scroller.scrollLeft;
	}

	// While the song plays this clip, the roll keeps the playhead in sight, as the arrangement does.
	let followed: number | null = null;
	$effect(() => {
		const at = playhead === null ? null : playhead * perTick;
		if (!playing || at === null) {
			followed = null;
			return;
		}
		const to = followScroll(at, followed, scroller.scrollLeft, scroller.clientWidth - KEYS);
		if (to !== null) scroller.scrollLeft = to;
		followed = at;
	});

	onMount(() => {
		mod = onMac() ? '⌘' : 'Ctrl';
		// A whole clip if it fits, up to a size where a short one doesn't turn into a few very long notes.
		beatWidth = Math.min(96, Math.max(16, (scroller.clientWidth - KEYS) / (clip.length / ppq + 1)));
		const pitches = clip.notes.map((note) => note.note);
		const middle = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60;
		scroller.scrollTop = rowOf(middle) - scroller.clientHeight / 2;
	});
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} />

<div class="toolbar">
	<button type="button" onclick={() => (beatWidth = Math.max(16, beatWidth / 1.5))} aria-label="Zoom the roll out"
		>−</button
	>
	<button type="button" onclick={() => (beatWidth = Math.min(400, beatWidth * 1.5))} aria-label="Zoom the roll in"
		>+</button
	>
	{#if one}
		<fieldset disabled={readonly}>
			<span class="muted">{chosen.size === 1 ? noteName(one.note) : `${chosen.size} notes`}</span>
			{#if chosen.size === 1}
				<label
					>tick <input
						type="number"
						min="0"
						aria-label="Note tick"
						value={one.tick}
						onchange={(e) => field('tick', e.currentTarget.value)}
					/></label
				>
				<label
					>note <input
						type="number"
						min="0"
						max="127"
						aria-label="Note pitch"
						value={one.note}
						onchange={(e) => field('note', e.currentTarget.value)}
					/></label
				>
			{/if}
			<label
				>length <input
					type="number"
					min="1"
					aria-label="Note length"
					value={one.dur}
					onchange={(e) => field('dur', e.currentTarget.value)}
				/></label
			>
			<label
				>velocity <input
					type="number"
					min="0"
					max="127"
					aria-label="Note velocity"
					value={one.vel}
					onchange={(e) => field('vel', e.currentTarget.value)}
				/></label
			>
			<span class="shaping" role="group" aria-label="Shape the chosen notes">
				{#if chosen.size > 1}
					<label
						>ramp <input
							type="number"
							min="1"
							max="127"
							aria-label="Ramp velocities from"
							bind:value={rampFrom}
						/></label
					>
					<label>to <input type="number" min="1" max="127" aria-label="Ramp velocities to" bind:value={rampTo} /></label
					>
					<button
						type="button"
						title="Velocities on a line from the first chosen note to the last"
						onclick={() => shape(rampVelocities(clip, chosen, rampFrom, rampTo))}>Ramp</button
					>
				{/if}
				<label
					>× <input
						type="number"
						min="0"
						max="4"
						step="0.05"
						aria-label="Scale velocities by"
						bind:value={scaleBy}
					/></label
				>
				<button
					type="button"
					title="Every chosen velocity times this, so their shape stays"
					onclick={() => shape(scaleVelocities(clip, chosen, scaleBy))}>Scale</button
				>
				<button
					type="button"
					title="Nudge each start by up to a 1/64 note and each velocity by up to 8, either way"
					onclick={() => shape(humanize(clip, chosen, Math.round(ppq / 16), 8, ++nudges))}>Humanize</button
				>
				<button
					type="button"
					title="Move each start to the nearest line of the grid"
					onclick={() => shape(quantize(clip, chosen, grid))}>Quantize</button
				>
			</span>
			{#if slots.length > 1}
				<label>
					slot
					<select
						aria-label="Note slot"
						value={one.slot === undefined ? '' : String(one.slot)}
						onchange={(e) => slotChanged(e.currentTarget.value)}
					>
						<option value="">first</option>
						{#each slots as slot, index (index)}<option value={String(index)}>{slot}</option>{/each}
					</select>
				</label>
			{/if}
		</fieldset>
	{:else if !readonly}
		<span class="muted">
			Click to add a note, and drag to set its length. Drag a note to move it, its end to resize it, and hold {mod} to copy
			it. Delete or a right-click removes it. Shift-drag selects, and arrows nudge.
		</span>
	{/if}
</div>

<div class="frame">
	<div class="roll" bind:this={scroller} onscroll={scrolled}>
		<div class="inner" style:width="{KEYS + width}px">
			<svg class="keys" width={KEYS} height={HEIGHT} aria-hidden="true">
				{#each { length: 128 }, row}
					{@const note = 127 - row}
					<rect
						class="key"
						class:black={isBlackKey(note)}
						y={row * KEY}
						width={KEYS}
						height={KEY}
						role="presentation"
						data-testid={`key-${note}`}
						onpointerdown={(event) => pressKey(event, note)}
					/>
					{#if note % 12 === 0}<text class="octave" x="4" y={row * KEY + KEY - 2}>{noteName(note)}</text>{/if}
				{/each}
			</svg>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
			<svg
				bind:this={roll}
				{width}
				height={HEIGHT}
				role="application"
				aria-label="Piano roll"
				tabindex="0"
				data-testid="roll"
				data-per-tick={perTick}
				onkeydown={keydown}
				onpointermove={hover}
				onpointerleave={() => (ghost = null)}
				oncontextmenu={rollMenu}
			>
				{#each { length: 128 }, row}
					<rect
						class="lane"
						class:black={isBlackKey(127 - row)}
						y={row * KEY}
						{width}
						height={KEY}
						role="presentation"
						onpointerdown={pressGround}
						ondblclick={doubleGround}
					/>
				{/each}
				{#each { length: beats + 1 }, beat}
					<line
						class:bar={beat % 4 === 0}
						class="beat"
						x1={beat * ppq * perTick}
						x2={beat * ppq * perTick}
						y1="0"
						y2={HEIGHT}
					/>
				{/each}
				<rect
					class="past"
					x={shown.length * perTick}
					width={Math.max(0, width - shown.length * perTick)}
					height={HEIGHT}
				/>
				{#each shown.notes as note, index (index)}
					<g
						class="note"
						class:chosen={chosen.has(index)}
						data-testid={`note-${index}`}
						data-tick={note.tick}
						data-note={note.note}
						data-dur={note.dur}
						data-vel={note.vel}
					>
						<rect
							class="body"
							x={note.tick * perTick}
							y={rowOf(note.note) + 1}
							width={Math.max(note.dur * perTick, 3)}
							height={KEY - 2}
							rx="2"
							role="presentation"
							onpointerdown={(event) => pressNote(event, index, 'move')}
							oncontextmenu={(event) => noteMenu(event, index)}
						/>
						{#if !readonly}
							<rect
								class="edge"
								x={Math.max(note.dur * perTick, 3) + note.tick * perTick - EDGE}
								y={rowOf(note.note) + 1}
								width={EDGE}
								height={KEY - 2}
								role="presentation"
								data-testid={`edge-${index}`}
								onpointerdown={(event) => pressNote(event, index, 'size')}
								oncontextmenu={(event) => noteMenu(event, index)}
							/>
						{/if}
					</g>
				{/each}
				{#if !readonly}
					<rect
						class="end"
						x={shown.length * perTick - 3}
						width="6"
						height={HEIGHT}
						role="presentation"
						data-testid="clip-end"
						onpointerdown={(event) => {
							event.stopPropagation();
							gesture = { kind: 'length', clip };
						}}
					/>
				{/if}
				{#if ghost && !gesture}
					<rect
						class="ghost"
						x={ghost.tick * perTick}
						y={rowOf(ghost.note) + 1}
						width={Math.max(draw * perTick, 3)}
						height={KEY - 2}
						rx="2"
					/>
				{/if}
				{#if ghostLabel}
					{@const at = gesture?.kind === 'draw' ? gesture.note : { ...ghost!, dur: draw }}
					<text
						class="ghost-label"
						x={(at.tick + at.dur) * perTick + 6}
						y={rowOf(at.note) + KEY - 2}
						data-testid="ghost">{ghostLabel}</text
					>
				{/if}
				{#if gesture?.kind === 'band'}
					<rect
						class="band"
						x={Math.min(gesture.from.x, gesture.at.x)}
						y={Math.min(gesture.from.y, gesture.at.y)}
						width={Math.abs(gesture.at.x - gesture.from.x)}
						height={Math.abs(gesture.at.y - gesture.from.y)}
					/>
				{/if}
				{#if playhead !== null}
					<line class="playhead" x1={playhead * perTick} x2={playhead * perTick} y1="0" y2={HEIGHT} />
				{/if}
			</svg>
		</div>
	</div>
	{#if offer}
		<div class="notice" role="alert" data-testid="lengthen-offer">
			<span>Growing this clip to {bars(offer.length)} would run it into the next clip on its track.</span>
			<button type="button" onclick={lengthen}>Lengthen to {bars(offer.length)}</button>
			<button type="button" aria-label="Leave the clip as it is" onclick={() => (offer = null)}>×</button>
		</div>
	{:else if notice}
		<div class="notice" role="status" data-testid="clip-grown">
			<span>{notice}</span>
			<button type="button" onclick={undoGrowth}>Undo</button>
		</div>
	{/if}
</div>

{#if menu}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		label={chosen.size > 1 ? `${chosen.size} notes` : 'Note'}
		items={noteItems()}
		onclose={() => (menu = null)}
	/>
{/if}

<div class="below" use:follows>
	<div style:width="{KEYS + width}px" style:padding-left="{KEYS}px" style:box-sizing="border-box">
		<svg {width} height={VELOCITY} role="application" aria-label="Velocity" data-testid="velocity">
			{#each shown.notes as note, index (index)}
				<rect
					class="velocity"
					class:chosen={chosen.has(index)}
					x={note.tick * perTick - 1}
					y={VELOCITY - (note.vel / 127) * VELOCITY}
					width="6"
					height={(note.vel / 127) * VELOCITY}
					role="presentation"
					data-testid={`velocity-${index}`}
					onpointerdown={(event) => pressVelocity(event, index)}
				/>
			{/each}
		</svg>
		{#each lanes as lane, index (lane.key)}
			{@const about = describeLane(lane, choices)}
			<AutomationLane
				{clip}
				{lane}
				label={about.label}
				min={about.min}
				max={about.max}
				{perTick}
				{width}
				{grid}
				{readonly}
				testid={`lane-${index}`}
				{onchange}
				onremove={() => onchange(removeLane(clip, lane.key))}
			/>
		{/each}
	</div>
</div>

{#if !readonly && free.length}
	<div class="toolbar">
		<select
			aria-label="Add a lane"
			value=""
			onchange={(e) => {
				addLane(e.currentTarget.value);
				e.currentTarget.value = '';
			}}
		>
			<option value="">Add a lane…</option>
			{#each free as choice (choice.key)}<option value={choice.key}>{choice.label}</option>{/each}
		</select>
		<span class="muted"
			>Click a lane to add a point, and drag one to move it. Delete or a right-click removes it. A point's ramp is how
			many ticks it takes to get there.</span
		>
	</div>
{/if}

<style>
	.toolbar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2rem;
		font-size: 0.8rem;
		flex-wrap: wrap;
		margin: 0.2rem 0;
	}
	.toolbar button {
		padding: 0 0.5rem;
	}
	fieldset {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		border: 0;
		margin: 0;
		padding: 0;
	}
	fieldset input {
		width: 4.5rem;
		padding: 0.05rem 0.25rem;
	}
	/* The roll takes the room its panel has, and scrolls inside it. What it says about a clip floats over its corner. */
	.frame {
		position: relative;
		flex: 1 1 200px;
		min-height: 100px;
		display: flex;
		flex-direction: column;
	}
	.roll {
		flex: 1;
		min-height: 0;
		overflow: auto;
		border: 1px solid var(--line);
		border-radius: 6px 6px 0 0;
		background: #0d1117;
	}
	.inner {
		display: flex;
	}
	.roll svg {
		display: block;
		flex: none;
	}
	svg {
		user-select: none;
		touch-action: none;
		outline: none;
	}
	.keys {
		position: sticky;
		left: 0;
		z-index: 1;
	}
	.key {
		fill: #c9d1d9;
		stroke: #30363d;
		stroke-width: 0.5;
		cursor: pointer;
	}
	.key.black {
		fill: #21262d;
	}
	.octave {
		fill: #0d1117;
		font-size: 9px;
		pointer-events: none;
	}
	.lane {
		fill: #0d1117;
		stroke: #161b22;
		stroke-width: 0.5;
	}
	.lane.black {
		fill: #0a0d12;
	}
	.beat {
		stroke: #1c2128;
		pointer-events: none;
	}
	.beat.bar {
		stroke: #30363d;
	}
	.past {
		fill: #00000080;
		pointer-events: none;
	}
	.note .body {
		fill: #2f81f7;
		stroke: #0d1117;
		cursor: grab;
	}
	.note.chosen .body {
		fill: #f0883e;
	}
	.edge {
		fill: transparent;
		cursor: ew-resize;
	}
	.end {
		fill: #d2992280;
		cursor: ew-resize;
	}
	.band {
		fill: #58a6ff20;
		stroke: var(--accent);
		pointer-events: none;
	}
	.playhead {
		stroke: #f0883e;
		pointer-events: none;
	}
	.ghost {
		fill: #2f81f740;
		stroke: #79c0ff;
		stroke-dasharray: 3 2;
		pointer-events: none;
	}
	.ghost-label {
		fill: var(--text);
		font-size: 11px;
		stroke: #0d1117;
		stroke-width: 3px;
		paint-order: stroke;
		pointer-events: none;
	}
	.notice {
		position: absolute;
		right: 0.75rem;
		bottom: 0.75rem;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: calc(100% - 5rem);
		padding: 0.35rem 0.5rem 0.35rem 0.75rem;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 6px;
		box-shadow: 0 4px 14px #00000080;
		font-size: 0.8rem;
	}
	.notice button {
		flex: none;
		padding: 0.1rem 0.5rem;
	}
	.below {
		flex: none;
		max-height: 45%;
		overflow-x: hidden;
		overflow-y: auto;
		border: 1px solid var(--line);
		border-top: 0;
		border-radius: 0 0 6px 6px;
		background: #0d1117;
	}
	.velocity {
		fill: #2f81f7;
		cursor: ns-resize;
	}
	.velocity.chosen {
		fill: #f0883e;
	}
</style>
