<script lang="ts">
	import ContextMenu, { type MenuItem } from '#lib/ContextMenu.svelte';
	import ParamSlider from '#lib/ParamSlider.svelte';
	import { unitOf, valueText } from '#lib/ParamValues.ts';
	import type { Graph, Param } from '#lib/Schema.ts';
	import type { Hearing } from '#lib/Workspace.ts';

	// The Patch view's Controls: a slider for each of the patch's parameters, which moves the sound where the patch is heard.
	// On a track of a song that can change, letting go saves the value as the track's, as a mixer knob does, and the slider
	// shows what the song holds. Heard alone, or in an example, it moves the sound and saves nothing, and stays where it was
	// left while the patch is heard there. Make default writes the value into the patch, for every song.
	let {
		id,
		graph,
		hearing,
		values,
		unsaved,
		editable,
		onparam,
		onreset,
		ondefault
	}: {
		id: string; // The patch's
		graph: Graph;
		hearing: Hearing;
		values: Record<string, number>; // What the song holds for these, on the track the patch is heard on
		unsaved: string; // Why a value let go isn't saved, or '' when it is saved into the song
		editable: boolean; // Whether the patch can change, which Make default needs
		onparam: (param: Param, value: number, done: boolean) => void; // Dragged, or let go
		onreset: (param: Param) => void; // The song's own value taken away, so the patch's default plays
		ondefault: (param: Param, value: number) => void;
	} = $props();

	// Where a slider that saves nothing was left, for this patch heard here. Heard somewhere else, they start again.
	const here = $derived(`${id} ${hearing.kind} ${hearing.kind === 'song' ? hearing.id : ''}`);
	let left = $state<{ here: string; values: Record<string, number> }>({ here: '', values: {} });
	const moved = $derived(left.here === here ? left.values : {});

	const nameOf = (param: Param) => param.name || `param ${param.id}`;
	const key = (param: Param) => String(param.id);
	// What the song plays without a slider's move: its own value, or the patch's default.
	const fallback = (param: Param) => values[key(param)] ?? param.default;
	const valueOf = (param: Param) => moved[key(param)] ?? fallback(param);
	const saves = $derived(unsaved === '');
	// Whether there is something to go back from: the song's own value, or a move that wasn't saved.
	const resettable = (param: Param) => (saves ? values[key(param)] !== undefined : moved[key(param)] !== undefined);

	function changed(param: Param, value: number, done: boolean) {
		if (!saves) left = { here, values: { ...moved, [key(param)]: value } };
		onparam(param, value, done);
	}

	function reset(param: Param) {
		if (saves) return onreset(param);
		const { [key(param)]: _, ...rest } = moved;
		left = { here, values: rest };
		onparam(param, fallback(param), false);
	}

	function resetTitle(param: Param, unit: string) {
		if (saves) {
			const track = hearing.kind === 'song' ? hearing.name : 'the track';
			return `Use the patch's default, ${valueText(param.default, unit)}, so ${track} keeps no value of its own`;
		}
		const to = values[key(param)] !== undefined ? "the song's value" : "the patch's default";
		return `Back to ${to}, ${valueText(fallback(param), unit)}`;
	}

	const sliderTitle = $derived(
		saves
			? `Moves the sound as it is dragged, and let go, it is saved with the song as ${hearing.kind === 'song' ? hearing.name : 'the track'}'s value.`
			: unsaved
	);

	let menu = $state<{ x: number; y: number; param: Param } | null>(null);

	function menuItems(param: Param, unit: string): MenuItem[] {
		const value = valueOf(param);
		const back = !saves && values[key(param)] !== undefined ? "the song's value" : 'the default';
		return [
			{
				label: `Back to ${back}, ${valueText(saves ? param.default : fallback(param), unit)}`,
				action: () => reset(param),
				disabled: !resettable(param)
			},
			{ label: 'Make default', action: () => ondefault(param, value), disabled: !editable || value === param.default }
		];
	}
</script>

<h4>Controls</h4>
{#each graph.params as param (param.id)}
	{@const unit = unitOf(graph, param.id)}
	{@const value = valueOf(param)}
	<div
		class="control"
		role="group"
		aria-label={nameOf(param)}
		data-testid={`control-${param.id}`}
		data-own={values[key(param)] !== undefined}
		oncontextmenu={(event) => {
			event.preventDefault();
			menu = { x: event.clientX, y: event.clientY, param };
		}}
	>
		<span class="name" title={nameOf(param)}>{nameOf(param)}</span>
		<ParamSlider
			{param}
			{value}
			{unit}
			label={`Control ${param.name || param.id}`}
			title={sliderTitle}
			oninput={(next) => changed(param, next, false)}
			onchange={(next) => changed(param, next, true)}
		/>
		<button
			type="button"
			class="small reset"
			aria-label={`Reset ${nameOf(param)}`}
			title={resetTitle(param, unit)}
			disabled={!resettable(param)}
			onclick={() => reset(param)}>↺</button
		>
	</div>
	{#if editable && value !== param.default}
		<div class="make">
			<button
				type="button"
				class="small"
				aria-label={`Make default for ${nameOf(param)}`}
				title={`Write ${valueText(value, unit)} into the patch as ${nameOf(param)}'s default, for every song that holds no value of its own`}
				onclick={() => ondefault(param, value)}>Make default</button
			>
		</div>
	{/if}
{/each}
{#if menu}
	{@const unit = unitOf(graph, menu.param.id)}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		label={`Control ${nameOf(menu.param)}`}
		items={menuItems(menu.param, unit)}
		onclose={() => (menu = null)}
	/>
{/if}

<style>
	h4 {
		margin: 0.6rem 0 0.2rem;
		font-size: 0.78rem;
		color: var(--muted);
	}
	.control {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-bottom: 0.2rem;
	}
	.name {
		flex: 0 0 4rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.75rem;
	}
	.small {
		flex: none;
		padding: 0 0.3rem;
		font-size: 0.72rem;
		line-height: 1.3;
	}
	.reset:disabled {
		visibility: hidden;
	}
	.make {
		display: flex;
		justify-content: flex-end;
		margin: -0.1rem 0 0.3rem;
	}
</style>
