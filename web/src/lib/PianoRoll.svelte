<script lang="ts">
	import { onDestroy, onMount, tick as settle, untrack } from 'svelte';
	import { on } from 'svelte/events';
	import AutomationLane from '#lib/AutomationLane.svelte';
	import { clipboard } from '#lib/Clipboard.ts';
	import ContextMenu, { type MenuItem } from '#lib/ContextMenu.svelte';
	import { FOLLOW_MARGIN, followScroll } from '#lib/Follow.ts';
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
		stepBack,
		write,
		type Chord,
		type Cursor
	} from '#lib/StepEntry.ts';
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
		noteSpan,
		noteValue,
		pasteAt,
		pasteNotes,
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
		onview = () => {}
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
		onview?: (view: RollView, zoomed: boolean) => void; // As it scrolls, and as someone zooms it, which `zoomed` says
	} = $props();

	const KEYS = 48;
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
	let beatWidth = $state(untrack(() => view?.beat ?? 64));
	let rowHeight = $state(untrack(() => view?.row ?? ROW)); // A row is a semitone, a whole number of pixels high
	let rowAim = untrack(() => rowHeight); // What a slow pinch is making the rows, a little at a time, before it is rounded
	const rollHeight = $derived(128 * rowHeight);
	let chosen = $state.raw(new Set<number>());
	let gesture = $state.raw<Gesture | null>(null);
	let ghost = $state.raw<{ tick: number; note: number } | null>(null); // The empty cell under the pointer
	let menu = $state.raw<{ x: number; y: number } | null>(null);
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
	const bar = $derived(ticksPerBar({ ppq }));
	const shown = $derived(gesture && 'clip' in gesture ? gesture.clip : clip);
	const widthTicks = $derived(
		Math.max(
			shown.length + PAST_BARS * bar,
			...shown.notes.map((n) => n.tick + n.dur + ppq),
			stepping ? Math.max(cursor.tick, chord ? chordEnd(chord) : 0) + bar : 0
		)
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

	const rowOf = (note: number) => (127 - note) * rowHeight;
	const noteAt = (y: number) => Math.min(127, Math.max(0, 127 - Math.floor(y / rowHeight)));

	// The cell under the pointer, at the line of the grid before it, which is where a click puts a note.
	function cellAt(event: { clientX: number; clientY: number }) {
		const at = canvas(event);
		return { tick: Math.max(0, Math.floor(at.x / perTick / grid) * grid), note: noteAt(at.y) };
	}

	// The line of the grid nearest the pointer, which is where a click in step entry puts the cursor.
	function lineAt(event: { clientX: number; clientY: number }) {
		const at = canvas(event);
		return { tick: snapTick(at.x / perTick, grid), note: noteAt(at.y) };
	}

	// A right-click chooses what it is on and opens its menu, and Ctrl-click is a right-click on a Mac, so neither drags.
	const secondary = (event: PointerEvent) => event.button !== 0 || (event.ctrlKey && modKey() === 'Meta');

	const describe = (note: Pick<Note, 'tick' | 'note' | 'dur'>) =>
		`${noteName(note.note)} · ${noteValue(note.dur, ppq)} · ${position(note.tick, ppq)}`;

	// What the ghost says: the note a click would add, or the one being drawn. Past the end it says what that does to the clip.
	const ghostLabel = $derived.by(() => {
		const note = gesture?.kind === 'draw' ? gesture.note : ghost && !stepping && { ...ghost, dur: draw };
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
		const grown = growToHold(clip, note.tick, ppq);
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
		if (grows) tell(`Clip is now ${bars(grown.length)}`);
	}

	function lengthen() {
		if (!offer) return;
		const { note, step } = offer;
		const length = Math.max(clip.length, offer.length);
		offer = null;
		if (step) {
			// The step that was refused is written after all, and the cursor moves on past it.
			const written = write({ ...clip, length }, cursor, { start: note.tick, notes: [note], held: [] }, ppq);
			chosen = new Set();
			moveCursor(written.cursor);
			onchange(written.clip);
		} else {
			draw = note.dur;
			chosen = new Set([clip.notes.length]);
			onchange(addNote({ ...clip, length }, note));
		}
		tell(`Clip is now ${bars(length)}`);
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
		const wanted = snapTick(anchor.tick + (at.x - g.from.x) / perTick, grid) - anchor.tick;
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

	// Notes a duplicate or a paste put past the clip's end grow it to the bar that holds the last of them, as a note put there
	// does, unless that would run a placement of the clip into the next one. Then they wait past the end, dimmed, as before.
	function withRoom(next: Clip) {
		const grown = growToHold(next, Math.max(...next.notes.map((n) => n.tick)), ppq);
		const grows = grown !== next && cangrow(grown.length);
		onchange(grows ? grown : next);
		if (grows) tell(`Clip is now ${bars(grown.length)}`);
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
		} else if (by('escape')) {
			// Expand is the editor's to leave, so Esc goes on to it then.
			if (escape()) event.preventDefault();
		} else if (by('roll.up') || by('roll.down') || by('roll.octave-up') || by('roll.octave-down')) {
			event.preventDefault();
			nudge(0, (event.code === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 12 : 1));
		} else if (by('roll.earlier') || by('roll.later')) {
			event.preventDefault();
			nudge((event.code === 'ArrowLeft' ? -1 : 1) * grid, 0);
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
		const grown = growToHold(clip, tick, ppq);
		if (grown === clip || cangrow(grown.length)) return true;
		offer = { note, length: grown.length, step: true };
		return false;
	}

	function writeChord(done: Chord) {
		chord = null;
		if (!done.notes.length || !mayWrite(done.start, done.notes[0])) return;
		const grows = growToHold(clip, done.start, ppq) !== clip; // Asked before the change, which reaches `clip` at once
		const written = write(clip, cursor, done, ppq);
		chosen = new Set(); // A note it replaces moves the others' places
		moveCursor(written.cursor);
		onchange(written.clip);
		if (grows) tell(`Clip is now ${bars(written.clip.length)}`);
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

	// Keeps the cursor and what is written after it in sight, and a note being written.
	function reveal(tick: number, note?: number) {
		if (!scroller) return;
		const x = tick * perTick;
		const width = scroller.clientWidth - KEYS;
		if (x < scroller.scrollLeft || x + draw * perTick > scroller.scrollLeft + width)
			scroller.scrollLeft = Math.max(0, x - FOLLOW_MARGIN);
		if (note === undefined) return;
		const y = rowOf(note);
		if (y < scroller.scrollTop || y + rowHeight > scroller.scrollTop + scroller.clientHeight)
			scroller.scrollTop = y - scroller.clientHeight / 2;
	}

	// Step entry's keys, while it is on, wherever focus is but a field, a menu, a dialog or the browser, which keep their own.
	// The roll and the arrangement would move or delete what is chosen with → and Backspace, so these are heard first, on the
	// way down, and go no further. Esc goes no further either, so one press leaves one thing.
	function stepKeys(event: KeyboardEvent) {
		if (!stepping || readonly || !active) return;
		const target = event.target as Element | null;
		if (typingIn(target) || target?.closest?.('[role="menu"], dialog, nav')) return;
		if (matches(event, 'step.rest')) {
			offer = null;
			if (chord) chord = lengthenHeld(chord, grid);
			else moveCursor(rest(cursor, draw));
		} else if (matches(event, 'step.back')) {
			offer = null;
			// With keys still down, it drops what they would have written.
			if (chord) chord = null;
			else stepBackOnce();
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
		{ label: 'Duplicate', action: duplicate }
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

	// A zoom to `beat` pixels a beat and `row` pixels a row, which keeps the tick and the note under the pointer where they
	// were. Without a pointer it keeps the left edge and the middle row.
	async function zoom(beat: number, row: number, pointer?: { clientX: number; clientY: number }) {
		const box = scroller.getBoundingClientRect();
		const x = pointer ? pointer.clientX - box.left : KEYS;
		const y = pointer ? pointer.clientY - box.top : scroller.clientHeight / 2;
		const [left, top] = [scroller.scrollLeft, scroller.scrollTop];
		const across = clampBeat(beat) / beatWidth;
		rowAim = Math.min(ROWS.most, Math.max(ROWS.least, row));
		const down = Math.round(rowAim) / rowHeight;
		beatWidth = clampBeat(beat);
		rowHeight = Math.round(rowAim);
		await settle(); // The roll is its new size before it scrolls
		scroller.scrollLeft = anchored(left, x, across, KEYS);
		scroller.scrollTop = anchored(top, y, down);
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
		const fitted = fitRoll(clip, ppq, { width: scroller.clientWidth - KEYS, height: scroller.clientHeight }, rowHeight);
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
		scroller.scrollTop = rowOf(middle) - scroller.clientHeight / 2;
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

<div class="toolbar">
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
		<span class="at" data-testid="step-at">Step at {position(cursor.tick, ppq)}</span>
	{/if}
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
	{:else if stepping}
		{@const hint = `Keys write at the cursor, as long as Draw. Hold keys for a chord, and → while holding makes them longer. → rests, Backspace steps back, a click moves the cursor, and Esc leaves.`}
		<span class="muted hint" title={hint}>{hint}</span>
	{:else if !readonly}
		{@const hint = `Click to add a note, and drag to set its length. Drag a note to move it, its end to resize it, and hold ${mod} to copy it. Delete or a right-click removes it. Shift-drag selects, and arrows nudge.`}
		<span class="muted hint" title={hint}>{hint}</span>
	{/if}
</div>

<div class="frame">
	<div class="roll" bind:this={scroller} onscroll={scrolled} onwheel={wheel}>
		<div class="inner" style:width="{KEYS + width}px">
			<svg class="keys" width={KEYS} height={rollHeight} aria-hidden="true">
				{#each { length: 128 }, row}
					{@const note = 127 - row}
					<rect
						class="key"
						class:black={isBlackKey(note)}
						y={row * rowHeight}
						width={KEYS}
						height={rowHeight}
						role="presentation"
						data-testid={`key-${note}`}
						onpointerdown={(event) => pressKey(event, note)}
					/>
					{#if note % 12 === 0}<text class="octave" x="4" y={row * rowHeight + rowHeight - 2}>{noteName(note)}</text
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
						y={row * rowHeight}
						{width}
						height={rowHeight}
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
							height={rowHeight - 2}
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
		scrollbar-width: none;
		margin: 0.2rem 0;
	}
	.toolbar button {
		padding: 0 0.5rem;
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
