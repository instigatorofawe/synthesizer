// What a parameter's slider shows and saves: its value in words, with the unit of the input it drives, a value typed in, and
// where the song keeps it. A Control on a track saves into the song as a mixer knob does, the track's `params` or for a
// global the song's `globals`, and Make default writes the patch's own default, which every song that holds no value of its
// own plays.
import { helpOf, shown } from '#lib/NodeHelp.ts';
import type { Graph, Param, Timeline } from '#lib/Schema.ts';
import { setGlobal, setTrackParam } from '#lib/TimelineEdit.ts';

// The unit of what a parameter drives, as NodeHelp gives it for the inputs its param nodes are wired to, or '' when they are
// wired to nothing with a unit, or to inputs with different ones. A param node carries its parameter's id as `param`.
export function unitOf(graph: Graph, id: number): string {
	const sources = new Set(
		graph.nodes.filter((node) => node.type === 'param' && node.param === id).map((node) => node.id)
	);
	const units = new Set<string>();
	for (const edge of graph.edges) {
		if (!sources.has(edge.from)) continue;
		const to = graph.nodes.find((node) => node.id === edge.to);
		units.add((to && edge.input && helpOf(to.type)?.inputs[edge.input]?.unit) || '');
	}
	return units.size === 1 ? [...units][0] : '';
}

// A value as a slider shows it, rounded as the inspector rounds an input's, with its unit. A ratio's × goes against the number.
export function valueText(value: number, unit = ''): string {
	if (!unit) return shown(value);
	return unit === '×' ? `${shown(value)}×` : `${shown(value)} ${unit}`;
}

// A value typed for a parameter, kept to its range, or null for text that isn't a number. A unit typed after it is let be.
export function typedValue(text: string, param: Pick<Param, 'min' | 'max'>): number | null {
	const value = Number.parseFloat(text.trim().replace(/^\+/, ''));
	if (!Number.isFinite(value)) return null;
	return Math.min(param.max, Math.max(param.min, value));
}

// What the song holds for a parameter on a track: the track's own value, or the song's for a global. Undefined when it holds
// none, which plays the patch's default.
export function songValue(doc: Timeline, track: number, param: Pick<Param, 'id' | 'scope'>): number | undefined {
	const held = param.scope === 'global' ? doc.globals : doc.tracks.find((t) => t.id === track)?.params;
	return held?.[String(param.id)];
}

// The song with a parameter's value set on a track, or the song's for a global, or taken away with undefined, so the patch's
// default plays there again.
export function setSongValue(
	doc: Timeline,
	track: number,
	param: Pick<Param, 'id' | 'scope'>,
	value: number | undefined
): Timeline {
	const key = String(param.id);
	if (param.scope === 'global') {
		if (value !== undefined) return setGlobal(doc, param.id, value);
		if (!(key in doc.globals)) return doc;
		const { [key]: _, ...globals } = doc.globals;
		return { ...doc, globals };
	}
	if (value !== undefined) return setTrackParam(doc, track, param.id, value);
	const held = doc.tracks.find((t) => t.id === track);
	if (!held || !(key in held.params)) return doc;
	const { [key]: _, ...params } = held.params;
	return { ...doc, tracks: doc.tracks.map((t) => (t === held ? { ...t, params } : t)) };
}

// The patch with a parameter's default made `value`, kept to its range.
export function withDefault(graph: Graph, id: number, value: number): Graph {
	return {
		...graph,
		params: graph.params.map((param) =>
			param.id === id ? { ...param, default: Math.min(param.max, Math.max(param.min, value)) } : param
		)
	};
}
