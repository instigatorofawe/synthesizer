<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { Key } from '#lib/KeySignature.ts';
	import { transcribe, spellingText, type Clef, type Event, type Measure, type Score } from '#lib/Notation.ts';
	import type { Bars } from '#lib/TimeSignature.ts';
	import type { Clip } from '#lib/TimelineEdit.ts';
	import { noteValue } from '#lib/Units.ts';

	// A clip's notes as a score, beside the roll as a view of the same notes: Notation.ts says what is written, and this draws
	// it with VexFlow, which is loaded with its music font, Bravura, the first time a score is shown, from the app itself. Systems
	// wrap to the width there is, each starting with its clefs and key, and a click on a note chooses it and says what it is. The
	// score is a reading of the notes, so a note played a little early reads as on the beat, while the roll shows where it is.
	let {
		clip,
		bars,
		keyAt,
		playhead = null,
		chosen = new Set<number>(),
		onchoose = () => {}
	}: {
		clip: Clip;
		bars: Bars; // The song's bars in the clip's own ticks (TimeSignature.ts)
		keyAt: (tick: number) => Key; // The key at a tick of the clip
		playhead?: number | null; // In ticks from the clip's start
		chosen?: ReadonlySet<number>; // Indices into the clip's notes
		onchoose?: (indices: Set<number>) => void;
	} = $props();

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
		draw(page, vexflow, written, width, chosen);
	}

	// How wide a measure's notes want to be: room for its most crowded voice.
	function contentWidth(measure: Measure) {
		const most = Math.max(1, ...measure.voices.flat().map((voice) => voice.filter((e) => !e.hidden).length));
		return 36 + 30 * most;
	}

	function draw(host: HTMLElement, vf: VexFlow, score: Score, available: number, picked: ReadonlySet<number>) {
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
		const renderer = new Renderer(host, Renderer.Backends.SVG);
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
				where.push({ start: measure.start, end: measure.end, x0: start, x1: x + w, y, height: STAFF * staves, at });
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

	// The playhead's place on the score: between the notes either side of it in its measure.
	const head = $derived.by(() => {
		if (playhead === null) return null;
		const measure = placed.find((m) => playhead >= m.start && playhead < m.end) ?? null;
		if (!measure) return null;
		const points: [number, number][] = [[measure.start, measure.x0], ...measure.at, [measure.end, measure.x1]];
		let x = measure.x0;
		for (let i = 0; i < points.length - 1; ++i) {
			const [t0, x0] = points[i];
			const [t1, x1] = points[i + 1];
			if (playhead >= t0 && playhead <= t1) {
				x = t1 > t0 ? x0 + ((playhead - t0) / (t1 - t0)) * (x1 - x0) : x0;
				break;
			}
		}
		return { x, y: measure.y, height: measure.height };
	});

	function click(event: MouseEvent) {
		const target = (event.target as Element).closest('[data-notes]');
		if (!target) {
			onchoose(new Set());
			return;
		}
		const indices = (target.getAttribute('data-notes') ?? '').split(' ').map(Number);
		const next = event.shiftKey ? new Set([...chosen, ...indices]) : new Set(indices);
		onchoose(next);
	}

	const told = $derived.by(() => {
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

<div class="score" data-testid="score" bind:clientWidth={width}>
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
	></div>
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
