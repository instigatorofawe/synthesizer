<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import {
		addNode,
		addZone,
		COLUMN,
		connect,
		detailOf,
		disconnect,
		edgeInto,
		freeSpot,
		inputsOf,
		insertSnap,
		moveNode,
		NODE_HEADER,
		NODE_WIDTH,
		nodeHeight,
		optionsOf,
		outputsOf,
		parseCurve,
		placed,
		PORT_SPACING,
		rateErrorInput,
		removeNode,
		removeZone,
		setField,
		setLiteral,
		setOption,
		setZone,
		tidy,
		whyCompiledAway,
		zonesOf,
		type CatalogEntry,
		type GraphNode,
		type LibraryPatch,
		type Point
	} from '#lib/GraphEdit.ts';
	import { friendlyName, helpOf, rangeText, shown } from '#lib/NodeHelp.ts';
	import NodePalette from '#lib/NodePalette.svelte';
	import type { Probe } from '#lib/AudioEngine.ts';
	import { matches, modHeld, typingIn } from '#lib/Shortcuts.ts';
	import type { NodesReport } from '#lib/Request.ts';
	import type { Graph, Param } from '#lib/Schema.ts';

	let {
		graph,
		self,
		catalog,
		library,
		assets,
		nodes,
		failed,
		errors,
		probes,
		maxProbes,
		readonly = false,
		active = true,
		choose = null,
		side,
		onchange,
		onprobes
	}: {
		graph: Graph;
		self: string;
		catalog: CatalogEntry[];
		library: LibraryPatch[];
		assets: { id: string; name: string }[];
		nodes: NodesReport | undefined; // what the last good compile said about each node
		failed: boolean; // and the current one failed, so that says nothing about what is on screen now
		errors: Map<number, string>;
		probes: Probe[];
		maxProbes: number;
		readonly?: boolean; // For looking at: a node can be chosen and probed, and nothing changes
		active?: boolean; // Whether keys are for this editor, when it shares a page with others
		choose?: { node: number } | null; // A node to choose and bring into view, asked for from outside, each time a new one
		side?: Snippet; // Drawn above the inspector
		onchange: (graph: Graph) => void;
		onprobes: (probes: Probe[]) => void;
	} = $props();

	type Gesture =
		| { kind: 'pan'; from: Point; view: Point }
		| { kind: 'move'; id: number; offset: Point; at: Point }
		| { kind: 'wire'; from: number; port: string; start: Point; at: Point };

	// The node search, open. A node it adds goes at `at` or the nearest free place, and one opened from a wire dropped on empty
	// canvas arrives wired from that output.
	type Palette = {
		left: number; // Where the search opens, in CSS pixels from the canvas's top left
		top: number;
		at: Point;
		wire: { from: number; port: string; start: Point; end: Point } | null;
		back: HTMLElement | SVGElement | null; // What had focus, which gets it back
	};

	// The smallest text on the canvas is a port's label, 11 units high. Fit never draws it below 11 CSS pixels, about as small as
	// text on a laptop can be read, and what doesn't fit is panned to. Zooming by hand goes further either way.
	const SMALLEST_TEXT = 11;
	const READABLE_PX = 11;
	const FIT_FLOOR = READABLE_PX / SMALLEST_TEXT;
	const FIT_CEILING = 1.5; // A graph of two nodes isn't blown up to fill the canvas
	const ZOOM_MIN = 0.2;
	const ZOOM_MAX = 3;
	const ZOOM_STEP = 1.25;
	const MARGIN = 40; // Around a fitted graph, which leaves room for a message under a node
	const PALETTE_WIDTH = 300;
	const PALETTE_HEIGHT = 340; // At most: the search and a list of 280 pixels

	let svg: SVGSVGElement;
	let size = $state({ width: 1000, height: 560 }); // Of the canvas on screen, in CSS pixels
	let view = $state({ x: -30, y: -30, scale: 1 }); // The graph point at the canvas's top left, and CSS pixels to a unit
	let selected = $state<number | null>(null);
	let gesture = $state<Gesture | null>(null);
	let palette = $state<Palette | null>(null);
	let hover: { x: number; y: number } | null = null; // The pointer over the canvas, where N opens the search

	const heightOf = (node: GraphNode) => nodeHeight(node, catalog, library);
	const sizeOf = (node: GraphNode) => ({ width: NODE_WIDTH, height: heightOf(node) });
	const laid = $derived(placed(graph, heightOf));
	const others = $derived(library.filter((patch) => patch.id !== self));
	const types = $derived(catalog.map((entry) => entry.type));
	const chosen = $derived(laid.nodes.find((node) => node.id === selected) ?? null);

	// A node of a type as the search adds it, which is what decides its ports. A subpatch starts as the first patch it can be.
	const fresh = (type: string): GraphNode =>
		type === 'subpatch' && others[0]
			? { id: 0, type: 'subpatch', patch: others[0].id }
			: { id: 0, type: type as GraphNode['type'] };

	// From a wire, only what has an input for it to go to.
	const offered = $derived(
		palette?.wire ? types.filter((type) => inputsOf(fresh(type), catalog, library).length > 0) : types
	);

	// The page records each edit, so its history outlasts this editor.
	const commit = (next: Graph) => onchange(next);

	const positionOf = (node: GraphNode): Point =>
		gesture?.kind === 'move' && gesture.id === node.id ? gesture.at : { x: node.x as number, y: node.y as number };
	const inputY = (index: number) => NODE_HEADER + PORT_SPACING * index + PORT_SPACING / 2;

	function outputPoint(node: GraphNode, port: string): Point {
		const at = positionOf(node);
		const index = Math.max(0, outputsOf(node, catalog, library).indexOf(port));
		return { x: at.x + NODE_WIDTH, y: at.y + inputY(index) };
	}

	function inputPoint(node: GraphNode, input: string): Point {
		const at = positionOf(node);
		const index = Math.max(
			0,
			inputsOf(node, catalog, library).findIndex((candidate) => candidate.name === input)
		);
		return { x: at.x, y: at.y + inputY(index) };
	}

	function curve(a: Point, b: Point) {
		const reach = Math.max(40, Math.abs(b.x - a.x) / 2);
		return `M ${a.x} ${a.y} C ${a.x + reach} ${a.y}, ${b.x - reach} ${b.y}, ${b.x} ${b.y}`;
	}

	const wires = $derived(
		laid.edges.flatMap((edge) => {
			const from = laid.nodes.find((node) => node.id === edge.from);
			const to = laid.nodes.find((node) => node.id === edge.to);
			if (!from || !to) return [];
			const port = edge.port ?? 'out';
			const input = edge.input ?? 'in';
			return [
				{
					key: `${edge.to}.${input}`,
					to: edge.to,
					input,
					path: curve(outputPoint(from, port), inputPoint(to, input)),
					rate: nodes?.[edge.from]?.ports[port]?.rate ?? 'unknown'
				}
			];
		})
	);

	function toCanvas(event: { clientX: number; clientY: number }): Point {
		const matrix = svg.getScreenCTM();
		if (!matrix) return { x: 0, y: 0 };
		const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
		return { x: point.x, y: point.y };
	}

	function startPan(event: PointerEvent) {
		selected = null;
		gesture = { kind: 'pan', from: { x: event.clientX, y: event.clientY }, view: { x: view.x, y: view.y } };
	}

	function startMove(event: PointerEvent, node: GraphNode) {
		event.stopPropagation();
		selected = node.id;
		if (readonly) return;
		const at = positionOf(node);
		const pointer = toCanvas(event);
		gesture = { kind: 'move', id: node.id, at, offset: { x: pointer.x - at.x, y: pointer.y - at.y } };
	}

	function startWire(event: PointerEvent, node: GraphNode, port: string) {
		event.stopPropagation();
		if (readonly) return;
		const start = outputPoint(node, port);
		gesture = { kind: 'wire', from: node.id, port, start, at: start };
	}

	function pointerMove(event: PointerEvent) {
		hover = { x: event.clientX, y: event.clientY };
		if (!gesture) return;
		if (gesture.kind === 'pan') {
			view.x = gesture.view.x - (event.clientX - gesture.from.x) / view.scale;
			view.y = gesture.view.y - (event.clientY - gesture.from.y) / view.scale;
		} else if (gesture.kind === 'move') {
			const pointer = toCanvas(event);
			gesture.at = { x: pointer.x - gesture.offset.x, y: pointer.y - gesture.offset.y };
		} else {
			gesture.at = toCanvas(event);
		}
	}

	function pointerUp(event: PointerEvent) {
		if (gesture?.kind === 'move') {
			const node = laid.nodes.find((candidate) => candidate.id === (gesture as { id: number }).id);
			const { id, at } = gesture;
			if (node && (node.x !== at.x || node.y !== at.y)) commit(moveNode(laid, id, Math.round(at.x), Math.round(at.y)));
		} else if (gesture?.kind === 'wire') {
			// A wire let go of on empty canvas asks what it should go to. Under the pointer is what it was dropped on: a touch keeps
			// sending events to where it started.
			const under = document.elementFromPoint(event.clientX, event.clientY);
			if (under && svg.contains(under) && !under.closest('g.node')) {
				const { from, port, start } = gesture;
				gesture = null;
				openPalette({ x: event.clientX, y: event.clientY }, { from, port, start, end: toCanvas(event) });
				return;
			}
		}
		gesture = null;
	}

	function finishWire(event: PointerEvent, node: GraphNode, input: string) {
		if (gesture?.kind !== 'wire') return;
		event.stopPropagation();
		commit(connect(laid, gesture.from, gesture.port, node.id, input));
		gesture = null;
	}

	// Keeps the graph point under `at` where it is on screen.
	function zoomAt(at: Point, factor: number) {
		const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.scale * factor));
		view = {
			x: at.x - ((at.x - view.x) * view.scale) / scale,
			y: at.y - ((at.y - view.y) * view.scale) / scale,
			scale
		};
	}

	const middle = (): Point => ({
		x: view.x + size.width / view.scale / 2,
		y: view.y + size.height / view.scale / 2
	});

	// A wheel or two fingers pan, as they scroll a page, and Shift with a wheel pans sideways. Mod with the wheel zooms around
	// the pointer, and so does a pinch, which a browser sends as a wheel with ctrlKey set. A notch of a wheel is clamped, so that
	// it zooms about as far as a short pinch does.
	function wheel(event: WheelEvent) {
		event.preventDefault();
		const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
		if (event.ctrlKey || modHeld(event)) {
			const delta = Math.max(-50, Math.min(50, event.deltaY * unit));
			zoomAt(toCanvas(event), 2 ** (-delta / 150));
			return;
		}
		let dx = event.deltaX * unit;
		let dy = event.deltaY * unit;
		if (event.shiftKey && !dx) [dx, dy] = [dy, 0];
		view = { ...view, x: view.x + dx / view.scale, y: view.y + dy / view.scale };
	}

	// All of the graph, if it can be read at that size, and otherwise its top left, where its signals start, at the smallest size
	// that can be read.
	function fit(shown: Graph = laid) {
		if (!shown.nodes.length) return;
		const left = Math.min(...shown.nodes.map((node) => node.x as number)) - MARGIN;
		const top = Math.min(...shown.nodes.map((node) => node.y as number)) - MARGIN;
		const right = Math.max(...shown.nodes.map((node) => (node.x as number) + NODE_WIDTH)) + MARGIN;
		const bottom = Math.max(...shown.nodes.map((node) => (node.y as number) + heightOf(node))) + MARGIN;
		const scale = Math.max(FIT_FLOOR, Math.min(FIT_CEILING, size.width / (right - left), size.height / (bottom - top)));
		const width = size.width / scale;
		const height = size.height / scale;
		view = {
			x: width >= right - left ? (left + right - width) / 2 : left,
			y: height >= bottom - top ? (top + bottom - height) / 2 : top,
			scale
		};
	}

	// A node reached from the keyboard comes into view, by as little panning as that takes. A click doesn't move the view, since
	// what was clicked is in it, and a node about to be dragged mustn't move.
	function reveal(node: GraphNode) {
		const width = size.width / view.scale;
		const height = size.height / view.scale;
		const [x, y] = [node.x as number, node.y as number];
		const into = (start: number, length: number, at: number, extent: number) =>
			at < start ? at - MARGIN : at + extent > start + length ? at + extent + MARGIN - length : start;
		view = { ...view, x: into(view.x, width, x, NODE_WIDTH), y: into(view.y, height, y, heightOf(node)) };
	}

	// The node search opens at the pointer, or at the canvas's top left under the toolbar's button. What it adds goes where the
	// pointer was, at the end of a dropped wire, beside the chosen node, or in the middle of the view, in that order.
	function openPalette(client: { x: number; y: number } | null, wire: Palette['wire'] = null) {
		if (readonly) return;
		const rect = svg.getBoundingClientRect();
		const canvas = client ? toCanvas({ clientX: client.x, clientY: client.y }) : null;
		const centre = middle();
		const at = wire
			? { x: wire.end.x, y: wire.end.y - inputY(0) }
			: canvas
				? { x: canvas.x - NODE_WIDTH / 2, y: canvas.y - NODE_HEADER / 2 }
				: chosen
					? { x: (chosen.x as number) + COLUMN, y: chosen.y as number }
					: { x: centre.x - NODE_WIDTH / 2, y: centre.y - NODE_HEADER };
		const left = client ? client.x - rect.left : 8;
		const top = client ? client.y - rect.top : 8;
		palette = {
			// It may hang below the canvas, over what is under it, as a menu does, but not off the bottom of the window.
			left: Math.max(0, Math.min(left, rect.width - PALETTE_WIDTH)),
			top: Math.max(0, Math.min(top, window.innerHeight - rect.top - PALETTE_HEIGHT)),
			at,
			wire,
			back:
				document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement
					? document.activeElement
					: null
		};
	}

	function closePalette(refocus: boolean) {
		const back = palette?.back;
		palette = null;
		if (refocus) (back?.isConnected && back !== document.body ? back : svg)?.focus({ preventScroll: true });
	}

	function pick(type: string) {
		if (!palette) return;
		const { at, wire } = palette;
		const node = fresh(type);
		const spot = freeSpot(laid, at, sizeOf(node), sizeOf);
		const { graph: added, id } = addNode(laid, node.type, spot.x, spot.y);
		let next = node.patch ? setOption(added, id, 'patch', node.patch as string, catalog, library) : added;
		const first = inputsOf(node, catalog, library)[0];
		if (wire && first) next = connect(next, wire.from, wire.port, id, first.name);
		closePalette(true);
		commit(next);
		selected = id;
	}

	function tidyUp() {
		const next = tidy(laid, heightOf);
		commit(next);
		fit(next);
	}

	// The input a node's error says can't take audio, where a snap on its wire would mend it. Inside a subpatch the wire is in
	// another graph, so none is offered there.
	function snapFor(node: GraphNode): string | null {
		const problem = errors.get(node.id);
		const input = problem && node.type !== 'subpatch' ? rateErrorInput(problem) : null;
		return input && edgeInto(laid, node.id, input) ? input : null;
	}

	// Halfway along the wire, or as near as is free.
	function putSnap(node: GraphNode, input: string) {
		const wire = edgeInto(laid, node.id, input);
		const from = laid.nodes.find((candidate) => candidate.id === wire?.from);
		if (!wire || !from) return;
		const a = outputPoint(from, wire.port ?? 'out');
		const b = inputPoint(node, input);
		const want = { x: (a.x + b.x - NODE_WIDTH) / 2, y: (a.y + b.y) / 2 - inputY(0) };
		const spot = freeSpot(laid, want, sizeOf({ id: 0, type: 'snap' }), sizeOf);
		const fixed = insertSnap(laid, node.id, input, spot.x, spot.y);
		if (fixed) commit(fixed.graph);
	}

	function removeSelected() {
		if (selected === null) return;
		const id = selected;
		const left = probes.filter((probe) => probe.node !== id);
		if (left.length !== probes.length) onprobes(left);
		commit(removeNode(laid, id));
		selected = null;
	}

	// N and the full stop go by where the key is, as the piano keys do, and take no modifier, which leaves them to the browser.
	function keydown(event: KeyboardEvent) {
		if (!active || typingIn(event.target)) return;
		if (matches(event, 'escape') && gesture) {
			gesture = null;
		} else if (matches(event, 'fit')) {
			event.preventDefault();
			fit();
		} else if (readonly) {
			return;
		} else if (matches(event, 'node-search')) {
			event.preventDefault();
			openPalette(hover);
		} else if ((matches(event, 'graph.delete') || matches(event, 'graph.backspace')) && selected !== null) {
			event.preventDefault();
			removeSelected();
		}
	}

	const probed = (node: number, port: string) => probes.some((probe) => probe.node === node && probe.port === port);

	function toggleProbe(node: GraphNode, port: string) {
		if (probed(node.id, port)) {
			onprobes(probes.filter((probe) => !(probe.node === node.id && probe.port === port)));
		} else {
			onprobes([...probes, { node: node.id, port, label: `${node.id} ${node.type}.${port}` }]);
		}
	}

	function sourceChanged(node: GraphNode, input: string, value: string) {
		if (!value) {
			commit(disconnect(laid, node.id, input));
			return;
		}
		const split = value.indexOf(':');
		commit(connect(laid, Number(value.slice(0, split)), value.slice(split + 1), node.id, input));
	}

	function literalChanged(node: GraphNode, input: string, text: string) {
		const value = Number(text);
		commit(setLiteral(laid, node.id, input, text === '' || Number.isNaN(value) ? undefined : value));
	}

	function optionChanged(node: GraphNode, name: string, text: string, number: boolean) {
		const value = text === '' ? undefined : number ? Number(text) : text;
		commit(setOption(laid, node.id, name, value, catalog, library));
	}

	const sourceOf = (node: GraphNode, input: string) => {
		const edge = edgeInto(laid, node.id, input);
		return edge ? `${edge.from}:${edge.port ?? 'out'}` : '';
	};

	// A number as a field shows it, rounded, and anything else as it is.
	const field = (value: unknown) => (typeof value === 'number' ? shown(value) : ((value as string | undefined) ?? ''));

	// The compiler's name under the one a person reads, with what the node is set to, cut to fit the node.
	function kindOf(node: GraphNode) {
		const detail = detailOf(node, laid, library);
		const text = detail ? `${node.type} · ${detail}` : node.type;
		return text.length > 24 ? `${text.slice(0, 23)}…` : text;
	}

	const paramFields = ['name', 'min', 'max', 'default'] as const;

	function changeParam(index: number, change: Partial<Param>) {
		commit({ ...laid, params: laid.params.map((param, i) => (i === index ? { ...param, ...change } : param)) });
	}

	function addParam() {
		const id = Math.max(0, ...laid.params.map((param) => param.id)) + 1;
		const param: Param = { id, name: `param ${id}`, scope: 'track', min: 0, max: 1, default: 0.5, smooth_ms: 10 };
		commit({ ...laid, params: [...laid.params, param] });
	}

	// The canvas takes whatever room its panel has, and the view keeps its scale, so a panel dragged taller shows more below
	// rather than zooming. The first view of a graph is a fit, once the canvas has a size, and only once, or each edit or
	// resize would move it.
	let measured = false;
	function measure() {
		if (!svg?.clientWidth || !svg.clientHeight) return;
		// Inside the border, and unrounded, as clientWidth isn't: a text size worked out from a rounded width is a little small.
		const box = svg.getBoundingClientRect();
		size = { width: box.width - 2 * svg.clientLeft, height: box.height - 2 * svg.clientTop };
		if (!measured) {
			measured = true;
			fit();
		}
	}

	$effect(() => {
		untrack(measure);
		const observer = new ResizeObserver(() => untrack(measure));
		observer.observe(svg);
		return () => observer.disconnect();
	});

	// A node asked for from outside, by the compile light's link to a problem, is chosen and brought into view. This comes after
	// the first fit, so the fit doesn't move it out again.
	$effect(() => {
		const asked = choose;
		if (!asked) return;
		untrack(() => {
			const node = laid.nodes.find((candidate) => candidate.id === asked.node);
			if (!node) return;
			selected = node.id;
			reveal(node);
		});
	});
