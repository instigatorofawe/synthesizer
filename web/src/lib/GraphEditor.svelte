<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import {
		addNode,
		addZone,
		connect,
		detailOf,
		disconnect,
		edgeInto,
		inputsOf,
		moveNode,
		NODE_HEADER,
		NODE_WIDTH,
		nodeHeight,
		optionsOf,
		outputsOf,
		parseCurve,
		placed,
		PORT_SPACING,
		removeNode,
		removeZone,
		setField,
		setLiteral,
		setOption,
		setZone,
		zonesOf,
		type CatalogEntry,
		type GraphNode,
		type LibraryPatch
	} from '#lib/GraphEdit.ts';
	import type { Probe } from '#lib/AudioEngine.ts';
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
		side?: Snippet; // Drawn above the inspector
		onchange: (graph: Graph) => void;
		onprobes: (probes: Probe[]) => void;
	} = $props();

	type Point = { x: number; y: number };
	type Gesture =
		| { kind: 'pan'; from: Point; view: Point }
		| { kind: 'move'; id: number; offset: Point; at: Point }
		| { kind: 'wire'; from: number; port: string; start: Point; at: Point };

	let svg: SVGSVGElement;
	let view = $state({ x: -30, y: -30, width: 1000, height: 560 });
	let aspect = 0.56; // Of the canvas on screen, height over width, so the view fills it without bars
	let selected = $state<number | null>(null);
	let gesture = $state<Gesture | null>(null);
	let adding = $state('osc');
	let past: Graph[] = [];
	let future: Graph[] = [];
	let canUndo = $state(false);
	let canRedo = $state(false);

	const laid = $derived(placed(graph));
	const others = $derived(library.filter((patch) => patch.id !== self));
	const types = $derived(catalog.map((entry) => entry.type).sort());
	const chosen = $derived(laid.nodes.find((node) => node.id === selected) ?? null);

	function commit(next: Graph) {
		past.push(placed(graph));
		future = [];
		canUndo = true;
		canRedo = false;
		onchange(next);
	}

	function undo() {
		const last = past.pop();
		if (!last) return;
		future.push(placed(graph));
		canUndo = past.length > 0;
		canRedo = true;
		onchange(last);
	}

	function redo() {
		const next = future.pop();
		if (!next) return;
		past.push(placed(graph));
		canUndo = true;
		canRedo = future.length > 0;
		onchange(next);
	}

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
		if (!gesture) return;
		if (gesture.kind === 'pan') {
			const scale = view.width / svg.clientWidth;
			view.x = gesture.view.x - (event.clientX - gesture.from.x) * scale;
			view.y = gesture.view.y - (event.clientY - gesture.from.y) * scale;
		} else if (gesture.kind === 'move') {
			const pointer = toCanvas(event);
			gesture.at = { x: pointer.x - gesture.offset.x, y: pointer.y - gesture.offset.y };
		} else {
			gesture.at = toCanvas(event);
		}
	}

	function pointerUp() {
		if (gesture?.kind === 'move') {
			const node = laid.nodes.find((candidate) => candidate.id === (gesture as { id: number }).id);
			const { id, at } = gesture;
			if (node && (node.x !== at.x || node.y !== at.y)) commit(moveNode(laid, id, Math.round(at.x), Math.round(at.y)));
		}
		gesture = null;
	}

	function finishWire(event: PointerEvent, node: GraphNode, input: string) {
		if (gesture?.kind !== 'wire') return;
		event.stopPropagation();
		commit(connect(laid, gesture.from, gesture.port, node.id, input));
		gesture = null;
	}

	function zoom(event: WheelEvent) {
		event.preventDefault();
		const factor = event.deltaY > 0 ? 1.1 : 1 / 1.1;
		const width = Math.min(4000, Math.max(300, view.width * factor));
		const scale = width / view.width;
		const pointer = toCanvas(event);
		view = {
			x: pointer.x - (pointer.x - view.x) * scale,
			y: pointer.y - (pointer.y - view.y) * scale,
			width,
			height: view.height * scale
		};
	}

	function fit() {
		if (!laid.nodes.length) return;
		const left = Math.min(...laid.nodes.map((node) => node.x as number));
		const top = Math.min(...laid.nodes.map((node) => node.y as number));
		const right = Math.max(...laid.nodes.map((node) => (node.x as number) + NODE_WIDTH));
		const bottom = Math.max(...laid.nodes.map((node) => (node.y as number) + nodeHeight(node, catalog, library)));
		const width = Math.max(right - left + 80, (bottom - top + 80) / aspect, 500);
		view = { x: left - 40, y: top - 40, width, height: width * aspect };
	}

	function add() {
		const { graph: next, id } = addNode(
			laid,
			adding as GraphNode['type'],
			Math.round(view.x + 60),
			Math.round(view.y + 60)
		);
		commit(adding === 'subpatch' && others[0] ? setOption(next, id, 'patch', others[0].id, catalog, library) : next);
		selected = id;
	}

	function removeSelected() {
		if (selected === null) return;
		const id = selected;
		const left = probes.filter((probe) => probe.node !== id);
		if (left.length !== probes.length) onprobes(left);
		commit(removeNode(laid, id));
		selected = null;
	}

	function keydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement;
		if (readonly || !active || target.closest('input, textarea, select')) return;
		if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null) {
			event.preventDefault();
			removeSelected();
		} else if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
			event.preventDefault();
			if (event.shiftKey) redo();
			else undo();
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

	const paramFields = ['name', 'min', 'max', 'default'] as const;

	function changeParam(index: number, change: Partial<Param>) {
		commit({ ...laid, params: laid.params.map((param, i) => (i === index ? { ...param, ...change } : param)) });
	}

	function addParam() {
		const id = Math.max(0, ...laid.params.map((param) => param.id)) + 1;
		const param: Param = { id, name: `param ${id}`, scope: 'track', min: 0, max: 1, default: 0.5, smooth_ms: 10 };
		commit({ ...laid, params: [...laid.params, param] });
	}

	// Twice the drawn size is about as small as a node can be and still be read.
	const READABLE_WIDTH = 2000;

	// The canvas takes whatever room its panel has. The view keeps its width and takes the canvas's shape, so a panel dragged
	// taller shows more below rather than zooming.
	function measure() {
		if (!svg?.clientWidth || !svg.clientHeight) return;
		aspect = svg.clientHeight / svg.clientWidth;
		view = { ...view, height: view.width * aspect };
	}

	$effect(() => {
		// The first view of a graph is all of it, if that can be read, and otherwise where its signals start. Only once, or each
		// edit would move the canvas.
		untrack(() => {
			measure();
			fit();
			if (view.width > READABLE_WIDTH) view = { ...view, width: READABLE_WIDTH, height: READABLE_WIDTH * aspect };
		});
		const observer = new ResizeObserver(measure);
		observer.observe(svg);
		return () => observer.disconnect();
	});
