<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { on } from 'svelte/events';
	import type { Key } from '#lib/KeySignature.ts';
	import {
		signatureOf,
		spell,
		spellingText,
		transcribe,
		type Clef,
		type Event,
		type Letter,
		type Measure,
		type Score
	} from '#lib/Notation.ts';
	import { matches, typingIn } from '#lib/Shortcuts.ts';
	import {
		START,
		chordEnd,
		lengthen as lengthenHeld,
		moveTo,
		press,
		release,
		repitch,
		rest,
		stepBack,
		write,
		type Chord,
		type Cursor
	} from '#lib/StepEntry.ts';
	import type { Bars } from '#lib/TimeSignature.ts';
	import { addNote, growToHold, moveNotes, removeNotes, type Clip, type Note } from '#lib/TimelineEdit.ts';
	import { noteValue } from '#lib/Units.ts';

	// A clip's notes as a score, beside the roll as a view of the same notes: Notation.ts says what is written, and this draws
	// it with VexFlow, which is loaded with its music font, Bravura, the first time a score is shown, from the app itself. Systems
	// wrap to the width there is, each starting with its clefs and key, and a click on a note chooses it and says what it is. The
	// score is a reading of the notes, so a note played a little early reads as on the beat, while the roll shows where it is.
	//
	// Notes go in as a score editor takes them. A click on a line or a space adds that note, in the key, as long as the Draw
	// length and on the notes' Snap, and a ghost under the pointer says what a click would add. A click on a note chooses it,
	// ↑ and ↓ move what is chosen a semitone, or an octave with Shift, ← and → a Snap step, and Delete takes it away. Step entry
	// writes at a cursor on the staff with the piano keys, as it does in the roll (StepEntry.ts), and a click there moves it.
	let {
		clip,
		bars,
		keyAt,
		playhead = null,
		playing = false,
		chosen = new Set<number>(),
		draw = 480,
		velocity = 100,
		grid = 120,
		readonly = false,
		active = true,
		stepping = $bindable(false),
		cursors = new Map<string, Cursor>(),
		canAudition = false,
		cangrow = () => true,
		onchoose = () => {},
		onchange = () => {},
		onaudition = () => {},
		onsay = () => {}
	}: {
		clip: Clip;
		bars: Bars; // The song's bars in the clip's own ticks (TimeSignature.ts)
		keyAt: (tick: number) => Key; // The key at a tick of the clip
		playhead?: number | null; // In ticks from the clip's start
		playing?: boolean; // Whether the song is playing, which the score follows while it plays this clip
		chosen?: ReadonlySet<number>; // Indices into the clip's notes
		draw?: number; // How long a note added is, in ticks: the Draw length
		velocity?: number;
		grid?: number; // The notes' Snap, in ticks
		readonly?: boolean;
		active?: boolean; // Whether keys are for the score, which they are while the Song view is on screen
		stepping?: boolean;
		cursors?: Map<string, Cursor>; // Step entry's cursor in each clip, shared with the roll
		canAudition?: boolean;
		cangrow?: (length: number) => boolean; // Whether the clip can be this long without running into the clip after it
		onchoose?: (indices: Set<number>) => void;
		onchange?: (clip: Clip) => void;
		onaudition?: (note: number, on: boolean) => void;
		onsay?: (text: string) => void;
	} = $props();

	const AUDITION_MS = 250;

	type VexFlow = typeof import('vexflow/bravura');

	const STAFF = 80; // From one staff's top line to the next staff's in a system
	const SYSTEM_GAP = 50; // Below a system, before the next
	const TOP = 30;
	const LEFT = 10;
	const DURATIONS: Record<number, string> = { 1: 'w', 2: 'h', 4: 'q', 8: '8', 16: '16', 32: '32', 64: '64' };
	const MAJOR_SPECS = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
	const MINOR_SPECS = [
		'Abm',
		'Ebm',
		'Bbm',
		'Fm',
		'Cm',
		'Gm',
		'Dm',
		'Am',
		'Em',
		'Bm',
		'F#m',
		'C#m',
		'G#m',
		'D#m',
		'A#m'
	];
	const keySpec = (key: Key) => (key.minor ? MINOR_SPECS : MAJOR_SPECS)[key.fifths + 7];

	let width = $state(0);
	let vexflow = $state.raw<VexFlow | null>(null);
	let failed = $state<string | null>(null);
	// Where each measure was drawn, for the playhead: its ticks, where its notes start and end across, its system's top and
	// height, and where each event in it landed.
	type Placed = {
		start: number;
		end: number;
		x0: number;
		x1: number;
		y: number;
		height: number;
		at: [number, number][];
		staves: { clef: Clef; top: number; spacing: number }[]; // Each staff's top line, and the space between its lines
	};
	let placed = $state.raw<Placed[]>([]);
	let height = $state(0);
	let drawn = $state(0); // How many times it has been drawn, which a test waits on

	const written = $derived(transcribe(clip, bars, { keyAt }));

	onMount(() => {
		let gone = false;
		void (async () => {
			try {
				const loaded = await import('vexflow/bravura');
				await document.fonts.load('30px Bravura');
				if (!gone) vexflow = loaded;
			} catch (error) {
				failed = error instanceof Error ? error.message : String(error);
			}
		})();
		return () => (gone = true);
	});

	// The page is VexFlow's to draw into, and is drawn again whenever what it shows changes.
	function engrave(page: HTMLElement) {
		if (!vexflow || width <= 0) return;
		engraveInto(page, vexflow, written, width, chosen);
	}

	// How wide a measure's notes want to be: room for its most crowded voice.
	function contentWidth(measure: Measure) {
		const most = Math.max(1, ...measure.voices.flat().map((voice) => voice.filter((e) => !e.hidden).length));
		return 36 + 30 * most;
	}

	function engraveInto(host: HTMLElement, vf: VexFlow, score: Score, available: number, picked: ReadonlySet<number>) {
		const {
			Renderer,
			Stave,
			StaveNote,
			GhostNote,
			Voice,
			Formatter,
			Beam,
			Tuplet,
			StaveTie,
			Accidental,
			Dot,
			StaveConnector
		} = vf;
		host.replaceChildren();
		const colour = getComputedStyle(host).color;
		const accent = getComputedStyle(host).getPropertyValue('--accent').trim() || '#58a6ff';
		const staves = score.clefs.length;
		const systemHeight = STAFF * staves + SYSTEM_GAP;
		const usable = Math.max(200, available - 2 * LEFT);

		// What a measure starting a system, or changing meter or key, puts before its notes.
		const probe = (measure: Measure, first: boolean) => {
			const stave = new Stave(0, 0, 400);
			if (first) stave.addClef(score.clefs[0]).addKeySignature(keySpec(measure.key));
			else if (measure.keyShown) stave.addKeySignature(keySpec(measure.key));
			if (measure.meterShown) stave.addTimeSignature(`${measure.meter.beats}/${measure.meter.unit}`);
			return stave.getNoteStartX() + 8;
		};

		// The systems: measures in rows as wide as the view, each row's measures widened to fill it, but the last.
		const rows: { measures: Measure[]; widths: number[] }[] = [];
		let row: { measures: Measure[]; widths: number[] } = { measures: [], widths: [] };
		for (const measure of score.measures) {
			const first = row.measures.length === 0;
			const want = contentWidth(measure) + probe(measure, first);
			const used = row.widths.reduce((a, b) => a + b, 0);
			if (!first && used + want > usable) {
				rows.push(row);
				row = { measures: [], widths: [] };
				row.measures.push(measure);
				row.widths.push(contentWidth(measure) + probe(measure, true));
			} else {
				row.measures.push(measure);
				row.widths.push(want);
			}
		}
		if (row.measures.length) rows.push(row);
		rows.forEach((r, index) => {
			const used = r.widths.reduce((a, b) => a + b, 0);
			const scale = index < rows.length - 1 ? usable / used : Math.min(1.4, usable / used);
			r.widths = r.widths.map((w) => w * scale);
		});

		height = TOP + rows.length * systemHeight;
		const renderer = new Renderer(host as HTMLDivElement, Renderer.Backends.SVG);
		renderer.resize(available, height);
		const context = renderer.getContext();
		context.setFillStyle(colour);
		context.setStrokeStyle(colour);

		// Each voice's notes in order across the whole score, for the ties between them.
		const lines = new Map<string, { event: Event; note: InstanceType<typeof StaveNote> | null; row: number }[]>();
		const where: Placed[] = [];

		rows.forEach((r, rowIndex) => {
			let x = LEFT;
			const y = TOP + rowIndex * systemHeight;
			r.measures.forEach((measure, column) => {
				const w = r.widths[column];
				const first = column === 0;
				const measureStaves = score.clefs.map((clef, staff) => {
					const stave = new Stave(x, y + staff * STAFF, w);
					// Each system says which bar it starts with, counted as the roll counts them.
					if (first && staff === 0) stave.setMeasure(measure.number);
					if (first) stave.addClef(clef).addKeySignature(keySpec(measure.key));
					else if (measure.keyShown) stave.addKeySignature(keySpec(measure.key));
					if (measure.meterShown) stave.addTimeSignature(`${measure.meter.beats}/${measure.meter.unit}`);
					return stave;
				});
				const start = Math.max(...measureStaves.map((s) => s.getNoteStartX()));
				for (const stave of measureStaves) stave.setNoteStartX(start);
				for (const stave of measureStaves) stave.setContext(context).draw();
				if (staves > 1) {
					const [upper, lower] = measureStaves;
					if (first) {
						new StaveConnector(upper, lower).setType('brace').setContext(context).draw();
						new StaveConnector(upper, lower).setType('singleLeft').setContext(context).draw();
					}
					new StaveConnector(upper, lower).setType('singleRight').setContext(context).draw();
				}

				const allVoices: InstanceType<typeof Voice>[] = [];
				const beams: InstanceType<typeof Beam>[] = [];
				const tuplets: InstanceType<typeof Tuplet>[] = [];
				const perStaff: InstanceType<typeof Voice>[][] = [];
				measure.voices.forEach((voices, staff) => {
					const clef: Clef = score.clefs[staff];
					const staffVoices: InstanceType<typeof Voice>[] = [];
					voices.forEach((events, line) => {
						const stem = voices.length > 1 ? (line % 2 === 0 ? 1 : -1) : undefined;
						const notes = events.map((event) => {
							const duration = DURATIONS[event.value.base] ?? 'q';
							if (event.hidden) return new GhostNote({ duration, dots: event.value.dots });
							const rest = !event.pitches.length;
							const keys = rest
								? [clef === 'treble' ? 'b/4' : 'd/3']
								: event.pitches.map(({ spelling }) => {
										const marks = spelling.alter > 0 ? '#'.repeat(spelling.alter) : 'b'.repeat(-spelling.alter);
										return `${spelling.letter.toLowerCase()}${marks}/${spelling.octave}`;
									});
							const note = new StaveNote({
								keys,
								duration: event.whole ? 'w' : duration,
								dots: event.value.dots,
								type: rest ? 'r' : undefined,
								clef,
								alignCenter: event.whole,
								...(stem !== undefined && { stemDirection: stem })
							});
							if (event.value.dots) Dot.buildAndAttach([note], { all: true });
							if (event.pitches.some((p) => picked.has(p.index)))
								note.setStyle({ fillStyle: accent, strokeStyle: accent });
							return note;
						});
						// Triplets go in threes of the beat they fill.
						for (const beat of measure.triplets) {
							const group = notes.filter(
								(_, i) =>
									events[i].value.triplet && events[i].start >= beat && events[i].start < beat + bars.at(beat).beat
							);
							if (group.length) tuplets.push(new Tuplet(group, { numNotes: 3, notesOccupied: 2, bracketed: true }));
						}
						const voice = new Voice({ numBeats: measure.meter.beats, beatValue: measure.meter.unit }).setMode(
							Voice.Mode.SOFT
						);
						voice.addTickables(notes);
						staffVoices.push(voice);
						const key = `${staff}:${line}`;
						const list = lines.get(key) ?? [];
						events.forEach((event, i) =>
							list.push({
								event,
								note: event.hidden ? null : (notes[i] as InstanceType<typeof StaveNote>),
								row: rowIndex
							})
						);
						lines.set(key, list);
						const beamable = notes.filter((n): n is InstanceType<typeof StaveNote> => n instanceof StaveNote);
						beams.push(
							...Beam.generateBeams(beamable, {
								groups: Beam.getDefaultBeamGroups(`${measure.meter.beats}/${measure.meter.unit}`),
								...(stem !== undefined && { stemDirection: stem, maintainStemDirections: true })
							})
						);
					});
					Accidental.applyAccidentals(staffVoices, keySpec(measure.key));
					perStaff.push(staffVoices);
					allVoices.push(...staffVoices);
				});
				const formatter = new Formatter();
				for (const staffVoices of perStaff) formatter.joinVoices(staffVoices);
				formatter.format(allVoices, Math.max(20, measureStaves[0].getNoteEndX() - start - 10));
				perStaff.forEach((staffVoices, staff) => {
					for (const voice of staffVoices) voice.draw(context, measureStaves[staff]);
				});
				for (const beam of beams) beam.setContext(context).draw();
				for (const tuplet of tuplets) tuplet.setContext(context).draw();

				const at: [number, number][] = [];
				for (const [key, list] of lines) {
					if (!key.startsWith('0:')) continue;
					for (const item of list) {
						if (
							item.row === rowIndex &&
							item.note &&
							item.event.start >= measure.start &&
							item.event.start < measure.end
						) {
							at.push([item.event.start, item.note.getAbsoluteX()]);
						}
					}
				}
				at.sort((a, b) => a[0] - b[0]);
				where.push({
					start: measure.start,
					end: measure.end,
					x0: start,
					x1: x + w,
					y,
					height: STAFF * staves,
					at,
					staves: measureStaves.map((stave, staff) => ({
						clef: score.clefs[staff],
						top: stave.getYForLine(0),
						spacing: stave.getSpacingBetweenLines()
					}))
				});
				x += w;
			});
		});

		// The ties, from a note to the next in its voice, across a bar line, and in halves across a system's end.
		for (const list of lines.values()) {
			list.forEach((item, i) => {
				const next = list[i + 1];
				if (!item.event.tieOut || !item.note || !next?.note) return;
				const indexes = item.event.pitches.map((_, k) => k);
				if (next.row === item.row) {
					new StaveTie({ firstNote: item.note, lastNote: next.note, firstIndexes: indexes, lastIndexes: indexes })
						.setContext(context)
						.draw();
				} else {
					new StaveTie({ firstNote: item.note, firstIndexes: indexes }).setContext(context).draw();
					new StaveTie({ lastNote: next.note, lastIndexes: indexes }).setContext(context).draw();
				}
			});
		}

		// Each note says which of the clip's notes it writes, for a click, a test and a screen reader.
		for (const list of lines.values()) {
			for (const { event, note } of list) {
				if (!note || !event.pitches.length) continue;
				const element = note.getSVGElement();
				if (!element) continue;
				element.classList.add('written');
				element.setAttribute('data-notes', event.pitches.map((p) => p.index).join(' '));
				element.setAttribute('data-start', String(event.start));
				const names = event.pitches.map((p) => spellingText(p.spelling)).join(', ');
				element.setAttribute(
					'aria-label',
					`${names} · ${noteValue(event.length, bars.ppq)} · ${bars.position(event.start)}`
				);
			}
		}
		placed = where;
		drawn = untrack(() => drawn) + 1;
	}

	// Where a tick is across the score: between the notes either side of it in its measure, as they were spaced.
	function xOf(tick: number): { x: number; measure: Placed } | null {
		const measure = placed.find((m) => tick >= m.start && tick < m.end) ?? null;
		if (!measure) return null;
		const points: [number, number][] = [[measure.start, measure.x0], ...measure.at, [measure.end, measure.x1]];
		for (let i = 0; i < points.length - 1; ++i) {
			const [t0, x0] = points[i];
			const [t1, x1] = points[i + 1];
			if (tick >= t0 && tick <= t1) return { x: t1 > t0 ? x0 + ((tick - t0) / (t1 - t0)) * (x1 - x0) : x0, measure };
		}
		return { x: measure.x0, measure };
	}

	// And back: the tick at a place across a measure.
	function tickAt(measure: Placed, x: number): number {
		const points: [number, number][] = [[measure.start, measure.x0], ...measure.at, [measure.end, measure.x1]];
		if (x <= measure.x0) return measure.start;
		for (let i = 0; i < points.length - 1; ++i) {
			const [t0, x0] = points[i];
			const [t1, x1] = points[i + 1];
			if (x >= x0 && x <= x1) return x1 > x0 ? t0 + ((x - x0) / (x1 - x0)) * (t1 - t0) : t0;
		}
		return measure.end;
	}

	const head = $derived.by(() => {
		if (playhead === null) return null;
		const at = xOf(playhead);
		return at && { x: at.x, y: at.measure.y, height: at.measure.height };
	});

	// While the song plays, the score keeps the playhead's system in sight, as the roll keeps the playhead.
	$effect(() => {
		if (!playing || !head || !scoreElement) return;
		const { scrollTop, clientHeight } = untrack(() => ({
			scrollTop: scoreElement!.scrollTop,
			clientHeight: scoreElement!.clientHeight
		}));
		if (head.y - 20 < scrollTop || head.y + head.height + 20 > scrollTop + clientHeight) {
			scoreElement.scrollTop = Math.max(0, head.y - 30);
		}
	});

	// ------------------------------------------------------------------------------------------------------- adding notes

	const LETTERS: Letter[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
	const NATURAL = [0, 2, 4, 5, 7, 9, 11];
	// The line each clef's top line is, as a step of the scale counted from C0: F5 on the treble staff, A3 on the bass.
	const TOP_LINE: Record<Clef, number> = { treble: 5 * 7 + 3, bass: 3 * 7 + 5 };

	// What is under the pointer: the measure, the tick on Snap, the staff line or space, and the note it is in the key there.
	type Aim = { measure: Placed; tick: number; note: number; x: number; y: number };
	let aim = $state.raw<Aim | null>(null);

	function aimAt(event: { clientX: number; clientY: number }, page: HTMLElement): Aim | null {
		const box = page.getBoundingClientRect();
		const [px, py] = [event.clientX - box.left, event.clientY - box.top];
		const measure = placed.find((m) => px >= m.x0 - 6 && px < m.x1 && py >= m.y - 40 && py < m.y + m.height + 20);
		if (!measure) return null;
		// The staff nearest the pointer, and the line or space on it, a half space at a time.
		const staff = measure.staves.reduce((a, b) =>
			Math.abs(py - (a.top + 2 * a.spacing)) <= Math.abs(py - (b.top + 2 * b.spacing)) ? a : b
		);
		const steps = Math.round((py - staff.top) / (staff.spacing / 2));
		const degree = TOP_LINE[staff.clef] - steps;
		const letter = LETTERS[((degree % 7) + 7) % 7];
		const octave = Math.floor(degree / 7);
		const tick = Math.min(Math.max(measure.start, bars.snap(tickAt(measure, px), grid)), measure.end - 1);
		const alter = signatureOf(keyAt(tick).fifths)[letter];
		const note = (octave + 1) * 12 + NATURAL[LETTERS.indexOf(letter)] + alter;
		if (note < 0 || note > 127) return null;
		const x = xOf(tick)?.x ?? px;
		return { measure, tick, note, x, y: staff.top + (steps * staff.spacing) / 2 };
	}

	function audition(note: number) {
		if (!canAudition) return;
		onaudition(note, true);
		setTimeout(() => onaudition(note, false), AUDITION_MS);
	}

	const describe = (note: Pick<Note, 'tick' | 'note' | 'dur'>) =>
		`${spellingText(spell(note.note, keyAt(note.tick)))} · ${noteValue(note.dur, bars.ppq)} · ${bars.position(note.tick)}`;

	// A note added where it was aimed, which grows the clip if it is past the end, unless that would run it into the next clip.
	function addAt(target: Aim) {
		const note: Note = { tick: target.tick, note: target.note, vel: velocity, dur: draw };
		const grown = growToHold(clip, note.tick, bars);
		if (grown !== clip && !cangrow(grown.length)) {
			onsay("The clip can't grow to hold that note without running into the next clip on its track.");
			return;
		}
		onchange(addNote(grown, note));
		onchoose(new Set([clip.notes.length]));
		audition(note.note);
	}

	function click(event: MouseEvent & { currentTarget: HTMLElement }) {
		scoreElement?.focus({ preventScroll: true });
		const target = (event.target as Element).closest('[data-notes]');
		if (target) {
			const indices = (target.getAttribute('data-notes') ?? '').split(' ').map(Number);
			onchoose(event.shiftKey ? new Set([...chosen, ...indices]) : new Set(indices));
			const first = clip.notes[indices[0]];
			if (first) audition(first.note);
			return;
		}
		const target2 = aimAt(event, event.currentTarget);
		if (stepping && target2) {
			moveCursor(moveTo(target2.tick));
			return;
		}
		if (!target2 || readonly) {
			onchoose(new Set());
			return;
		}
		addAt(target2);
	}

	function hover(event: PointerEvent & { currentTarget: HTMLElement }) {
		const over = (event.target as Element).closest('[data-notes]');
		aim = over ? null : aimAt(event, event.currentTarget);
	}

	// --------------------------------------------------------------------------------------------------- what is chosen

	let scoreElement = $state<HTMLDivElement>();

	function keydown(event: KeyboardEvent) {
		if (readonly && !matches(event, 'escape') && !matches(event, 'select-all')) return;
		const by = (id: Parameters<typeof matches>[1]) => matches(event, id);
		const picked = [...chosen].filter((i) => clip.notes[i]);
		if (by('select-all')) onchoose(new Set(clip.notes.map((_, i) => i)));
		else if (by('escape')) onchoose(new Set());
		else if (!picked.length) return;
		else if (by('roll.delete') || by('roll.backspace')) {
			onchange(removeNotes(clip, new Set(picked)));
			onchoose(new Set());
		} else if (by('roll.up') || by('roll.down') || by('roll.octave-up') || by('roll.octave-down')) {
			const semitones = (event.code === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 12 : 1);
			onchange(moveNotes(clip, new Set(picked), 0, semitones));
			audition(Math.min(127, Math.max(0, clip.notes[picked[0]].note + semitones)));
		} else if (by('roll.earlier') || by('roll.later')) {
			const from = Math.min(...picked.map((i) => clip.notes[i].tick));
			const step = bars.step(from, grid) * (event.code === 'ArrowLeft' ? -1 : 1);
			onchange(moveNotes(clip, new Set(picked), Math.max(-from, step), 0));
		} else return;
		event.preventDefault();
		event.stopPropagation();
	}

	// ------------------------------------------------------------------------------------------------------- step entry

	// Step entry writes as it does in the roll, at the same cursor, which each clip keeps. What can't be written, past the
	// end of a clip that can't grow there, says so and is left unwritten.
	let cursor = $state.raw<Cursor>(untrack(() => cursors.get(clip.id) ?? START));
	let chord = $state.raw<Chord | null>(null);
	const refused = new Set<number>();
	$effect(() => {
		cursor = cursors.get(clip.id) ?? START;
	});

	function moveCursor(next: Cursor) {
		cursor = next;
		cursors.set(clip.id, next);
	}

	function mayWrite(tick: number) {
		const grown = growToHold(clip, tick, bars);
		if (grown === clip || cangrow(grown.length)) return true;
		onsay("The clip can't grow past here without running into the next clip on its track, so nothing was written.");
		return false;
	}

	export function stepKey(note: number, on: boolean) {
		if (!on) {
			if (refused.delete(note) || !chord?.held.includes(note)) return;
			chord = release(chord, note);
			if (!chord.held.length) writeChord(chord);
			return;
		}
		if (!stepping || readonly || !active) return;
		if (!chord && !mayWrite(cursor.tick)) {
			refused.add(note);
			return;
		}
		chord = press(chord, cursor, note, draw, velocity);
	}

	function writeChord(done: Chord) {
		chord = null;
		if (!done.notes.length || !mayWrite(done.start)) return;
		const written = write(clip, cursor, done, bars);
		onchoose(new Set());
		moveCursor(written.cursor);
		onchange(written.clip);
	}

	function stepKeys(event: KeyboardEvent) {
		if (!stepping || readonly || !active) return;
		const target = event.target as Element | null;
		if (typingIn(target, event.key) || target?.closest?.('[role="menu"], dialog, nav')) return;
		if (matches(event, 'step.rest')) {
			if (chord) chord = lengthenHeld(chord, bars.step(chordEnd(chord), grid));
			else moveCursor(rest(cursor, draw));
		} else if (matches(event, 'step.back')) {
			if (chord) chord = null;
			else {
				const back = stepBack(clip, cursor, draw);
				moveCursor(back.cursor);
				if (back.clip !== clip) onchange(back.clip);
			}
		} else if (
			matches(event, 'step.up') ||
			matches(event, 'step.down') ||
			matches(event, 'step.octave-up') ||
			matches(event, 'step.octave-down')
		) {
			if (chord) return;
			const semitones = matches(event, 'step.up')
				? 1
				: matches(event, 'step.down')
					? -1
					: matches(event, 'step.octave-up')
						? 12
						: -12;
			const fixed = repitch(clip, cursor, semitones);
			if (fixed.clip !== clip) {
				moveCursor(fixed.cursor);
				onchange(fixed.clip);
				audition(Math.max(...fixed.cursor.steps.at(-1)!.notes.map((n) => n.note)));
			}
		} else if (matches(event, 'escape')) {
			chord = null;
			stepping = false;
		} else return;
		event.preventDefault();
		event.stopPropagation();
	}

	onMount(() => on(window, 'keydown', stepKeys, { capture: true }));

	const caret = $derived.by(() => {
		if (!stepping) return null;
		const at = xOf(Math.min(cursor.tick, Math.max(0, clip.length - 1)));
		if (!at) return null;
		const past = cursor.tick >= clip.length;
		return { x: past ? at.measure.x1 : at.x, y: at.measure.y, height: at.measure.height };
	});

	const told = $derived.by(() => {
		if (stepping)
			return `Step at ${bars.position(cursor.tick)}. The keys write there, as long as Draw; → rests, Backspace steps back, Esc leaves.`;
		if (aim && !readonly) return `A click adds ${describe({ tick: aim.tick, note: aim.note, dur: draw })}`;
		const notes = [...chosen].map((i) => clip.notes[i]).filter(Boolean);
		if (notes.length !== 1) return notes.length ? `${notes.length} notes chosen` : '';
		const event = written.measures
			.flatMap((m) => m.voices.flat(2))
			.find((e) => e.pitches.some((p) => chosen.has(p.index)));
		const pitch = event?.pitches.find((p) => chosen.has(p.index));
		return pitch && event
			? `${spellingText(pitch.spelling)} · ${noteValue(event.length, bars.ppq)} · ${bars.position(event.start)}`
			: '';
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	class="score"
	data-testid="score"
	role="application"
	aria-label="Score"
	tabindex="0"
	bind:this={scoreElement}
	bind:clientWidth={width}
	onkeydown={keydown}
>
	{#if failed}
		<p class="muted" role="status">The score couldn't be drawn: {failed}</p>
	{:else if !vexflow}
		<p class="muted" role="status">Loading the score…</p>
	{/if}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div
		class="page"
		{@attach engrave}
		style:height="{height}px"
		data-testid="score-page"
		data-drawn={drawn}
		data-measures={written.measures.length}
		data-staves={written.clefs.join(' ')}
		onclick={click}
		onpointermove={hover}
		onpointerleave={() => (aim = null)}
	></div>
	{#if aim && !readonly && !stepping}
		<div
			class="ghost"
			data-testid="score-ghost"
			data-tick={aim.tick}
			data-note={aim.note}
			style:left="{aim.x - 6}px"
			style:top="{aim.y - 5}px"
		></div>
	{/if}
	{#if caret}
		<div
			class="caret"
			data-testid="score-cursor"
			data-tick={cursor.tick}
			style:left="{caret.x - 1}px"
			style:top="{caret.y - 14}px"
			style:height="{caret.height + 28}px"
		></div>
	{/if}
	{#if head}
		<div
			class="playhead"
			data-testid="score-playhead"
			style:left="{head.x}px"
			style:top="{head.y - 10}px"
			style:height="{head.height + 10}px"
		></div>
	{/if}
	{#if told}<p class="told" data-testid="score-told">{told}</p>{/if}
</div>

<style>
	.score {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: auto;
		color: var(--text);
		background: var(--panel, transparent);
	}
	.page {
		position: relative;
	}
	.page :global(.written) {
		cursor: pointer;
	}
	/* VexFlow strokes stems black and ledger lines dark grey, whatever the context's colour, which a dark page can't show: they
	   take their note's colour, which is the text's, or the accent for a chosen note. */
	.page :global([stroke='black']) {
		stroke: inherit;
	}
	.page :global([fill='black']) {
		fill: inherit;
	}
	.page :global([stroke='#444']) {
		stroke: var(--muted);
	}
	.score:focus-visible {
		outline: 1px solid var(--accent);
		outline-offset: -1px;
	}
	.ghost {
		position: absolute;
		width: 12px;
		height: 10px;
		border-radius: 50%;
		background: var(--accent);
		opacity: 0.45;
		pointer-events: none;
	}
	.caret {
		position: absolute;
		width: 3px;
		background: #e3b341;
		pointer-events: none;
	}
	.playhead {
		position: absolute;
		width: 2px;
		background: var(--accent);
		pointer-events: none;
	}
	.told {
		position: sticky;
		bottom: 0;
		margin: 0;
		padding: 0.2rem 0.6rem;
		background: var(--bg, #0d1117);
		font-size: 0.8rem;
	}
	.muted {
		margin: 1rem;
		color: var(--muted);
	}
</style>