</script>

<svelte:window onkeydown={keydown} onpointerup={pointerUp} />

<div class="grapheditor">
	<div class="toolbar">
		{#if !readonly}
			<button
				type="button"
				class="add"
				title="Search for a node to add. N, or a double-click on the canvas, opens it too."
				aria-haspopup="dialog"
				aria-expanded={palette !== null}
				onclick={() => openPalette(null)}>+ Node</button
			>
			<button type="button" onclick={tidyUp} title="Lay the graph out again, left to right as signals flow">Tidy</button
			>
		{/if}
		<button type="button" onclick={() => fit()} title="Show the whole graph, or its start if it can't all be read (.)"
			>Fit</button
		>
		<div class="zoom" role="group" aria-label="Zoom the graph">
			<button
				type="button"
				aria-label="Zoom the graph out"
				title="Zoom out. Pinch, or scroll with ⌘ or Ctrl, to zoom where the pointer is."
				disabled={view.scale <= ZOOM_MIN}
				onclick={() => zoomAt(middle(), 1 / ZOOM_STEP)}>−</button
			>
			<button
				type="button"
				class="percent"
				title="Back to 100%"
				data-testid="zoom"
				onclick={() => zoomAt(middle(), 1 / view.scale)}>{Math.round(view.scale * 100)}%</button
			>
			<button
				type="button"
				aria-label="Zoom the graph in"
				title="Zoom in. Pinch, or scroll with ⌘ or Ctrl, to zoom where the pointer is."
				disabled={view.scale >= ZOOM_MAX}
				onclick={() => zoomAt(middle(), ZOOM_STEP)}>+</button
			>
		</div>
		<span class="muted hint">
			{readonly
				? 'Drag the background or scroll to move around.'
				: 'Double-click or press N to add a node, and drag from an output to an input to wire it.'}
			Green wires are audio, dashed blue ones are read once a frame.
		</span>
	</div>

	<div class="editor">
		<div class="canvas">
			<!-- The canvas takes focus, so that N and the full stop act on the graph and the search gives focus back to it. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<svg
				bind:this={svg}
				viewBox={`${view.x} ${view.y} ${size.width / view.scale} ${size.height / view.scale}`}
				role="application"
				aria-label="Patch graph"
				tabindex="0"
				data-testid="graph"
				data-scale={view.scale}
				onpointerdown={startPan}
				onpointermove={pointerMove}
				onpointerleave={() => (hover = null)}
				ondblclick={(event) => {
					if (!(event.target as Element).closest('g.node')) openPalette({ x: event.clientX, y: event.clientY });
				}}
				onwheel={wheel}
			>
				{#each wires as wire (wire.key)}
					<path class={`wire ${wire.rate}`} d={wire.path} data-testid={`wire-${wire.to}-${wire.input}`} />
				{/each}
				{#if gesture?.kind === 'wire'}
					<path class="wire drawing" d={curve(gesture.start, gesture.at)} />
				{:else if palette?.wire}
					<path class="wire drawing" d={curve(palette.wire.start, palette.wire.end)} />
				{/if}
				{#each laid.nodes as node (node.id)}
					{@const at = positionOf(node)}
					{@const height = nodeHeight(node, catalog, library)}
					{@const problem = errors.get(node.id)}
					{@const dead = !failed && nodes !== undefined && !nodes[node.id]}
					{@const why = dead ? whyCompiledAway(laid, node.id) : null}
					<g
						class="node"
						class:chosen={node.id === selected}
						class:dead
						class:problem={problem !== undefined}
						transform={`translate(${at.x} ${at.y})`}
						data-testid={`node-${node.id}`}
						data-error={problem !== undefined}
						data-dead={dead}
					>
						{#if problem}<title>{problem}</title>{:else if why}<title>{why}</title>{/if}
						<rect
							class="body"
							width={NODE_WIDTH}
							{height}
							rx="5"
							role="presentation"
							onpointerdown={(event) => startMove(event, node)}
						/>
						<rect
							class="title"
							width={NODE_WIDTH}
							height={NODE_HEADER - 4}
							rx="5"
							role="button"
							tabindex="0"
							aria-label={`${friendlyName(node.type)}, ${node.type} ${node.id}`}
							onpointerdown={(event) => startMove(event, node)}
							onfocus={(event) => {
								if (event.currentTarget.matches(':focus-visible')) reveal(node);
							}}
							onkeydown={(event) => {
								if (event.key === 'Enter') selected = node.id;
							}}
						/>
						<text class="heading" x="8" y="16">{friendlyName(node.type)}</text>
						<text class="kind" x="8" y="31">{kindOf(node)}</text>
						{#each inputsOf(node, catalog, library) as input, index (input.name)}
							<circle
								class="port"
								class:wired={edgeInto(laid, node.id, input.name) !== undefined}
								cx="0"
								cy={inputY(index)}
								r="6"
								role="button"
								tabindex="-1"
								aria-label={`${node.id} input ${input.name}`}
								data-testid={`in-${node.id}-${input.name}`}
								onpointerup={(event) => finishWire(event, node, input.name)}
							/>
							<text class="label" x="11" y={inputY(index) + 4}>{input.name}</text>
						{/each}
						{#each outputsOf(node, catalog, library) as port, index (port)}
							<circle
								class="port output"
								class:probed={probed(node.id, port)}
								cx={NODE_WIDTH}
								cy={inputY(index)}
								r="6"
								role="button"
								tabindex="-1"
								aria-label={`${node.id} output ${port}`}
								data-testid={`out-${node.id}-${port}`}
								onpointerdown={(event) => startWire(event, node, port)}
							/>
							<text class="label end" x={NODE_WIDTH - 11} y={inputY(index) + 4}>{port}</text>
						{/each}
					</g>
				{/each}
				<!-- A node's error, and the snap that mends it, hang below the node, where the next node in its column may be. They are
				     drawn after every node, so that none covers them. -->
				{#each laid.nodes as node (node.id)}
					{@const problem = errors.get(node.id)}
					{#if problem}
						{@const at = positionOf(node)}
						{@const height = nodeHeight(node, catalog, library)}
						{@const snap = readonly ? null : snapFor(node)}
						<g class="trouble" transform={`translate(${at.x} ${at.y + height})`}>
							<text class="message" x="0" y="13">{problem.length > 44 ? `${problem.slice(0, 43)}…` : problem}</text>
							{#if snap}
								<g
									class="fix"
									role="button"
									tabindex="0"
									aria-label="Put a snap on this wire"
									transform="translate(0 20)"
									onpointerdown={(event) => event.stopPropagation()}
									onclick={() => putSnap(node, snap)}
									onkeydown={(event) => {
										if (event.key === 'Enter' || event.key === ' ') {
											event.preventDefault();
											putSnap(node, snap);
										}
									}}
								>
									<rect width={NODE_WIDTH} height="20" rx="4" />
									<text x={NODE_WIDTH / 2} y="14">Put a snap on this wire</text>
								</g>
							{/if}
						</g>
					{/if}
				{/each}
			</svg>
			{#if palette}
				<NodePalette
					types={offered}
					left={palette.left}
					top={palette.top}
					label={palette.wire ? 'Add a node wired from this output' : 'Add a node'}
					onpick={pick}
					onclose={closePalette}
				/>
			{/if}
		</div>

		<aside class="inspector">
			{@render side?.()}
			{#if chosen}
				{@const help = helpOf(chosen.type)}
				{@const snap = readonly ? null : snapFor(chosen)}
				{@const dead = !failed && nodes !== undefined && !nodes[chosen.id]}
				<h3>{friendlyName(chosen.type)} <span class="muted">{chosen.type} {chosen.id}</span></h3>
				{#if help}<p class="muted about">{help.description}</p>{/if}
				{#if errors.get(chosen.id)}<p class="problem" data-testid="node-error">{errors.get(chosen.id)}</p>{/if}
				{#if snap}
					<button type="button" class="fix" onclick={() => putSnap(chosen, snap)}>Put a snap on this wire</button>
					<p class="muted about">
						It reads {snap} once a frame. That is right for an envelope and wrong for anything faster.
					</p>
				{/if}
				{#if dead}
					<p class="muted about" data-testid="node-dead">
						{whyCompiledAway(laid, chosen.id) ?? 'It compiled away, so it makes nothing that is heard.'}
					</p>
				{/if}
				<fieldset class="bare" disabled={readonly}>
					{#if chosen.type === 'shape'}
						<label>
							curve
							<input
								aria-label="curve"
								value={Array.isArray(chosen.curve) ? chosen.curve.join(', ') : ''}
								placeholder="-1, 0, 1"
								onchange={(e) =>
									commit(
										setOption(laid, chosen.id, 'curve', parseCurve(e.currentTarget.value) as never, catalog, library)
									)}
							/>
						</label>
					{/if}
					{#if chosen.type === 'sample' && chosen.mode === 'zones'}
						<h4>Zones</h4>
						{#each zonesOf(chosen) as zone, index (index)}
							{@const keys = zone.keys ?? [0, 127]}
							{@const velocities = zone.velocities ?? [0, 127]}
							<div class="zone" data-testid={`zone-${index}`}>
								<select
									aria-label={`Zone ${index + 1} asset`}
									value={zone.asset}
									onchange={(e) => commit(setZone(laid, chosen.id, index, { asset: e.currentTarget.value }))}
								>
									{#each assets as asset (asset.id)}<option value={asset.id}>{asset.name}</option>{/each}
								</select>
								<label>
									keys
									<input
										type="number"
										min="0"
										max="127"
										aria-label={`Zone ${index + 1} lowest key`}
										value={keys[0]}
										onchange={(e) =>
											commit(setZone(laid, chosen.id, index, { keys: [Number(e.currentTarget.value), keys[1]] }))}
									/>
									<input
										type="number"
										min="0"
										max="127"
										aria-label={`Zone ${index + 1} highest key`}
										value={keys[1]}
										onchange={(e) =>
											commit(setZone(laid, chosen.id, index, { keys: [keys[0], Number(e.currentTarget.value)] }))}
									/>
								</label>
								<label>
									velocity
									<input
										type="number"
										min="0"
										max="127"
										aria-label={`Zone ${index + 1} lowest velocity`}
										value={velocities[0]}
										onchange={(e) =>
											commit(
												setZone(laid, chosen.id, index, { velocities: [Number(e.currentTarget.value), velocities[1]] })
											)}
									/>
									<input
										type="number"
										min="0"
										max="127"
										aria-label={`Zone ${index + 1} highest velocity`}
										value={velocities[1]}
										onchange={(e) =>
											commit(
												setZone(laid, chosen.id, index, { velocities: [velocities[0], Number(e.currentTarget.value)] })
											)}
									/>
								</label>
								<label>
									root
									<input
										type="number"
										min="0"
										max="127"
										step="any"
										placeholder="asset's"
										aria-label={`Zone ${index + 1} root`}
										value={zone.root ?? ''}
										onchange={(e) =>
											commit(
												setZone(laid, chosen.id, index, {
													root: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value)
												})
											)}
									/>
								</label>
								{#if !readonly}
									<button type="button" onclick={() => commit(removeZone(laid, chosen.id, index))}>Remove zone</button>
								{/if}
							</div>
						{/each}
						{#if !readonly && assets.length}
							<button type="button" onclick={() => commit(addZone(laid, chosen.id, assets[0].id))}>Add zone</button>
						{/if}
						<label>
							reverse
							<input
								type="checkbox"
								aria-label="reverse"
								checked={chosen.reverse === true}
								onchange={(e) => commit(setField(laid, chosen.id, 'reverse', e.currentTarget.checked || undefined))}
							/>
						</label>
						<label>
							tail
							<input
								type="checkbox"
								aria-label="tail"
								checked={chosen.tail === true}
								onchange={(e) => commit(setField(laid, chosen.id, 'tail', e.currentTarget.checked || undefined))}
							/>
						</label>
					{/if}
					{#each optionsOf(chosen, catalog).filter((option) => !(chosen.mode === 'zones' && option.name === 'asset')) as option (option.name)}
						<label>
							{option.name}
							{#if option.choices.length}
								<select
									aria-label={option.name}
									value={chosen[option.name] ?? ''}
									onchange={(e) => optionChanged(chosen, option.name, e.currentTarget.value, false)}
								>
									<option value="">default</option>
									{#each option.choices as choice (choice)}<option value={choice}>{choice}</option>{/each}
								</select>
							{:else if option.name === 'patch'}
								<select
									aria-label="patch"
									value={chosen.patch ?? ''}
									onchange={(e) => optionChanged(chosen, 'patch', e.currentTarget.value, false)}
								>
									<option value="">none</option>
									{#each others as patch (patch.id)}<option value={patch.id}>{patch.name}</option>{/each}
								</select>
							{:else if option.name === 'asset'}
								<select
									aria-label="asset"
									value={chosen.asset ?? ''}
									onchange={(e) => optionChanged(chosen, 'asset', e.currentTarget.value, false)}
								>
									<option value="">none</option>
									{#each assets as asset (asset.id)}<option value={asset.id}>{asset.name}</option>{/each}
								</select>
							{:else if option.name === 'param'}
								<select
									aria-label="param"
									value={chosen.param ?? ''}
									onchange={(e) => optionChanged(chosen, 'param', e.currentTarget.value, true)}
								>
									<option value="">none</option>
									{#each laid.params as param (param.id)}<option value={param.id}
											>{param.name || `param ${param.id}`}</option
										>{/each}
								</select>
							{:else}
								<input
									aria-label={option.name}
									type={option.number ? 'number' : 'text'}
									step="any"
									value={field(chosen[option.name])}
									onchange={(e) => optionChanged(chosen, option.name, e.currentTarget.value, option.number)}
								/>
							{/if}
						</label>
					{/each}
					{#if inputsOf(chosen, catalog, library).length}<h4>Inputs</h4>{/if}
					{#each inputsOf(chosen, catalog, library) as input (input.name)}
						{@const about = help?.inputs[input.name]}
						{@const range = rangeText(about)}
						<div class="input">
							<span class="name"
								>{input.name}{#if about?.unit}<span class="unit">{about.unit}</span>{/if}</span
							>
							<select
								aria-label={`source of ${input.name}`}
								value={sourceOf(chosen, input.name)}
								onchange={(e) => sourceChanged(chosen, input.name, e.currentTarget.value)}
							>
								<option value="">value</option>
								{#each laid.nodes as source (source.id)}
									{#each outputsOf(source, catalog, library) as port (port)}
										<option value={`${source.id}:${port}`}>{source.id} {source.type}.{port}</option>
									{/each}
								{/each}
							</select>
							{#if !edgeInto(laid, chosen.id, input.name)}
								<input
									type="number"
									step="any"
									aria-label={`value of ${input.name}`}
									placeholder={shown(input.default)}
									value={field(chosen.inputs?.[input.name])}
									onchange={(e) => literalChanged(chosen, input.name, e.currentTarget.value)}
								/>
							{/if}
							{#if range}<span class="range" data-testid={`range-${input.name}`}>{range}</span>{/if}
						</div>
					{/each}
				</fieldset>
				{#if outputsOf(chosen, catalog, library).length}<h4>Outputs</h4>{/if}
				{#each outputsOf(chosen, catalog, library) as port (port)}
					<div class="input">
						<span>{port}</span>
						<span class="muted">{nodes?.[chosen.id]?.ports[port]?.rate ?? ''}</span>
						<button
							type="button"
							disabled={!probed(chosen.id, port) &&
								(probes.length >= maxProbes || nodes?.[chosen.id]?.ports[port]?.operand === undefined)}
							onclick={() => toggleProbe(chosen, port)}
						>
							{probed(chosen.id, port) ? `Stop probing ${port}` : `Probe ${port}`}
						</button>
					</div>
				{/each}
				{#if !readonly}<button type="button" onclick={removeSelected}>Delete node</button>{/if}
			{:else}
				<h3>Parameters</h3>
				{#each laid.params as param, index (param.id)}
					<fieldset disabled={readonly}>
						<legend>{param.id}</legend>
						{#each paramFields as name (name)}
							<label>
								{name}
								<input
									type={name === 'name' ? 'text' : 'number'}
									step="any"
									aria-label={`param ${param.id} ${name}`}
									value={field(param[name])}
									onchange={(e) =>
										changeParam(index, {
											[name]: name === 'name' ? e.currentTarget.value : Number(e.currentTarget.value)
										})}
								/>
							</label>
						{/each}
						<label>
							scope
							<select
								value={param.scope}
								onchange={(e) => changeParam(index, { scope: e.currentTarget.value as Param['scope'] })}
							>
								<option value="voice">voice</option>
								<option value="track">track</option>
								<option value="global">global</option>
							</select>
						</label>
						{#if !readonly}
							<button
								type="button"
								onclick={() => commit({ ...laid, params: laid.params.filter((_, i) => i !== index) })}
							>
								Remove
							</button>
						{/if}
					</fieldset>
				{/each}
				{#if !readonly}<button type="button" onclick={addParam}>Add parameter</button>{/if}
				<p class="muted">Select a node to {readonly ? 'see how it is set up' : 'change it'}.</p>
			{/if}
		</aside>
	</div>
</div>

<style>
	.grapheditor {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0;
		flex-wrap: wrap;
		font-size: 0.8rem;
	}
	.toolbar button {
		padding: 0.1rem 0.5rem;
	}
	.toolbar .add {
		font-weight: 600;
	}
	.zoom {
		display: flex;
	}
	.zoom button {
		border-radius: 0;
		min-width: 1.8rem;
	}
	.zoom button:first-child {
		border-radius: 5px 0 0 5px;
	}
	.zoom button:last-child {
		border-radius: 0 5px 5px 0;
	}
	.zoom .percent {
		min-width: 3.4rem;
		border-left: 0;
		border-right: 0;
		font-variant-numeric: tabular-nums;
	}
	.hint {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.editor {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 260px;
		gap: 0.5rem;
	}
	.canvas {
		position: relative;
		min-width: 0;
		min-height: 0;
	}
	svg {
		display: block;
		width: 100%;
		height: 100%;
		min-height: 0;
		background: #0d1117;
		border: 1px solid var(--line);
		border-radius: 6px;
		touch-action: none;
		cursor: grab;
		user-select: none;
		outline: none;
	}
	svg:focus-visible {
		border-color: var(--accent);
	}
	.wire {
		fill: none;
		stroke: var(--muted);
		stroke-width: 1.6;
	}
	.wire.audio {
		stroke: #3fb950;
	}
	.wire.control {
		stroke: var(--accent);
		stroke-dasharray: 6 3;
	}
	.wire.drawing {
		stroke: var(--text);
		stroke-dasharray: 4 3;
		pointer-events: none;
	}
	.node .body {
		fill: var(--panel);
		stroke: var(--line);
	}
	.node.chosen .body {
		stroke: var(--accent);
	}
	.node.problem .body {
		stroke: #f85149;
		stroke-width: 2;
	}
	.node.dead {
		opacity: 0.45;
	}
	.title {
		fill: #1a212b;
		cursor: move;
		outline: none;
	}
	.heading {
		fill: var(--text);
		font-size: 12px;
		font-weight: 600;
		pointer-events: none;
	}
	.kind {
		fill: var(--muted);
		font-size: 11px;
		pointer-events: none;
	}
	.label {
		fill: var(--muted);
		font-size: 11px;
		pointer-events: none;
	}
	.label.end {
		text-anchor: end;
	}
	.message {
		fill: #f85149;
		font-size: 11px;
		/* A halo of the canvas's colour, so that it reads over a node it runs across */
		stroke: #0d1117;
		stroke-width: 3px;
		stroke-linejoin: round;
		paint-order: stroke;
	}
	.fix {
		cursor: pointer;
		outline: none;
	}
	.fix rect {
		fill: #1f6feb40;
		stroke: var(--accent);
	}
	.fix:hover rect,
	.fix:focus-visible rect {
		fill: #1f6feb80;
		stroke-width: 2;
	}
	.fix text {
		fill: var(--text);
		font-size: 11px;
		text-anchor: middle;
		pointer-events: none;
	}
	.port {
		fill: #0d1117;
		stroke: var(--muted);
		stroke-width: 1.5;
		cursor: crosshair;
	}
	.port.wired {
		fill: var(--muted);
	}
	.port.probed {
		fill: #d29922;
		stroke: #d29922;
	}
	.inspector {
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 0.6rem;
		min-height: 0;
		overflow: auto;
		font-size: 0.85rem;
	}
	.inspector h3 {
		margin: 0 0 0.2rem;
		font-size: 0.95rem;
	}
	.inspector h3 .muted {
		font-weight: 400;
		font-size: 0.8rem;
	}
	.about {
		margin: 0 0 0.4rem;
		font-size: 0.78rem;
	}
	button.fix {
		margin: 0 0 0.3rem;
		border-color: var(--accent);
	}
	.inspector h4 {
		margin: 0.7rem 0 0.2rem;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.inspector label {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.25rem;
	}
	.inspector input,
	.inspector select {
		width: 8rem;
		min-width: 0;
	}
	.input {
		display: grid;
		grid-template-columns: 4.6rem 1fr;
		align-items: center;
		gap: 0.25rem;
		margin-bottom: 0.35rem;
	}
	.input .name {
		overflow-wrap: anywhere;
	}
	.unit {
		margin-left: 0.3rem;
		color: var(--muted);
		font-size: 0.75rem;
	}
	.input input {
		grid-column: 2;
		width: auto;
	}
	.range {
		grid-column: 2;
		margin-top: -0.15rem;
		color: var(--muted);
		font-size: 0.72rem;
	}
	.input button {
		grid-column: 1 / -1;
	}
	.input select {
		width: auto;
	}
	fieldset {
		border: 1px solid var(--line);
		border-radius: 4px;
		margin: 0 0 0.4rem;
		padding: 0.3rem 0.4rem;
		min-width: 0;
	}
	.zone {
		border-left: 2px solid var(--line);
		padding-left: 0.3rem;
		margin-bottom: 0.4rem;
	}
	.zone select {
		width: 100%;
	}
	.zone input {
		width: 3.2rem;
	}
	.zone label {
		justify-content: flex-start;
	}
	.inspector input[type='checkbox'] {
		width: auto;
	}
	fieldset.bare {
		border: 0;
		margin: 0;
		padding: 0;
	}
</style>
