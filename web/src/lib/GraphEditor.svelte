<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { clipboard } from '#lib/Clipboard.ts';
	import ContextMenu, { type MenuItem } from '#lib/ContextMenu.svelte';
	import {
		addNode,
		addZone,
		boundsOf,
		COLUMN,
		connect,
		copyNodes,
		detailOf,
		disconnect,
		edgeInto,
		freeSpot,
		inputsOf,
		insertSnap,
		isPort,
		moveNodes,
		NODE_HEADER,
		NODE_WIDTH,
		nodeHeight,
		nodesTouching,
		optionsOf,
		outputsOf,
		parseCurve,
		pasteNodes,
		placed,
		PORT_SPACING,
		rateErrorInput,
		removeNodes,
		removeZone,
		setField,
		setLiteral,
		setOption,
		setZone,
		tidy,
		whyCompiledAway,
		zonesOf,
		type Box,
		type CatalogEntry,
		type CopiedNodes,
		type GraphNode,
		type LibraryPatch,
		type Point
	} from '#lib/GraphEdit.ts';
	import { friendlyName, helpOf, rangeText, shown } from '#lib/NodeHelp.ts';
	import NodePalette from '#lib/NodePalette.svelte';
	import type { Probe } from '#lib/AudioEngine.ts';
	import { label, matches, modHeld, modKey, typingIn } from '#lib/Shortcuts.ts';
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
		tab = $bindable('patch'),
		side,
		json,
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
		tab?: SideTab; // What the side column shows, kept by the page from one patch to the next
		side?: Snippet; // Drawn above the inspector
		json?: Snippet; // The patch's JSON, in the side column's last tab
		onchange: (graph: Graph) => void;
		onprobes: (probes: Probe[]) => void;
	} = $props();

	// What the side column shows: what is chosen on the canvas, the patch's parameters, or its JSON, beside the graph.
	export type SideTab = 'node' | 'patch' | 'json';

	// A wire, by the input it goes into, since an input takes one wire.
	type WireEnd = { to: number; input: string };

	type Gesture =
		| { kind: 'pan'; from: Point; view: Point }
		// The chosen nodes dragged, or their copies with Mod held. Nothing moves until the pointer has gone further than a click.
		| { kind: 'move'; ids: number[]; client: Point; start: Point; by: Point; moved: boolean }
		| { kind: 'box'; from: Point; at: Point } // Shift-drag on empty canvas
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
	const DRAG = 3; // CSS pixels a press goes before it is a drag, so that a click doesn't move a node by a pixel
	const COPY_STEP = 24; // Below and right of the nodes copied, where a duplicate or a paste goes if there is room

	let svg: SVGSVGElement;
	let size = $state({ width: 1000, height: 560 }); // Of the canvas on screen, in CSS pixels
	let view = $state({ x: -30, y: -30, scale: 1 }); // The graph point at the canvas's top left, and CSS pixels to a unit
	let selection = $state(new Set<number>()); // The chosen nodes' ids, replaced whole on each change
	let chosenWire = $state<WireEnd | null>(null); // Or a wire, which is chosen on its own
	let gesture = $state<Gesture | null>(null);
	let copying = $state.raw<Graph | null>(null); // While Mod-drag copies: the graph with the copies in it, which are what move
	let palette = $state<Palette | null>(null);
	let menu = $state<{ x: number; y: number; label: string; items: MenuItem[] } | null>(null);
	let hover: { x: number; y: number } | null = null; // The pointer over the canvas, where N opens the search and Mod+V pastes

	// A graph opens on its patch, or on its JSON if that was open for the last one, since nothing in it is chosen yet.
	if (untrack(() => tab) === 'node') tab = 'patch';

	const heightOf = (node: GraphNode) => nodeHeight(node, catalog, library);
	const sizeOf = (node: GraphNode) => ({ width: NODE_WIDTH, height: heightOf(node) });
	const laid = $derived(copying ?? placed(graph, heightOf));
	const others = $derived(library.filter((patch) => patch.id !== self));
	const types = $derived(catalog.map((entry) => entry.type));
	// What is chosen and still there, after an undo or an edit to the JSON took some of it away.
	const picked = $derived(laid.nodes.filter((node) => selection.has(node.id)));
	const chosen = $derived(picked.length === 1 ? picked[0] : null);
	// Delete takes all of several, but the nodes the patch is played and wired through. One on its own goes, whatever it is.
	const deletable = $derived(picked.length > 1 ? picked.filter((node) => !isPort(node)) : picked);
	const kept = $derived(picked.length > 1 ? picked.filter(isPort) : []);
	const keptText = $derived.by(() => {
		const names = kept.map((node) => `${friendlyName(node.type)} ${node.id}`);
		const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
		const [stay, them] = names.length === 1 ? ['stays', 'it'] : ['stay', 'them'];
		return `${list} ${stay}, since the patch is played and wired through ${them}. Choose one on its own to delete it.`;
	});
	const modName = modKey() === 'Meta' ? '⌘' : 'Ctrl';
	const boxOf = (box: { from: Point; at: Point }): Box => ({
		x: Math.min(box.from.x, box.at.x),
		y: Math.min(box.from.y, box.at.y),
		width: Math.abs(box.at.x - box.from.x),
		height: Math.abs(box.at.y - box.from.y)
	});
	// What a box being drawn would choose, shown chosen as it is drawn.
	const boxed = $derived(gesture?.kind === 'box' ? new Set(nodesTouching(laid, boxOf(gesture), heightOf)) : null);
	const moving = (id: number) => gesture?.kind === 'move' && gesture.ids.includes(id);
	const looksChosen = (id: number) => (boxed ? boxed.has(id) : selection.has(id) || moving(id));

	// The chosen wire, if it is still there: what it joins, how often it is read, and the value its input goes back to without it.
	const wireShown = $derived.by(() => {
		const edge = chosenWire ? edgeInto(laid, chosenWire.to, chosenWire.input) : undefined;
		const from = laid.nodes.find((node) => node.id === edge?.from);
		const to = laid.nodes.find((node) => node.id === edge?.to);
		if (!edge || !from || !to) return null;
		const port = edge.port ?? 'out';
		const input = edge.input ?? 'in';
		const own =
			to.inputs?.[input] ?? inputsOf(to, catalog, library).find((candidate) => candidate.name === input)?.default;
		return { from, port, to, input, own, rate: nodes?.[from.id]?.ports[port]?.rate };
	});

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
		gesture?.kind === 'move' && gesture.moved && gesture.ids.includes(node.id)
			? { x: (node.x as number) + gesture.by.x, y: (node.y as number) + gesture.by.y }
			: { x: node.x as number, y: node.y as number };
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

	// What is chosen: some nodes, one wire, or nothing. The side column follows, to what is chosen or back to the patch, unless
	// it shows the JSON, which stays open until another tab is.
	function select(ids: Iterable<number> = [], wire: WireEnd | null = null) {
		selection = new Set(ids);
		chosenWire = wire;
		const any = selection.size > 0 || wire !== null;
		if (any && tab === 'patch') tab = 'node';
		else if (!any && tab === 'node') tab = 'patch';
	}

	// A right-click, or a Ctrl-click on a Mac, opens a menu, and starts nothing.
	const menuing = (event: PointerEvent) =>
		event.button === 2 || (event.button === 0 && event.ctrlKey && modKey() === 'Meta');

	function startPan(event: PointerEvent) {
		gesture = { kind: 'pan', from: { x: event.clientX, y: event.clientY }, view: { x: view.x, y: view.y } };
	}

	// A press on empty canvas lets go of what was chosen, and a drag from there pans. With Shift it draws a box instead, which
	// chooses the nodes it touches. The middle button pans and leaves what is chosen.
	function pressCanvas(event: PointerEvent) {
		if (menuing(event)) return;
		if (event.button !== 0) return startPan(event);
		if (event.shiftKey) {
			const from = toCanvas(event);
			gesture = { kind: 'box', from, at: { ...from } };
			return;
		}
		select();
		startPan(event);
	}

	// A press on a wire chooses it, and a drag from there pans, as from empty canvas. With Shift it's the canvas's, a box.
	function pressWire(event: PointerEvent, wire: WireEnd) {
		if (event.shiftKey && !menuing(event)) return;
		event.stopPropagation();
		select([], wire);
		if (!menuing(event)) startPan(event);
	}

	// A node on its own, or with Shift added to what is chosen or taken away from it, by a click or by Enter on its title.
	function chooseNode(node: GraphNode, adding: boolean) {
		if (!adding) return select([node.id]);
		const next = new Set(selection);
		if (next.has(node.id)) next.delete(node.id);
		else next.add(node.id);
		select(next);
	}

	// A press on a node chooses it, and Shift adds it to what is chosen or takes it away. A drag moves everything chosen, as one
	// edit, and with Mod held it moves copies of them instead, as Mod-drag copies notes and clips.
	function pressNode(event: PointerEvent, node: GraphNode) {
		event.stopPropagation();
		if (event.shiftKey && !menuing(event)) return chooseNode(node, true);
		if (!selection.has(node.id)) select([node.id]);
		if (readonly || menuing(event)) return;
		let ids = picked.map((candidate) => candidate.id);
		if (modHeld(event)) {
			const copied = copyNodes(laid, ids, self);
			if (!copied) return;
			const base = pasteNodes(laid, copied, self, { x: 0, y: 0 });
			if (!base.ids.length) return; // Only the out node, which a patch has one of
			copying = base.graph;
			ids = base.ids;
		}
		const client = { x: event.clientX, y: event.clientY };
		gesture = { kind: 'move', ids, client, start: toCanvas(event), by: { x: 0, y: 0 }, moved: false };
	}

	function cancelGesture() {
		gesture = null;
		copying = null;
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
			gesture.moved ||= Math.hypot(event.clientX - gesture.client.x, event.clientY - gesture.client.y) > DRAG;
			gesture.by = { x: pointer.x - gesture.start.x, y: pointer.y - gesture.start.y };
		} else {
			gesture.at = toCanvas(event);
		}
	}

	function pointerUp(event: PointerEvent) {
		if (gesture?.kind === 'move') {
			const { ids, by, moved } = gesture;
			const base = laid; // With the copies in it, while Mod-drag copies
			const copied = copying !== null;
			cancelGesture();
			const [dx, dy] = [Math.round(by.x), Math.round(by.y)];
			if (!moved || (!dx && !dy)) return;
			commit(moveNodes(base, ids, dx, dy));
			if (copied) select(ids);
			return;
		} else if (gesture?.kind === 'box') {
			select(nodesTouching(laid, boxOf(gesture), heightOf));
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
		revealBox({ x: node.x as number, y: node.y as number, width: NODE_WIDTH, height: heightOf(node) });
	}

	// Pasted nodes come into view the same way, and if they can't all be seen at once, their top left does.
	function revealBox(box: Box) {
		const width = size.width / view.scale;
		const height = size.height / view.scale;
		const into = (start: number, length: number, at: number, extent: number) =>
			at >= start && at + extent <= start + length
				? start
				: at < start || extent + 2 * MARGIN > length
					? at - MARGIN
					: at + extent + MARGIN - length;
		view = { ...view, x: into(view.x, width, box.x, box.width), y: into(view.y, height, box.y, box.height) };
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
		select([id]);
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

	// Delete takes the chosen wire, which leaves its input at its own value, or the chosen nodes with their wires and probes,
	// as one edit.
	function removeChosen() {
		if (wireShown) {
			const { to, input } = wireShown;
			select();
			commit(disconnect(laid, to.id, input));
			return;
		}
		const ids = new Set(deletable.map((node) => node.id));
		if (!ids.size) return;
		const left = probes.filter((probe) => !ids.has(probe.node));
		if (left.length !== probes.length) onprobes(left);
		select();
		commit(removeNodes(laid, ids));
	}

	const chosenIds = () => picked.map((node) => node.id);

	// The page keeps what is copied, so it can be pasted into another patch as well as this one.
	function copyChosen(): boolean {
		const copied = copyNodes(laid, chosenIds(), self);
		if (copied) clipboard.nodes = copied;
		return copied !== null;
	}

	// Pasted nodes go where the pointer is, and otherwise a little below and right of where they were copied from, at the
	// nearest place where they cover no node. They come chosen, and into view.
	function paste(copied: CopiedNodes | null, pointer: Point | null) {
		if (!copied || readonly) return;
		const box = boundsOf(copied.nodes, heightOf);
		const want = pointer
			? { x: pointer.x - NODE_WIDTH / 2, y: pointer.y - NODE_HEADER / 2 }
			: { x: box.x + COPY_STEP, y: box.y + COPY_STEP };
		const spot = freeSpot(laid, want, box, sizeOf);
		const { graph: next, ids } = pasteNodes(laid, copied, self, { x: spot.x - box.x, y: spot.y - box.y });
		if (!ids.length) return;
		commit(next);
		select(ids);
		revealBox({ ...box, x: spot.x, y: spot.y });
	}

	const duplicateChosen = () => paste(copyNodes(laid, chosenIds(), self), null);

	const pointerOnCanvas = () => (hover ? toCanvas({ clientX: hover.x, clientY: hover.y }) : null);

	// N and the full stop go by where the key is, as the piano keys do, and take no modifier, which leaves them to the browser.
	// Esc lets go of one thing at a time: a drag, then what is chosen. Mod with A, V or D is kept from the browser, which would
	// choose the page's text or bookmark the page, and so is Mod+C when there is something chosen to copy.
	function keydown(event: KeyboardEvent) {
		if (!active || typingIn(event.target)) return;
		if (matches(event, 'escape')) {
			if (event.defaultPrevented) return; // Something nearer the top of the page let go of something
			if (gesture) cancelGesture();
			else if (selection.size || chosenWire) select();
		} else if (matches(event, 'fit')) {
			event.preventDefault();
			fit();
		} else if (matches(event, 'select-all')) {
			event.preventDefault();
			select(laid.nodes.map((node) => node.id));
		} else if (matches(event, 'copy')) {
			if (copyChosen()) event.preventDefault();
		} else if (matches(event, 'paste')) {
			event.preventDefault();
			paste(clipboard.nodes, pointerOnCanvas());
		} else if (matches(event, 'duplicate')) {
			event.preventDefault();
			duplicateChosen();
		} else if (readonly) {
			return;
		} else if (matches(event, 'node-search')) {
			event.preventDefault();
			openPalette(hover);
		} else if ((matches(event, 'graph.delete') || matches(event, 'graph.backspace')) && (picked.length || wireShown)) {
			event.preventDefault();
			removeChosen();
		}
	}

	// A right-click opens a menu for what is under it: the nodes chosen, a wire, or the canvas. Delete there deletes, as the
	// key does.
	function contextMenu(event: MouseEvent) {
		cancelGesture();
		const target = event.target as Element;
		const nodeId = target.closest('g.node')?.getAttribute('data-node');
		const wireKey = target.closest('[data-wire]')?.getAttribute('data-wire');
		const node = laid.nodes.find((candidate) => String(candidate.id) === nodeId);
		const wire = wires.find((candidate) => candidate.key === wireKey);
		const open = (label: string, items: MenuItem[]) => {
			event.preventDefault();
			menu = { x: event.clientX, y: event.clientY, label, items };
		};
		if (node) {
			if (!selection.has(node.id)) select([node.id]);
			open(picked.length > 1 ? `${picked.length} nodes` : `${friendlyName(node.type)} ${node.id}`, nodeItems());
		} else if (wire) {
			select([], { to: wire.to, input: wire.input });
			if (!readonly) open('Wire', wireItems());
		} else if (!readonly) {
			const at = toCanvas(event);
			const client = { x: event.clientX, y: event.clientY };
			open('Graph', [
				{ label: 'Paste', disabled: !clipboard.nodes, action: () => paste(clipboard.nodes, at) },
				{ label: 'Add a node…', action: () => openPalette(client) }
			]);
		}
	}

	const nodeItems = (): MenuItem[] => [
		{ label: 'Copy', action: copyChosen },
		...(readonly
			? []
			: [
					{ label: 'Duplicate', action: duplicateChosen },
					{
						label: deletable.length > 1 ? `Delete ${deletable.length} nodes` : 'Delete',
						disabled: !deletable.length,
						action: removeChosen
					}
				])
	];

	function wireItems(): MenuItem[] {
		const snap = wireShown && snapFor(wireShown.to) === wireShown.input ? wireShown : null;
		return [
			{ label: 'Delete', action: removeChosen },
			...(snap ? [{ label: 'Put a snap on this wire', action: () => putSnap(snap.to, snap.input) }] : [])
		];
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
			select([node.id]);
			tab = 'node';
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

	<div class="editor" class:wide={tab === 'json'}>
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
				onpointerdown={pressCanvas}
				onpointermove={pointerMove}
				onpointerleave={() => (hover = null)}
				ondblclick={(event) => {
					if (!(event.target as Element).closest('g.node')) openPalette({ x: event.clientX, y: event.clientY });
				}}
				onwheel={wheel}
				oncontextmenu={contextMenu}
			>
				<!-- Each wire is hit on a wide stroke that can't be seen, under the one that can, so it takes no aim to click. -->
				{#each wires as wire (wire.key)}
					{@const on = wireShown?.to.id === wire.to && wireShown.input === wire.input}
					<path
						class="hit"
						d={wire.path}
						role="presentation"
						data-wire={wire.key}
						data-testid={`hit-${wire.to}-${wire.input}`}
						onpointerdown={(event) => pressWire(event, wire)}
					/>
					<path
						class={`wire ${wire.rate}`}
						class:chosen={on}
						d={wire.path}
						data-testid={`wire-${wire.to}-${wire.input}`}
						data-chosen={on}
					/>
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
						class:chosen={looksChosen(node.id)}
						class:dead
						class:problem={problem !== undefined}
						transform={`translate(${at.x} ${at.y})`}
						data-testid={`node-${node.id}`}
						data-node={node.id}
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
							onpointerdown={(event) => pressNode(event, node)}
						/>
						<rect
							class="title"
							width={NODE_WIDTH}
							height={NODE_HEADER - 4}
							rx="5"
							role="button"
							tabindex="0"
							aria-label={`${friendlyName(node.type)}, ${node.type} ${node.id}`}
							onpointerdown={(event) => pressNode(event, node)}
							onfocus={(event) => {
								if (event.currentTarget.matches(':focus-visible')) reveal(node);
							}}
							onkeydown={(event) => {
								if (event.key === 'Enter') chooseNode(node, event.shiftKey);
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
				{#if gesture?.kind === 'box'}
					{@const box = boxOf(gesture)}
					<rect class="box" x={box.x} y={box.y} width={box.width} height={box.height} data-testid="box" />
				{/if}
			</svg>
			{#if menu}
				<ContextMenu x={menu.x} y={menu.y} label={menu.label} items={menu.items} onclose={() => (menu = null)} />
			{/if}
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
			<div class="tabs" role="tablist" aria-label="Side column">
				<button type="button" role="tab" aria-selected={tab === 'node'} onclick={() => (tab = 'node')}
					>{wireShown ? 'Wire' : picked.length > 1 ? 'Nodes' : 'Node'}</button
				>
				<button type="button" role="tab" aria-selected={tab === 'patch'} onclick={() => (tab = 'patch')}>Patch</button>
				{#if json}
					<button type="button" role="tab" aria-selected={tab === 'json'} onclick={() => (tab = 'json')}>JSON</button>
				{/if}
			</div>
			{#if tab === 'json' && json}
				<div class="panel json" role="tabpanel" aria-label="JSON">{@render json()}</div>
			{:else}
				<div class="panel" role="tabpanel" aria-label={tab === 'node' ? 'What is chosen' : 'Patch'}>
					{@render side?.()}
					{#if tab === 'node' && wireShown}
						{@const { from, port, to, input, own, rate } = wireShown}
						{@const unit = helpOf(to.type)?.inputs[input]?.unit}
						<h3>Wire</h3>
						<p class="joins" data-testid="wire-joins">
							<strong>{friendlyName(from.type)} {from.id}</strong>
							{port} → <strong>{friendlyName(to.type)} {to.id}</strong>
							{input}
						</p>
						{#if rate}<p class="muted about">{rate === 'audio' ? 'Audio, every sample.' : 'Read once a frame.'}</p>{/if}
						{#if !readonly}
							{#if snapFor(to) === input}
								<button type="button" class="fix" onclick={() => putSnap(to, input)}>Put a snap on this wire</button>
							{/if}
							{#if own !== undefined}
								<p class="muted about">
									Without it, {input} takes its own value, {shown(own)}{unit ? ` ${unit}` : ''}.
								</p>
							{/if}
							<button type="button" onclick={removeChosen}>Delete wire</button>
						{/if}
					{:else if tab === 'node' && picked.length > 1}
						<h3>{picked.length} nodes</h3>
						{#if !readonly}
							{#if kept.length}<p class="muted about" data-testid="kept">{keptText}</p>{/if}
							<button type="button" onclick={removeChosen} disabled={!deletable.length}
								>Delete {deletable.length} node{deletable.length === 1 ? '' : 's'}</button
							>
						{/if}
						<p class="muted about">
							{readonly
								? `${label('copy')} copies them, to paste into a patch of your own.`
								: `Drag one to move them all, or hold ${modName} to drag copies. ${label('copy')} copies them for this patch or another.`}
						</p>
						<ul class="picked">
							{#each picked as node (node.id)}
								<li>
									<button type="button" onclick={() => select([node.id])}
										>{friendlyName(node.type)} <span class="muted">{node.type} {node.id}</span></button
									>
								</li>
							{/each}
						</ul>
					{:else if tab === 'node' && chosen}
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
												setOption(
													laid,
													chosen.id,
													'curve',
													parseCurve(e.currentTarget.value) as never,
													catalog,
													library
												)
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
														setZone(laid, chosen.id, index, {
															velocities: [Number(e.currentTarget.value), velocities[1]]
														})
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
														setZone(laid, chosen.id, index, {
															velocities: [velocities[0], Number(e.currentTarget.value)]
														})
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
											<button type="button" onclick={() => commit(removeZone(laid, chosen.id, index))}
												>Remove zone</button
											>
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
						{#if !readonly}<button type="button" onclick={removeChosen}>Delete node</button>{/if}
					{:else if tab === 'node'}
						<p class="muted">
							Choose a node or a wire to see it here. Shift-drag a box or Shift-click to choose several, and {label(
								'select-all'
							)} chooses every node.
						</p>
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
				</div>
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
	/* JSON reads better wider, and the graph keeps most of the width */
	.editor.wide {
		grid-template-columns: minmax(0, 1fr) 360px;
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
		pointer-events: none;
	}
	/* As wide on screen at any zoom, so a wire zoomed out is as easy to hit */
	.hit {
		fill: none;
		stroke: transparent;
		stroke-width: 12px;
		vector-effect: non-scaling-stroke;
		pointer-events: stroke;
		cursor: pointer;
	}
	.hit:hover + .wire {
		stroke-width: 2.6;
	}
	.wire.chosen,
	.hit:hover + .wire.chosen {
		stroke: var(--text);
		stroke-width: 3;
	}
	/* As the piano roll draws its box */
	.box {
		fill: #58a6ff20;
		stroke: var(--accent);
		pointer-events: none;
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
		stroke-width: 2;
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
		display: flex;
		flex-direction: column;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 6px;
		min-height: 0;
		overflow: hidden;
		font-size: 0.85rem;
	}
	.tabs {
		flex: none;
		display: flex;
		border-bottom: 1px solid var(--line);
	}
	.tabs button {
		flex: 1;
		border: 0;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		background: transparent;
		padding: 0.35rem 0.4rem;
		font-size: 0.78rem;
		color: var(--muted);
	}
	.tabs button[aria-selected='true'] {
		color: var(--text);
		border-bottom-color: var(--accent);
	}
	.panel {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 0.6rem;
	}
	.panel.json {
		display: flex;
		flex-direction: column;
		padding: 0.4rem;
		overflow: hidden;
	}
	.joins {
		margin: 0 0 0.3rem;
		font-size: 0.8rem;
	}
	.picked {
		list-style: none;
		margin: 0.4rem 0;
		padding: 0;
	}
	.picked button {
		width: 100%;
		border: 0;
		background: transparent;
		padding: 0.1rem 0.2rem;
		text-align: left;
		font-size: 0.8rem;
	}
	.picked button:hover {
		background: #1f6feb33;
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