</script>

<svelte:window onkeydown={keydown} onpointerup={pointerUp} />

<div class="grapheditor">
	<div class="toolbar">
		{#if !readonly}
			<select bind:value={adding} aria-label="Node type">
				{#each types as type (type)}<option value={type}>{type}</option>{/each}
			</select>
			<button type="button" onclick={add}>Add node</button>
			<button type="button" onclick={undo} disabled={!canUndo}>Undo</button>
			<button type="button" onclick={redo} disabled={!canRedo}>Redo</button>
		{/if}
		<button type="button" onclick={fit}>Fit</button>
		<span class="muted">
			{readonly
				? 'Drag the background to move around, and scroll to zoom.'
				: 'Drag from an output to an input to wire them.'}
			Green wires are audio, blue are read once a frame.
		</span>
	</div>

	<div class="editor">
		<svg
			bind:this={svg}
			viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
			role="application"
			aria-label="Patch graph"
			data-testid="graph"
			onpointerdown={startPan}
			onpointermove={pointerMove}
			onwheel={zoom}
		>
			{#each wires as wire (wire.key)}
				<path class={`wire ${wire.rate}`} d={wire.path} data-testid={`wire-${wire.to}-${wire.input}`} />
			{/each}
			{#if gesture?.kind === 'wire'}
				<path class="wire drawing" d={curve(gesture.start, gesture.at)} />
			{/if}
			{#each laid.nodes as node (node.id)}
				{@const at = positionOf(node)}
				{@const height = nodeHeight(node, catalog, library)}
				{@const problem = errors.get(node.id)}
				{@const dead = !failed && nodes !== undefined && !nodes[node.id]}
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
						aria-label={`${node.type} ${node.id}`}
						onpointerdown={(event) => startMove(event, node)}
						onkeydown={(event) => {
							if (event.key === 'Enter') selected = node.id;
						}}
					/>
					<text class="heading" x="8" y="16"
						>{node.type} <tspan class="detail">{detailOf(node, laid, library)}</tspan></text
					>
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
					{#if problem}
						<title>{problem}</title>
						<text class="message" x="0" y={height + 13}
							>{problem.length > 44 ? `${problem.slice(0, 43)}…` : problem}</text
						>
					{/if}
				</g>
			{/each}
		</svg>

		<aside class="inspector">
			{@render side?.()}
			{#if chosen}
				<h3>{chosen.id} {chosen.type}</h3>
				{#if errors.get(chosen.id)}<p class="problem" data-testid="node-error">{errors.get(chosen.id)}</p>{/if}
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
									value={chosen[option.name] ?? ''}
									onchange={(e) => optionChanged(chosen, option.name, e.currentTarget.value, option.number)}
								/>
							{/if}
						</label>
					{/each}
					{#if inputsOf(chosen, catalog, library).length}<h4>Inputs</h4>{/if}
					{#each inputsOf(chosen, catalog, library) as input (input.name)}
						<div class="input">
							<span>{input.name}</span>
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
									placeholder={String(input.default)}
									value={chosen.inputs?.[input.name] ?? ''}
									onchange={(e) => literalChanged(chosen, input.name, e.currentTarget.value)}
								/>
							{/if}
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
						{#each paramFields as field (field)}
							<label>
								{field}
								<input
									type={field === 'name' ? 'text' : 'number'}
									step="any"
									aria-label={`param ${param.id} ${field}`}
									value={param[field]}
									onchange={(e) =>
										changeParam(index, {
											[field]: field === 'name' ? e.currentTarget.value : Number(e.currentTarget.value)
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
	.toolbar button,
	.toolbar select {
		padding: 0.1rem 0.5rem;
	}
	.editor {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 260px;
		gap: 0.5rem;
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
	}
	.wire.drawing {
		stroke: var(--text);
		stroke-dasharray: 4 3;
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
	.detail {
		fill: var(--muted);
		font-weight: 400;
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
		margin: 0 0 0.4rem;
		font-size: 0.95rem;
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
		grid-template-columns: 3.6rem 1fr;
		align-items: center;
		gap: 0.25rem;
		margin-bottom: 0.25rem;
	}
	.input input {
		grid-column: 2;
		width: auto;
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
