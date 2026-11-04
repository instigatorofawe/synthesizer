<script lang="ts">
	import { onDestroy, onMount, tick as settle, untrack } from 'svelte';
	import { on } from 'svelte/events';
	import AutomationLane from '#lib/AutomationLane.svelte';
	import { clipboard } from '#lib/Clipboard.ts';
	import ContextMenu, { EXAMPLE_NOTE, type MenuItem } from '#lib/ContextMenu.svelte';
	import { escapeCancels } from '#lib/Drag.ts';
	import { FOLLOW_MARGIN, followScroll } from '#lib/Follow.ts';
	import { keyText, kitKeys, noteText, type Kit } from '#lib/Kit.ts';
	import { ROW, ROWS, anchored, clampBeat, fitRoll, wheelAction, type RollView } from '#lib/RollView.ts';
	import { matches, modHeld, modKey, typingIn } from '#lib/Shortcuts.ts';
	import {
		START,
		chordEnd,
		lengthen as lengthenHeld,
		moveTo,
		press,
		release,
		rest,
		repitch,
		stepBack,
		write,
		type Chord,
		type Cursor
	} from '#lib/StepEntry.ts';
	import {
		addNote,
		addPoint,
		laneKey,
		describeLane,
		duplicateNotes,
		growToHold,
		humanize,
		lanesOf,
		moveNotes,
		noteSpan,
		pasteAt,
		pasteNotes,
		quantize,
		rampVelocities,
		removeLane,
		removeNotes,
		resizeNotes,
		scaleVelocities,
		setNotes,
		type Clip,
		type LaneChoice,
		type Note
	} from '#lib/TimelineEdit.ts';
	import { Bars } from '#lib/TimeSignature.ts';
	import { isBlackKey, noteName, noteValue, noteLengths, readLength, readPitch, readPosition } from '#lib/Units.ts';
	import UnitField from '#lib/UnitField.svelte';

	let {
		clip,
		ppq,
		bars = Bars.of(ppq).shifted(0, true),
		grid,
		slots,
		kit = null,
		choices,
		silent = false,
		playhead,
		playing = false,
		canAudition,
		readonly = false,
		draw = $bindable(),
		velocity = 100,
		stepping = $bindable(false),
		active = true,
		cursors = new Map(),
		cangrow = () => true,
		view = null,
		expanded = false,
		onchange,
		onaudition,
		onundo = () => {},
		onpatchinput,
		onview = () => {},
		onsay,
		toolbarIn = null
	}: {
		clip: Clip;
		ppq: number;
		bars?: Bars; // The song's bars where the clip is placed, in its own ticks and counted from its own first (TimeSignature.ts)
		grid: number;
		slots: string[]; // The track's patches, for notes that choose one
		// The kit the clip's notes play, on a kit track (Kit.ts): the keys are named by it, those it has no sound for are dimmed,
		// and so is a note on one
		kit?: Kit | null;
		choices: LaneChoice[];
		silent?: boolean; // The clip's track has no notes yet, so it never plays, and a lane that reaches past it can't run
		playhead: number | null; // In ticks from the start of the clip
		playing?: boolean; // Whether the song is playing, which the roll follows while it plays this clip
		canAudition: boolean;
		readonly?: boolean;
		draw: number; // How long a clicked note is, in ticks. It follows the last note added, resized or chosen, as FL Studio's does.
		velocity?: number; // The velocity of a new note, clicked or stepped, which C and V set
		stepping?: boolean; // Whether step entry is on, in which the piano keys write notes at a cursor (StepEntry.ts)
		active?: boolean; // Whether keys are for this roll, which they are while the Song view is on screen
		cursors?: Map<string, Cursor>; // Where step entry's cursor was in each clip, kept for when the roll comes back to it
		cangrow?: (length: number) => boolean; // Whether the clip can be this long without running into the clip after it
		view?: RollView | null; // Where the roll starts: the clip's zoom, row height and scroll as it was left, if it was
		expanded?: boolean; // Whether the notes have the whole view, which Esc leaves before it lets go of the notes
		onchange: (clip: Clip) => void;
		onaudition: (note: number, on: boolean) => void;
		onundo?: () => void; // The timeline's own undo, for the Undo beside "Clip is now 2 bars"
		// An input inside the track's patch given a parameter of its own, for a lane to move, whose id it gives once it's there
		onpatchinput?: (at: { patch: string; node: number; input: string }) => Promise<number | null>;
		onview?: (view: RollView, zoomed: boolean) => void; // As it scrolls, and as someone zooms it, which `zoomed` says
		onsay: (text: string) => void; // Says why something typed into a field was refused, where the page says such things
		toolbarIn?: HTMLElement | null; // Where the zoom, Fit, the chosen notes' fields and the hint go: the tab strip, which has room
	} = $props();

	const KEYS = $derived(kit ? 136 : 48); // The keys' width, which on a kit track has room for each key's sound
	const RULER = 16; // The bar ruler at the top, which stays there as the rows scroll under it
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
		// A press on the velocity strip: the notes it was pressed on, if any, and where it was pressed and last was, in the strip.
		| { kind: 'velocity'; clip: Clip; pressed: Set<number>; painting: boolean; from: Point; at: Point; lane: Element }
		| { kind: 'length'; clip: Clip }
		| { kind: 'band'; from: Point; at: Point }
		| { kind: 'draw'; from: Point; note: Note; drawn: boolean; clip: Clip };

	let roll: SVGSVGElement;
	let scroller: HTMLDivElement;
	let beatWidth = $state(untrack(() => view?.beat ?? 64));
	let rowHeight = $state(untrack(() => view?.row ?? ROW)); // A row is a semitone, a whole number of pixels high
	let rowAim = untrack(() => rowHeight); // What a slow pinch is making the rows, a little at a time, before it is rounded
	const rollHeight = $derived(128 * rowHeight);
	let chosen = $state.raw(new Set<number>());
	let gesture = $state.raw<Gesture | null>(null);
	let ghost = $state.raw<{ tick: number; note: number } | null>(null); // The empty cell under the pointer
	// Moves an element into `target`, and back out of the page with the roll. What is inside it moves with it, so the element's
	// own content keeps working where it is drawn.
	function drawnIn(element: HTMLElement, target: HTMLElement | null) {
		const place = (to: HTMLElement | null) => to?.appendChild(element);
		place(target);
		return { update: place, destroy: () => element.remove() };
	}

	// The velocity strip and the lanes fold, to give the notes their room, and stay as they were left across clips and visits.
	const FOLDS_KEY = 'modsynth.below';
	let velocityShown = $state(true);
	let lanesShown = $state(true);
	function foldBelow(which: 'velocity' | 'lanes') {
		if (which === 'velocity') velocityShown = !velocityShown;
		else lanesShown = !lanesShown;
		localStorage.setItem(FOLDS_KEY, JSON.stringify({ velocity: velocityShown, lanes: lanesShown }));
	}

	// The chosen notes' menu, or with `ground` the roll's own, for a right-click where there is no note.
	// The chosen notes' menu, or the roll's own, which from the keys column also chooses every note of its key.
	let menu = $state.raw<{ x: number; y: number; ground?: true; key?: number } | null>(null);
	let notice = $state<string | null>(null); // Said after a clip grows, with an Undo beside it
	// A note that would have grown the clip into the next, clicked or from step entry
	let offer = $state.raw<{ note: Note; length: number; step?: true } | null>(null);
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	let mod = $state('Ctrl'); // What the hint calls Mod, which only the browser knows
	// Step entry's cursor, where it last was in this clip, and the chord whose keys are down. A key pressed when no step could
	// be written is refused, and letting it go writes nothing.
	let cursor = $state.raw<Cursor>(untrack(() => cursors.get(clip.id) ?? START));
	let chord = $state.raw<Chord | null>(null);
	const refused = new Set<number>();

	const perTick = $derived(beatWidth / ppq);
	const sounds = $derived(kit ? kitKeys(kit) : null); // A kit's keys, by note
	const silentKey = (note: number) => !!sounds && !sounds.has(note);
	// The chosen notes' slot is the kit's to choose, unless one is on a key it has no sound for.
	const kitSlots = $derived(!!sounds && [...chosen].every((i) => sounds!.has(clip.notes[i]?.note ?? -1)));
	// A bar's length at the clip's end, which is how far past it the roll goes on.
	const bar = $derived(Math.max(1, bars.at(clip.length).end - bars.at(clip.length).start));
	// How long a whole bar is where a tick is, for the lengths that read in bars.
	const barAt = (tick: number) => {
		const there = bars.at(tick);
		return there.beat * there.meter.beats;
	};
	const shown = $derived(gesture && 'clip' in gesture ? gesture.clip : clip);
	const widthTicks = $derived(
		Math.max(
			shown.length + PAST_BARS * bar,
			...shown.notes.map((n) => n.tick + n.dur + ppq),
			stepping ? Math.max(cursor.tick, chord ? chordEnd(chord) : 0) + bar : 0
		)
	);
	const width = $derived(widthTicks * perTick);
	// The roll's beat lines, in the meter's own beats, and its bar lines, numbered from the clip's first bar.
	const beatLines = $derived.by(() => {
		const lines: { tick: number; bar: boolean; number: number; beat: number; wide: boolean }[] = [];
		for (const bar of bars.between(0, widthTicks + 1, 4000)) {
			const wide = bar.beat * perTick >= 48;
			for (let at = bar.start, beat = 1; at < bar.end; at += bar.beat, ++beat) {
				if (at >= 0 && at <= widthTicks)
					lines.push({ tick: at, bar: at === bar.start, number: bar.number, beat, wide });
			}
		}
		return lines;
	});
	const lanes = $derived(lanesOf(clip));
	const free = $derived(choices.filter((choice) => !lanes.some((lane) => lane.key === choice.key)));
	// The choices under what each belongs to, in the order they come: the track's patch, inserts, then the mix.
	const laneGroups = $derived([...Map.groupBy(free, (choice) => choice.group)]);
	const one = $derived(chosen.size ? clip.notes[[...chosen][0]] : undefined);
	const heldKeys = new Set<number>();

	function canvas(event: { clientX: number; clientY: number }, element: Element = roll) {
		const box = element.getBoundingClientRect();
		return { x: event.clientX - box.left, y: event.clientY - box.top };
	}

	const rowOf = (note: number) => (127 - note) * rowHeight;
	const noteAt = (y: number) => Math.min(127, Math.max(0, 127 - Math.floor(y / rowHeight)));

	// The cell under the pointer, at the line of the grid before it, which is where a click puts a note.
	function cellAt(event: { clientX: number; clientY: number }) {
		const at = canvas(event);
		return { tick: bars.floor(at.x / perTick, grid), note: noteAt(at.y) };
	}

	// The line of the grid nearest the pointer, which is where a click in step entry puts the cursor.
	function lineAt(event: { clientX: number; clientY: number }) {
		const at = canvas(event);
		return { tick: bars.snap(at.x / perTick, grid), note: noteAt(at.y) };
	}

	// A right-click chooses what it is on and opens its menu, and Ctrl-click is a right-click on a Mac, so neither drags.
	const secondary = (event: PointerEvent) => event.button !== 0 || (event.ctrlKey && modKey() === 'Meta');

	const describe = (note: Pick<Note, 'tick' | 'note' | 'dur'>) =>
		`${noteText(sounds, note.note)} · ${noteValue(note.dur, ppq, barAt(note.tick))} · ${bars.position(note.tick)}`;

	// What the ghost says: the note a click would add, or the one being drawn. Past the end it says what that does to the clip.
	const ghostLabel = $derived.by(() => {
		const note = gesture?.kind === 'draw' ? gesture.note : ghost && !stepping && { ...ghost, dur: draw };
		if (!note) return null;
		const grown = growToHold(clip, note.tick, bars);
		if (grown === clip) return describe(note);
		return `${describe(note)} · ${cangrow(grown.length) ? `makes the clip ${barsText(grown.length)}` : 'past the end'}`;
	});

	// The lanes' hint, cut short at a laptop's width, and so its title too.
	const LANE_HINT =
		'Click a lane to add a point, joined to the one before by a line, and drag one to move it. A right-click makes it ' +
		'a step, a line or a curve, or removes it, as Delete does.';

	const SILENT_HINT =
		'Add a note first for a lane that moves the mix, an insert or a global: a track with no notes never plays, so ' +
		"such a lane couldn't run.";

	// A clip's length as bars, counted from its first, which a pickup or a placement part way into a bar makes a part of one.
	function barsText(length: number) {
		const end = bars.at(length);
		const count = end.start === length ? end.number - 1 : (length - Math.max(0, bars.at(0).start)) / bar;
		return `${count} bar${count === 1 ? '' : 's'}`;
	}

	function pressNote(event: PointerEvent, index: number, kind: 'move' | 'size') {
		event.stopPropagation();
		roll.focus({ preventScroll: true });
		ghost = null;
		offer = null;
		const menuing = secondary(event);
		if (event.shiftKey && !menuing) {
			const next = new Set(chosen);
			if (next.has(index)) next.delete(index);
			else next.add(index);
			chosen = next;
		} else if (!chosen.has(index)) {
			chosen = new Set([index]);
		}
		if (readonly || menuing) return;
		if (!event.shiftKey) draw = clip.notes[index].dur;
		const from = canvas(event);
		if (kind === 'move' && modHeld(event)) {
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
		pressed = null;
		if (secondary(event)) return;
		if (event.shiftKey) {
			gesture = { kind: 'band', from: canvas(event), at: canvas(event) };
			return;
		}
		// In step entry a click moves the cursor, and adds nothing.
		if (stepping) {
			chosen = new Set();
			moveCursor(moveTo(lineAt(event).tick));
			return;
		}
		if (readonly) {
			chosen = new Set();
			return;
		}
		const { tick, note } = cellAt(event);
		pressed = { tick, note };
		// A note already there is too short to hit, or the first click of a double-click put it there.
		const there = clip.notes.findIndex((n) => n.tick === tick && n.note === note);
		if (there >= 0) {
			chosen = new Set([there]);
			return;
		}
		const added = { tick, note, vel: velocity, dur: draw };
		ghost = null;
		chosen = new Set([clip.notes.length]);
		gesture = { kind: 'draw', from: canvas(event), note: added, drawn: false, clip: addNote(clip, added) };
		audition(note);
	}

	// A double-click on empty grid adds a note too. Its first click almost always has, so this adds one only if it hasn't, in
	// the cell that click chose. The double-click's own position is in whole pixels where a press's isn't, so near the edge
	// of a row it can fall in the next one, and a note there would be a second. In step entry the first click moved the
	// cursor, and so does the second.
	let pressed: { tick: number; note: number } | null = null;
	function doubleGround() {
		if (readonly || stepping || !pressed) return;
		const { tick, note } = pressed;
		if (clip.notes.some((n) => n.tick === tick && n.note === note)) return;
		place({ tick, note, vel: velocity, dur: draw });
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
		const grown = growToHold(clip, note.tick, bars);
		if (grown !== clip && !cangrow(grown.length)) {
			chosen = new Set();
			offer = { note, length: grown.length };
			return;
		}
		// Asked before the change, which reaches `clip` at once.
		const grows = grown !== clip;
		draw = note.dur;
		chosen = new Set([clip.notes.length]);
		onchange(addNote(grown, note));
		if (grows) tell(`Clip is now ${barsText(grown.length)}`);
	}

	function lengthen() {
		if (!offer) return;
		const { note, step } = offer;
		const length = Math.max(clip.length, offer.length);
		offer = null;
		if (step) {
			// The step that was refused is written after all, and the cursor moves on past it.
			const written = write({ ...clip, length }, cursor, { start: note.tick, notes: [note], held: [] }, bars);
			chosen = new Set();
			moveCursor(written.cursor);
			onchange(written.clip);
		} else {
			draw = note.dur;
			chosen = new Set([clip.notes.length]);
			onchange(addNote({ ...clip, length }, note));
		}
		tell(`Clip is now ${barsText(length)}`);
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

	// The ghost follows the pointer over empty grid, from cell to cell, or in step entry from line to line.
	function hover(event: PointerEvent) {
		const empty = (event.target as Element).classList.contains('lane');
		const cell = readonly || gesture || menu || !empty ? null : stepping ? lineAt(event) : cellAt(event);
		if (cell?.tick !== ghost?.tick || cell?.note !== ghost?.note) ghost = cell;
	}

	function audition(note: number) {
		if (!canAudition) return;
		onaudition(note, true);
		setTimeout(() => onaudition(note, false), AUDITION_MS);
	}

	function moved(g: Extract<Gesture, { kind: 'move' }>, at: Point): Clip {
		const anchor = g.base.notes[g.anchor];
		const wanted = bars.snap(anchor.tick + (at.x - g.from.x) / perTick, grid) - anchor.tick;
		const last = Math.max(...[...g.indices].map((i) => g.base.notes[i].tick));
		const dt = Math.min(wanted, clip.length - 1 - last);
		return moveNotes(g.base, g.indices, dt, Math.round((g.from.y - at.y) / rowHeight));
	}

	// Whether a move has left every note where it was, which a click on a note does.
	const still = (g: Extract<Gesture, { kind: 'move' }>) =>
		[...g.indices].every(
			(i) => g.clip.notes[i].tick === g.base.notes[i].tick && g.clip.notes[i].note === g.base.notes[i].note
		);

	function resized(g: Extract<Gesture, { kind: 'size' }>, at: Point): Clip {
		const anchor = clip.notes[g.anchor];
		const end = bars.snap(anchor.tick + anchor.dur + (at.x - g.from.x) / perTick, grid);
		return resizeNotes(clip, chosen, end - anchor.tick - anchor.dur, bars.step(anchor.tick, grid));
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
			const line = bars.floor(at.x / perTick, grid);
			const end = bars.ceil(line + 1, grid);
			const note = { ...gesture.note, dur: Math.max(bars.step(gesture.note.tick, grid), end - gesture.note.tick) };
			gesture = { ...gesture, drawn: true, note, clip: addNote(clip, note) };
		} else if (gesture.kind === 'velocity') {
			gesture = painted(gesture, canvas(event, gesture.lane));
		} else if (gesture.kind === 'length') {
			const length = Math.max(bars.step(0, grid), bars.snap(canvas(event).x / perTick, grid));
			gesture = { ...gesture, clip: { ...clip, length } };
		}
	}

	function finishBand(from: Point, at: Point) {
		const [left, right] = [Math.min(from.x, at.x) / perTick, Math.max(from.x, at.x) / perTick];
		const [top, bottom] = [Math.min(from.y, at.y), Math.max(from.y, at.y)];
		const inside = new Set<number>();
		clip.notes.forEach((note, index) => {
			const y = rowOf(note.note);
			if (note.tick < right && note.tick + note.dur > left && y < bottom && y + rowHeight > top) inside.add(index);
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

	const velocityAt = (y: number) => Math.min(127, Math.max(1, Math.round((1 - y / VELOCITY) * 127)));

	// The stems, each from its note's start to its end, as tall as it is loud. The loudest are drawn first, so the quieter
	// notes of a chord stand in front of them, and chosen notes go on top, so a chord's can be reached once it is chosen.
	const stems = $derived(
		shown.notes
			.map((note, index) => ({ note, index }))
			.sort((a, b) => Number(chosen.has(a.index)) - Number(chosen.has(b.index)) || b.note.vel - a.note.vel)
	);

	// A press on a stem sets its note, or all the chosen notes if it is one of them, to the velocity under the pointer, and a
	// drag up or down goes on setting them. A drag across the strip paints instead: each note whose start it passes takes the
	// velocity under the pointer as it passed, and the notes it was pressed on keep what the press gave them.
	function pressStrip(event: PointerEvent) {
		if (readonly || secondary(event)) return;
		const lane = event.currentTarget as Element;
		const stem = (event.target as Element).closest('[data-index]');
		const index = stem ? Number(stem.getAttribute('data-index')) : null;
		const pressed = index === null ? new Set<number>() : chosen.has(index) ? chosen : new Set([index]);
		const at = canvas(event, lane);
		const pressedClip = pressed.size ? setNotes(clip, pressed, { vel: velocityAt(at.y) }) : clip;
		gesture = { kind: 'velocity', clip: pressedClip, pressed, painting: false, from: at, at, lane };
	}

	function painted(g: Extract<Gesture, { kind: 'velocity' }>, at: Point): Extract<Gesture, { kind: 'velocity' }> {
		const [left, right] = [Math.min(g.at.x, at.x), Math.max(g.at.x, at.x)];
		const passed = new Map<number, number>();
		if (right > left) {
			clip.notes.forEach((note, index) => {
				const x = note.tick * perTick;
				if (x < left || x > right) return;
				passed.set(index, velocityAt(g.at.y + ((x - g.at.x) / (at.x - g.at.x)) * (at.y - g.at.y)));
			});
		}
		const painting = g.painting || passed.size > 0 || Math.abs(at.x - g.from.x) > DRAG;
		let next = g.clip;
		if (!painting && g.pressed.size) next = setNotes(next, g.pressed, { vel: velocityAt(at.y) });
		if (passed.size) {
			next = { ...next, notes: next.notes.map((n, i) => (passed.has(i) ? { ...n, vel: passed.get(i)! } : n)) };
		}
		return { ...g, clip: next, painting, at };
	}

	function nudge(ticks: number, notes: number) {
		if (chosen.size) onchange(moveNotes(clip, chosen, ticks, notes));
	}

	// Notes a duplicate or a paste put past the clip's end grow it to the bar that holds the last of them, as a note put there
	// does, unless that would run a placement of the clip into the next one. Then they wait past the end, dimmed, as before.
	function withRoom(next: Clip) {
		const grown = growToHold(next, Math.max(...next.notes.map((n) => n.tick)), bars);
		const grows = grown !== next && cangrow(grown.length);
		onchange(grows ? grown : next);
		if (grows) tell(`Clip is now ${barsText(grown.length)}`);
	}

	function duplicate() {
		if (!chosen.size) return;
		const copied = duplicateNotes(clip, chosen);
		chosen = copied.chosen;
		withRoom(copied.clip);
	}

	// Copies stay in the page. The first paste in the clip they came from lands straight after them, and the first in another
	// clip where they were in theirs, and each paste after that straight after the one before (`pasteAt`).
	function copy() {
		const notes = clip.notes.filter((_, i) => chosen.has(i));
		if (!notes.length) return;
		const at = Math.min(...notes.map((n) => n.tick));
		clipboard.notes = { what: notes, from: clip.id, at, span: noteSpan(notes), pasted: null };
	}

	function paste() {
		const copied = clipboard.notes;
		if (!copied) return;
		const at = pasteAt(copied, copied.pasted, clip.id);
		copied.pasted = { to: clip.id, at };
		const pasted = pasteNotes(clip, copied.what, at);
		chosen = pasted.chosen;
		withRoom(pasted.clip);
	}

	// An example's notes can be chosen and copied, which changes nothing, and Mod+D is kept from the browser, which would
	// bookmark the page.
	function readonlyKeys(event: KeyboardEvent) {
		if (matches(event, 'select-all') || matches(event, 'copy') || matches(event, 'duplicate')) event.preventDefault();
		if (matches(event, 'select-all')) chosen = new Set(clip.notes.keys());
		else if (matches(event, 'copy')) copy();
	}

	// The roll's keys, from the editor's one table of them. Each needs exactly its own modifiers.
	function keydown(event: KeyboardEvent) {
		if (readonly) return readonlyKeys(event);
		const by = (id: Parameters<typeof matches>[1]) => matches(event, id);
		if (by('roll.delete') || by('roll.backspace')) {
			event.preventDefault();
			const gone = chosen;
			chosen = new Set();
			if (gone.size) onchange(removeNotes(clip, gone));
		} else if (by('select-all')) {
			event.preventDefault();
			chosen = new Set(clip.notes.keys());
		} else if (by('copy')) {
			event.preventDefault(); // Or the browser copies whatever text is selected, which nobody meant here
			copy();
		} else if (by('paste')) {
			event.preventDefault();
			paste();
		} else if (by('duplicate')) {
			event.preventDefault();
			duplicate();
		} else if (by('menu')) {
			event.preventDefault();
			menuAtChosen();
		} else if (by('escape')) {
			// Expand is the editor's to leave, so Esc goes on to it then.
			if (escape()) event.preventDefault();
		} else if (by('roll.up') || by('roll.down') || by('roll.octave-up') || by('roll.octave-down')) {
			event.preventDefault();
			nudge(0, (event.code === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 12 : 1));
		} else if (by('roll.earlier') || by('roll.later')) {
			event.preventDefault();
			const from = Math.min(...[...chosen].map((i) => clip.notes[i]?.tick ?? 0));
			nudge((event.code === 'ArrowLeft' ? -1 : 1) * bars.step(from, grid), 0);
		}
	}

	// Esc lets go of one thing at a time: what is being dragged or drawn, then an offer, then step entry, then Expand, which
	// the editor leaves, and then the notes. Whether it let go of something here.
	function escape() {
		if (gesture?.kind === 'draw') chosen = new Set();
		if (gesture) gesture = null;
		else if (offer) offer = null;
		else if (stepping) stepping = false;
		else if (expanded) return false;
		else chosen = new Set();
		return true;
	}

	// A press on a note can leave focus on the page rather than the roll, so while a drag is under way Esc is taken wherever
	// focus is.
	const dragging = $derived(gesture !== null);
	$effect(() => {
		if (dragging) return escapeCancels(() => gesture && escape());
	});

	// ------------------------------------------------------------------------------------------------------- step entry

	// A piano key, from the page, which step entry writes while it is on. A key pressed joins the chord at the cursor, and
	// once the last of the chord's keys is let go the chord is written, as one edit, and the cursor moves on past it. Past the
	// clip's end the clip grows, as it does for a clicked note, unless that would run it into the next clip on its track:
	// then nothing is written, and lengthening the clip anyway is offered.
	export function stepKey(note: number, on: boolean) {
		if (!on) {
			if (refused.delete(note) || !chord?.held.includes(note)) return;
			chord = release(chord, note);
			if (!chord.held.length) writeChord(chord);
			return;
		}
		if (!stepping || readonly || !active) return;
		if (!chord && !mayWrite(cursor.tick, { tick: cursor.tick, note, vel: velocity, dur: draw })) {
			refused.add(note);
			return;
		}
		offer = null;
		chord = press(chord, cursor, note, draw, velocity);
		reveal(chord.start, note);
	}

	// Whether a step at `tick` fits the clip, or can grow it to fit. If not, lengthening is offered for `note`.
	function mayWrite(tick: number, note: Note) {
		const grown = growToHold(clip, tick, bars);
		if (grown === clip || cangrow(grown.length)) return true;
		offer = { note, length: grown.length, step: true };
		return false;
	}

	function writeChord(done: Chord) {
		chord = null;
		if (!done.notes.length || !mayWrite(done.start, done.notes[0])) return;
		const grows = growToHold(clip, done.start, bars) !== clip; // Asked before the change, which reaches `clip` at once
		const written = write(clip, cursor, done, bars);
		chosen = new Set(); // A note it replaces moves the others' places
		moveCursor(written.cursor);
		onchange(written.clip);
		if (grows) tell(`Clip is now ${barsText(written.clip.length)}`);
	}

	function moveCursor(next: Cursor) {
		cursor = next;
		cursors.set(clip.id, next);
		reveal(next.tick);
	}

	// Backspace: the last step taken back, or with none behind the cursor, the cursor back by the Draw length.
	function stepBackOnce() {
		const back = stepBack(clip, cursor, draw);
		moveCursor(back.cursor);
		if (back.clip === clip) return;
		chosen = new Set();
		onchange(back.clip);
	}

	// Keeps the cursor and what is written after it in sight, and a note being written. Going on past the right edge, the view
	// moves only as far as the next step needs, so what was just written stays in sight behind it.
	function reveal(tick: number, note?: number) {
		if (!scroller) return;
		const x = tick * perTick;
		const width = scroller.clientWidth - KEYS;
		const end = x + draw * perTick;
		if (x < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, x - FOLLOW_MARGIN);
		else if (end > scroller.scrollLeft + width)
			scroller.scrollLeft = Math.max(0, Math.min(x - FOLLOW_MARGIN, end + FOLLOW_MARGIN - width));
		if (note === undefined) return;
		const y = rowOf(note);
		if (y < scroller.scrollTop || y + rowHeight > scroller.scrollTop + rowsSeen())
			scroller.scrollTop = y - rowsSeen() / 2;
	}

	// Step entry's keys, while it is on, wherever focus is but a field, a menu, a dialog or the browser, which keep their own.
	// The roll and the arrangement would move or delete what is chosen with → and Backspace, so these are heard first, on the
	// way down, and go no further. Esc goes no further either, so one press leaves one thing.
	function stepKeys(event: KeyboardEvent) {
		if (!stepping || readonly || !active) return;
		const target = event.target as Element | null;
		if (typingIn(target, event.key) || target?.closest?.('[role="menu"], dialog, nav')) return;
		if (matches(event, 'step.rest')) {
			offer = null;
			if (chord) chord = lengthenHeld(chord, bars.step(chordEnd(chord), grid));
			else moveCursor(rest(cursor, draw));
		} else if (matches(event, 'step.back')) {
			offer = null;
			// With keys still down, it drops what they would have written.
			if (chord) chord = null;
			else stepBackOnce();
		} else if (
			matches(event, 'step.up') ||
			matches(event, 'step.down') ||
			matches(event, 'step.octave-up') ||
			matches(event, 'step.octave-down')
		) {
			if (chord) return; // Keys still down are still being chosen
			const by = matches(event, 'step.up')
				? 1
				: matches(event, 'step.down')
					? -1
					: matches(event, 'step.octave-up')
						? 12
						: -12;
			const fixed = repitch(clip, cursor, by);
			if (fixed.clip !== clip) {
				chosen = new Set();
				moveCursor(fixed.cursor);
				onchange(fixed.clip);
				const top = Math.max(...fixed.cursor.steps.at(-1)!.notes.map((note) => note.note));
				audition(top); // Heard, as a note clicked in is
				reveal(fixed.cursor.tick, top);
			}
		} else if (matches(event, 'escape')) {
			escape();
		} else {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
	}

	onMount(() => on(window, 'keydown', stepKeys, { capture: true }));

	function noteMenu(event: MouseEvent, index: number) {
		event.preventDefault();
		event.stopPropagation();
		gesture = null;
		if (!chosen.has(index)) chosen = new Set([index]);
		menu = { x: event.clientX, y: event.clientY };
	}

	// Shift+F10 or the menu key opens the chosen notes' menu, at the first of them.
	function rollMenu(event: MouseEvent) {
		event.preventDefault();
		if (event.target === roll) return menuAtChosen();
		gesture = null;
		menu = { x: event.clientX, y: event.clientY, ground: true };
	}

	// The ruler's and the key column's, which are the roll's too. A key's also chooses every note of it.
	function sideMenu(event: MouseEvent, key?: number) {
		event.preventDefault();
		gesture = null;
		menu = { x: event.clientX, y: event.clientY, ground: true, key };
	}

	// A velocity stem's is its note's, and the lane's own, where no stem is, the roll's.
	function velocityMenu(event: MouseEvent) {
		const stem = (event.target as Element).closest('[data-index]');
		if (!stem) return sideMenu(event);
		event.preventDefault();
		gesture = null;
		const index = Number(stem.getAttribute('data-index'));
		if (!chosen.has(index)) chosen = new Set([index]);
		menu = { x: event.clientX, y: event.clientY };
	}

	const keyItems = (key: number): MenuItem[] => {
		const all = new Set(clip.notes.flatMap((note, index) => (note.note === key ? [index] : [])));
		const name = sounds?.get(key)?.name ?? noteName(key);
		return [{ label: `Choose every ${name}`, action: () => (chosen = all), disabled: !all.size }];
	};

	const groundItems = (key?: number): MenuItem[] => [
		...(key === undefined ? [] : keyItems(key)),
		{ label: 'Paste', keys: 'paste' as const, action: paste, disabled: readonly || !clipboard.notes },
		{
			label: 'Choose all',
			keys: 'select-all',
			action: () => (chosen = new Set(clip.notes.keys())),
			disabled: !clip.notes.length
		},
		{ label: 'Fit', keys: 'fit', action: () => void fit() }
	];

	function menuAtChosen() {
		gesture = null;
		if (!chosen.size) return;
		const first = roll.querySelector(`[data-testid="note-${Math.min(...chosen)}"] .body`);
		const box = (first ?? roll).getBoundingClientRect();
		menu = { x: box.left, y: box.bottom };
	}

	const noteItems = (): MenuItem[] => [
		{ label: 'Copy', keys: 'copy', action: copy },
		{
			label: 'Delete',
			keys: 'roll.delete',
			action: () => {
				const gone = chosen;
				chosen = new Set();
				onchange(removeNotes(clip, gone));
			},
			disabled: readonly
		},
		{ label: 'Duplicate', keys: 'duplicate', action: duplicate, disabled: readonly }
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

	// A lane starts with a point at the clip's start, at the value what it moves stands at. One on an input inside the patch
	// waits for the page to give the input a parameter, and then moves that.
	async function addLane(key: string) {
		const choice = free.find((candidate) => candidate.key === key);
		if (!choice) return;
		if (!choice.input) return onchange(addPoint(clip, choice, 0, choice.start));
		const param = await onpatchinput?.(choice.input);
		if (param === null || param === undefined) return;
		await settle();
		const made = choices.find((candidate) => candidate.key === laneKey(param, undefined));
		if (made) onchange(addPoint(clip, made, 0, made.start));
	}

	// The roll scrolls both ways, and everything below it follows it across.
	const followers = new Set<HTMLElement>();
	function follows(element: HTMLElement) {
		followers.add(element);
		element.scrollLeft = scroller?.scrollLeft ?? 0;
		return { destroy: () => followers.delete(element) };
	}
	function scrolled() {
		// The scroll a roll makes as it opens can arrive once another clip's roll has taken its place.
		if (!scroller) return;
		for (const element of followers) element.scrollLeft = scroller.scrollLeft;
		report();
	}

	// What the roll shows, for the editor to keep for this clip. A zoom is someone's choice, and a scroll only where they were.
	function report(zoomed = false) {
		const { scrollLeft: left, scrollTop: top } = scroller;
		onview({ beat: beatWidth, row: rowHeight, left, top }, zoomed);
	}

	// How much of the rows is in sight: the scroller less the ruler, which stays over its top. A row's y is in sight from the
	// scroll's top to that and this.
	const rowsSeen = () => scroller.clientHeight - RULER;

	// A zoom to `beat` pixels a beat and `row` pixels a row, which keeps the tick and the note under the pointer where they
	// were. Without a pointer it keeps the left edge and the middle row.
	async function zoom(beat: number, row: number, pointer?: { clientX: number; clientY: number }) {
		const box = scroller.getBoundingClientRect();
		const x = pointer ? pointer.clientX - box.left : KEYS;
		const y = pointer ? pointer.clientY - box.top : RULER + rowsSeen() / 2;
		const [left, top] = [scroller.scrollLeft, scroller.scrollTop];
		const across = clampBeat(beat) / beatWidth;
		rowAim = Math.min(ROWS.most, Math.max(ROWS.least, row));
		const down = Math.round(rowAim) / rowHeight;
		beatWidth = clampBeat(beat);
		rowHeight = Math.round(rowAim);
		await settle(); // The roll is its new size before it scrolls
		scroller.scrollLeft = anchored(left, x, across, KEYS);
		scroller.scrollTop = anchored(top, y, down, RULER);
		report(true);
	}

	// A wheel or two fingers scroll, as they would anywhere. Shift, Mod and a pinch are the roll's: see `wheelAction`.
	function wheel(event: WheelEvent) {
		const action = wheelAction(event, modKey(), scroller.clientHeight);
		if (action.kind === 'scroll') return;
		event.preventDefault();
		if (action.kind === 'sideways') scroller.scrollLeft += action.by;
		else if (action.kind === 'zoom') void zoom(beatWidth * action.by, rowHeight, event);
		else void zoom(beatWidth, rowAim * action.by, event);
	}

	// The clip's bars across the roll, and its notes in the middle of it, at the rows' height as it is. `.` does it too.
	export async function fit() {
		const fitted = fitRoll(clip, ppq, { width: scroller.clientWidth - KEYS, height: rowsSeen() }, rowHeight, bars);
		beatWidth = fitted.beat;
		await settle();
		scroller.scrollLeft = fitted.left;
		scroller.scrollTop = fitted.top;
		report(true);
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
		mod = modKey() === 'Meta' ? '⌘' : 'Ctrl';
		try {
			const kept = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}') as { velocity?: boolean; lanes?: boolean };
			velocityShown = kept.velocity !== false;
			lanesShown = kept.lanes !== false;
		} catch {
			// What was kept is unreadable, so both stay open
		}
		// A clip seen before comes back as it was left, and one zoomed before a reload at that zoom, around its notes.
		if (view?.left !== undefined && view.top !== undefined) {
			scroller.scrollLeft = view.left;
			scroller.scrollTop = view.top;
			return;
		}
		// A whole clip if it fits, up to a size where a short one doesn't turn into a few very long notes.
		if (!view) beatWidth = Math.min(96, Math.max(16, (scroller.clientWidth - KEYS) / (clip.length / ppq + 1)));
		const pitches = clip.notes.map((note) => note.note);
		const middle = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60;
		scroller.scrollTop = rowOf(middle) - rowsSeen() / 2;
	});

	// Step entry brings its cursor into sight as it starts, and leaving it lets go of a chord not yet written.
	$effect(() => {
		const started = stepping;
		untrack(() => {
			if (started) return reveal(cursor.tick);
			chord = null;
			refused.clear();
		});
	});
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} />

<!-- The toolbar is drawn into the tab strip, a row the roll had to itself before. Its home stays here, empty, so the roll's
	 own place in the page is where it was. -->
<div class="toolhome">
	<div class="toolbar top" use:drawnIn={toolbarIn}>
		<button
			type="button"
			onclick={() => zoom(beatWidth / 1.5, rowHeight)}
			aria-label="Zoom the roll out"
			title={`Zoom out. ${mod} with the wheel zooms, and ${mod}+Shift with it sets the rows' height.`}>−</button
		>
		<button
			type="button"
			onclick={() => zoom(beatWidth * 1.5, rowHeight)}
			aria-label="Zoom the roll in"
			title={`Zoom in. ${mod} with the wheel zooms, and ${mod}+Shift with it sets the rows' height.`}>+</button
		>
		<button type="button" onclick={fit} title="Fit the clip's bars across the roll, and scroll to its notes (.)"
			>Fit</button
		>
		{#if stepping}
			<span class="at" data-testid="step-at">Step at {bars.position(cursor.tick)}</span>
		{/if}
		{#if one}
			<fieldset disabled={readonly}>
				{#if chosen.size === 1}
					<label title="Its pitch, as a name such as E4, F#3 or Bb2, or a MIDI number"
						>pitch <UnitField
							label="Note pitch"
							value={one.note}
							format={noteName}
							read={readPitch}
							onvalue={(note) => onchange(setNotes(clip, chosen, { note }))}
							{onsay}
							width="3.6rem"
						/></label
					>
					{#if sounds}
						<span
							class="sound"
							class:none={silentKey(one.note)}
							data-testid="note-sound"
							title={silentKey(one.note)
								? 'The kit has no sound on this key, so the note keeps the slot it had'
								: "The kit's sound on this key, which the note plays"}>{sounds.get(one.note)?.name ?? 'no sound'}</span
						>
					{/if}
					<label title="Where it starts, as bar.beat.tick from the clip's start, or a bar"
						>at <UnitField
							label="Note tick"
							value={one.tick}
							format={(tick) => bars.position(tick)}
							read={readPosition(bars)}
							onvalue={(tick) => withRoom(setNotes(clip, chosen, { tick }))}
							{onsay}
							width="5.2rem"
						/></label
					>
				{:else}
					<span class="muted">{chosen.size} notes</span>
				{/if}
				<label title="How long it is, as a note value such as 1/8 or 3/16, in bars, as 2, or in ticks, as 240 ticks"
					>length <UnitField
						label="Note length"
						value={one.dur}
						format={(dur) => noteValue(dur, ppq, barAt(one?.tick ?? 0))}
						read={readLength(ppq, 1, barAt(one?.tick ?? 0))}
						choices={noteLengths(ppq, barAt(one?.tick ?? 0))}
						onvalue={(dur) => {
							draw = dur;
							onchange(setNotes(clip, chosen, { dur }));
						}}
						{onsay}
						width="5.2rem"
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
						<label
							>to <input type="number" min="1" max="127" aria-label="Ramp velocities to" bind:value={rampTo} /></label
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
						onclick={() => shape(quantize(clip, chosen, grid, 1, bars))}>Quantize</button
					>
				</span>
				{#if slots.length > 1}
					<label>
						slot
						<select
							aria-label="Note slot"
							value={one.slot === undefined ? '' : String(one.slot)}
							disabled={kitSlots}
							title={kitSlots ? 'The kit gives each key its slot' : undefined}
							onchange={(e) => slotChanged(e.currentTarget.value)}
						>
							<option value="">first</option>
							{#each slots as slot, index (index)}<option value={String(index)}>{slot}</option>{/each}
						</select>
					</label>
				{/if}
			</fieldset>
		{:else if stepping}
			{@const hint = `Keys write at the cursor, as long as Draw. Hold keys for a chord, and → while holding makes them longer. → rests, Backspace steps back, a click moves the cursor, and Esc leaves.`}
			<span class="muted hint" title={hint}>{hint}</span>
		{:else if !readonly}
			{@const hint = `Click to add a note, and drag to set its length. Drag a note to move it, its end to resize it, and hold ${mod} to copy it. Delete or a right-click removes it. Shift-drag selects, and arrows nudge.`}
			<span class="muted hint" title={hint}>{hint}</span>
		{/if}
	</div>
</div>

<div class="frame">
	<div class="roll" bind:this={scroller} onscroll={scrolled} onwheel={wheel}>
		<div class="inner" style:width="{KEYS + width}px">
			<!-- The clip's bars, counted from its start, over the rows and staying there as they scroll. -->
			<div class="rule">
				<div class="corner" style:width="{KEYS}px"></div>
				<svg
					class="ruler"
					{width}
					height={RULER}
					aria-hidden="true"
					data-testid="roll-ruler"
					oncontextmenu={(event) => sideMenu(event)}
				>
					<rect class="ground" {width} height={RULER} />
					<rect
						class="past"
						x={shown.length * perTick}
						width={Math.max(0, width - shown.length * perTick)}
						height={RULER}
					/>
					{#each beatLines as line (line.tick)}
						{@const x = line.tick * perTick}
						{#if line.bar}
							<line class="bar" x1={x} x2={x} y1="0" y2={RULER} />
							<text x={x + 3} y={RULER - 4}>{line.number}</text>
						{:else}
							<line class="tick" x1={x} x2={x} y1={RULER - 4} y2={RULER} />
							{#if line.wide}<text class="beatno" x={x + 3} y={RULER - 4}>{line.number}.{line.beat}</text>{/if}
						{/if}
					{/each}
					{#if playhead !== null}
						<line class="playhead" x1={playhead * perTick} x2={playhead * perTick} y1="0" y2={RULER} />
					{/if}
				</svg>
			</div>
			<div class="rows">
				<svg class="keys" width={KEYS} height={rollHeight} aria-hidden="true">
					{#each { length: 128 }, row}
						{@const note = 127 - row}
						{@const sound = sounds?.get(note)}
						<rect
							class="key"
							class:black={isBlackKey(note)}
							class:nosound={silentKey(note)}
							y={row * rowHeight}
							width={KEYS}
							height={rowHeight}
							role="presentation"
							data-testid={`key-${note}`}
							data-sound={sounds ? (sound?.name ?? '') : undefined}
							onpointerdown={(event) => pressKey(event, note)}
							oncontextmenu={(event) => sideMenu(event, note)}
						/>
						<!-- A kit names each key that has a sound, where a row is tall enough to read it. -->
						{#if sounds && sound && rowHeight >= 8}<text
								class="kitname"
								class:black={isBlackKey(note)}
								x="4"
								y={row * rowHeight + rowHeight - Math.max(2, (rowHeight - 9) / 2)}
								data-testid={`key-name-${note}`}>{keyText(sounds, note)}</text
							>{:else if note % 12 === 0}<text class="octave" x="4" y={row * rowHeight + rowHeight - 2}
								>{noteName(note)}</text
							>{/if}
					{/each}
				</svg>
				<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
				<svg
					bind:this={roll}
					{width}
					height={rollHeight}
					role="application"
					aria-label="Piano roll"
					tabindex="0"
					data-testid="roll"
					data-per-tick={perTick}
					data-row-height={rowHeight}
					onkeydown={keydown}
					onpointermove={hover}
					onpointerleave={() => (ghost = null)}
					oncontextmenu={rollMenu}
				>
					{#each { length: 128 }, row}
						<rect
							class="lane"
							class:black={isBlackKey(127 - row)}
							class:nosound={silentKey(127 - row)}
							y={row * rowHeight}
							{width}
							height={rowHeight}
							role="presentation"
							onpointerdown={pressGround}
							ondblclick={doubleGround}
						/>
					{/each}
					{#each beatLines as line (line.tick)}
						<line
							class:bar={line.bar}
							class="beat"
							x1={line.tick * perTick}
							x2={line.tick * perTick}
							y1="0"
							y2={rollHeight}
						/>
					{/each}
					<rect
						class="past"
						x={shown.length * perTick}
						width={Math.max(0, width - shown.length * perTick)}
						height={rollHeight}
					/>
					{#each shown.notes as note, index (index)}
						<g
							class="note"
							class:chosen={chosen.has(index)}
							class:nosound={silentKey(note.note)}
							data-testid={`note-${index}`}
							data-tick={note.tick}
							data-note={note.note}
							data-dur={note.dur}
							data-vel={note.vel}
							data-slot={note.slot ?? 0}
							data-sound={sounds ? (sounds.get(note.note)?.name ?? '') : undefined}
						>
							<rect
								class="body"
								x={note.tick * perTick}
								y={rowOf(note.note) + 1}
								width={Math.max(note.dur * perTick, 3)}
								height={rowHeight - 2}
								rx="2"
								style:fill-opacity={0.45 + (0.55 * note.vel) / 127}
								role="presentation"
								onpointerdown={(event) => pressNote(event, index, 'move')}
								oncontextmenu={(event) => noteMenu(event, index)}
								>{#if silentKey(note.note)}<title
										>{`The kit has no sound on ${note.note}, so this note keeps slot ${(note.slot ?? 0) + 1} of its track`}</title
									>{/if}</rect
							>
							{#if !readonly}
								<rect
									class="edge"
									x={Math.max(note.dur * perTick, 3) + note.tick * perTick - EDGE}
									y={rowOf(note.note) + 1}
									width={EDGE}
									height={rowHeight - 2}
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
							height={rollHeight}
							role="presentation"
							data-testid="clip-end"
							onpointerdown={(event) => {
								event.stopPropagation();
								gesture = { kind: 'length', clip };
							}}
						/>
					{/if}
					{#if ghost && !gesture && stepping}
						<line class="aim" x1={ghost.tick * perTick} x2={ghost.tick * perTick} y1="0" y2={rollHeight} />
					{:else if ghost && !gesture}
						<rect
							class="ghost"
							x={ghost.tick * perTick}
							y={rowOf(ghost.note) + 1}
							width={Math.max(draw * perTick, 3)}
							height={rowHeight - 2}
							rx="2"
						/>
					{/if}
					{#if ghostLabel}
						{@const at = gesture?.kind === 'draw' ? gesture.note : { ...ghost!, dur: draw }}
						<text
							class="ghost-label"
							x={(at.tick + at.dur) * perTick + 6}
							y={rowOf(at.note) + rowHeight - 2}
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
						<line class="playhead" x1={playhead * perTick} x2={playhead * perTick} y1="0" y2={rollHeight} />
					{/if}
					{#if stepping}
						<!-- What the keys held down will write, which goes into the clip once the last of them is let go -->
						{#each chord?.notes ?? [] as note (note.note)}
							<rect
								class="pending"
								x={note.tick * perTick}
								y={rowOf(note.note) + 1}
								width={Math.max(note.dur * perTick, 3)}
								height={rowHeight - 2}
								rx="2"
								data-testid="step-note"
							/>
						{/each}
						<line
							class="cursor"
							x1={cursor.tick * perTick}
							x2={cursor.tick * perTick}
							y1="0"
							y2={rollHeight}
							data-testid="step-cursor"
							data-tick={cursor.tick}
						/>
					{/if}
				</svg>
			</div>
		</div>
	</div>
	{#if offer}
		<div class="notice" role="alert" data-testid="lengthen-offer">
			<span>Growing this clip to {barsText(offer.length)} would run it into the next clip on its track.</span>
			<button type="button" onclick={lengthen}>Lengthen to {barsText(offer.length)}</button>
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
		label={menu.ground ? 'Piano roll' : chosen.size > 1 ? `${chosen.size} notes` : 'Note'}
		items={menu.ground ? groundItems(menu.key) : noteItems()}
		note={readonly ? EXAMPLE_NOTE : undefined}
		onclose={() => (menu = null)}
	/>
{/if}

<div class="below" use:follows>
	<div style:width="{KEYS + width}px" style:padding-left="{KEYS}px" style:box-sizing="border-box">
		{#if velocityShown}
			<svg
				{width}
				height={VELOCITY}
				role="application"
				aria-label="Velocity"
				data-testid="velocity"
				onpointerdown={pressStrip}
				oncontextmenu={velocityMenu}
			>
				<rect class="strip" {width} height={VELOCITY} />
				{#each stems as { note, index } (index)}
					{@const height = (note.vel / 127) * VELOCITY}
					{@const x = note.tick * perTick}
					{@const across = Math.max(note.dur * perTick, 3)}
					<g class="stem" class:chosen={chosen.has(index)} data-index={index}>
						<rect
							class="velocity"
							style:fill-opacity={0.12 + (0.5 * note.vel) / 127}
							{x}
							y={VELOCITY - height}
							width={across}
							{height}
							role="presentation"
							data-testid={`velocity-${index}`}
							data-vel={note.vel}><title>{`Velocity ${note.vel}`}</title></rect
						>
						<rect class="cap" {x} y={VELOCITY - height} width={across} height="2" />
					</g>
				{/each}
				{#if gesture?.kind === 'velocity'}
					<!-- What the drag sets, beside the pointer, as a fader says its level while it moves. -->
					{@const value = velocityAt(gesture.at.y)}
					<text
						class="velreadout"
						x={Math.min(gesture.at.x + 8, Math.max(0, width - 24))}
						y={Math.max(11, Math.min(VELOCITY - 3, gesture.at.y - 4))}
						data-testid="velocity-readout">{value}</text
					>
				{/if}
			</svg>
		{/if}
		{#if lanesShown}
			{#each lanes as lane, index (lane.key)}
				{@const about = describeLane(lane, choices)}
				<AutomationLane
					{clip}
					{lane}
					label={about.label}
					min={about.min}
					max={about.max}
					start={about.start}
					{ppq}
					{bars}
					{perTick}
					{width}
					{grid}
					{readonly}
					testid={`lane-${index}`}
					{onchange}
					{onsay}
					onremove={() => onchange(removeLane(clip, lane.key))}
				/>
			{/each}
		{/if}
	</div>
</div>

<div class="toolbar">
	<button
		type="button"
		class="foldbelow"
		aria-expanded={velocityShown}
		title={velocityShown ? 'Fold the velocity strip, for more room for notes' : 'Show the velocity strip'}
		onclick={() => foldBelow('velocity')}><span aria-hidden="true">{velocityShown ? '▾' : '▸'}</span> Velocity</button
	>
	<button
		type="button"
		class="foldbelow"
		aria-expanded={lanesShown}
		disabled={!lanes.length}
		title={lanesShown ? 'Fold the lanes, for more room for notes' : 'Show the lanes'}
		onclick={() => foldBelow('lanes')}
		><span aria-hidden="true">{lanesShown ? '▾' : '▸'}</span> Lanes{lanes.length ? ` ${lanes.length}` : ''}</button
	>
	{#if !readonly && free.length}
		<select
			aria-label="Add a lane"
			value=""
			onchange={(e) => {
				void addLane(e.currentTarget.value);
				e.currentTarget.value = '';
			}}
		>
			<option value="">Add a lane…</option>
			{#each laneGroups as [group, list] (group)}
				<optgroup label={group}>
					{#each list as choice (choice.key)}
						{@const waits = silent && !!choice.reaches}
						<option value={choice.key} disabled={waits}>{choice.name}{waits ? ' (after a note)' : ''}</option>
					{/each}
				</optgroup>
			{/each}
		</select>
		{#if silent && free.some((choice) => choice.reaches)}
			<span class="muted" title={SILENT_HINT} data-testid="lane-waits">{SILENT_HINT}</span>
		{:else}
			<span class="muted" title={LANE_HINT}>{LANE_HINT}</span>
		{/if}
	{/if}
</div>

<style>
	/* One line, whatever is chosen: a click that adds a note chooses it, and if the hint gave way to taller fields, the roll
	   would move under the pointer, and a double-click's second click would land on another row. What doesn't fit scrolls. */
	.toolbar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 2rem;
		font-size: 0.8rem;
		flex-wrap: nowrap;
		overflow-x: auto;
		scrollbar-width: thin; /* What doesn't fit, with the browser and the inspector open, is shown to be there */
		margin: 0.2rem 0;
	}
	.toolbar button {
		padding: 0 0.5rem;
	}
	/* In the tab strip, it takes the strip's height and what width the tabs leave. */
	.toolbar.top {
		flex: 1 1 0;
		height: 100%;
		margin: 0;
		min-width: 0;
	}
	.toolbar > * {
		flex: none;
	}
	/* A hint, the lane bar's too, is cut short where the roll is narrow. */
	.toolbar > .hint,
	.toolbar > .muted {
		flex: 1 1 0;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
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
		flex-direction: column;
	}
	.rows {
		display: flex;
	}
	.rule {
		position: sticky;
		top: 0;
		z-index: 2; /* Over the keys, which stay at the left */
		display: flex;
	}
	.rule .corner {
		position: sticky;
		left: 0;
		z-index: 1;
		flex: none;
		background: var(--panel);
		border-bottom: 1px solid var(--line);
		box-sizing: border-box;
	}
	.ruler .ground {
		fill: var(--panel);
	}
	.ruler .past {
		fill: #0d1117a0;
	}
	.ruler line {
		stroke: #484f58;
	}
	.ruler .bar {
		stroke: #6e7681;
	}
	.ruler text {
		fill: var(--muted);
		font-size: 10px;
	}
	.ruler .beatno {
		opacity: 0.7;
	}
	.ruler .playhead {
		stroke: #f0883e;
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
	/* A kit's keys, each named by its sound, and those it has no sound for dimmed, as the rows beside them are. */
	.kitname {
		fill: #0d1117;
		font-size: 9px;
		pointer-events: none;
	}
	.kitname.black {
		fill: #c9d1d9;
	}
	.key.nosound {
		opacity: 0.3;
	}
	.sound {
		flex: none;
		color: var(--text);
	}
	.sound.none {
		color: var(--muted);
		font-style: italic;
	}
	.lane {
		fill: #0d1117;
		stroke: #161b22;
		stroke-width: 0.5;
	}
	.lane.black {
		fill: #0a0d12;
	}
	.lane.nosound {
		fill: #07090c;
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
	/* A note on a key the kit has no sound for: greyed and dashed, as it plays nothing the kit means it to. */
	.note.nosound .body {
		fill: #6e7681;
		stroke: #c9d1d9;
		stroke-dasharray: 3 2;
	}
	.note.nosound.chosen .body {
		fill: #9a6a43;
	}
	.velreadout {
		fill: var(--text);
		font-size: 11px;
		pointer-events: none;
		paint-order: stroke;
		stroke: #0d1117;
		stroke-width: 3px;
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
	.cursor {
		stroke: #3fb950;
		stroke-width: 2;
		pointer-events: none;
	}
	.aim {
		stroke: #3fb95080;
		stroke-dasharray: 3 3;
		pointer-events: none;
	}
	.pending {
		fill: #3fb950;
		stroke: #0d1117;
		pointer-events: none;
	}
	.at {
		flex: none;
		color: #3fb950;
		font-variant-numeric: tabular-nums;
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
	.foldbelow {
		flex: none;
		padding: 0.1rem 0.4rem;
		font-size: 0.72rem;
		color: var(--muted);
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
	/* A stem's shade says how loud it is, as its height does, so the stems of a chord, which overlap, still read apart. */
	.strip {
		fill: transparent;
	}
	.velocity {
		fill: #2f81f7;
		cursor: ns-resize;
	}
	.cap {
		fill: #58a6ff;
		pointer-events: none;
	}
	.stem.chosen .velocity {
		fill: #f0883e;
	}
	.stem.chosen .cap {
		fill: #f0883e;
	}
</style>
