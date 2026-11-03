<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { Ring } from '#lib/ScopeMath.ts';

	// A level meter on a tap, as a DAW puts on every track. It reads only samples that arrived since the last frame, so a tap
	// that stops sending falls to silence instead of holding its last level.
	//
	// The master's meter has a light for the limiter after the engine, which turns the song down to keep it at full scale. The
	// engine says the most it turned down since it last said anything, which comes and goes many times a second, so the light
	// holds a moment after the last time, as a DAW's clip light does, with the most it turned down in its tooltip.
	let {
		ring,
		label,
		limiter
	}: {
		ring: Ring | null;
		label: string;
		// The engine's latest state, whose `limited` is the lowest gain the limiter used since the one before, or 1 if it turned
		// nothing down. Each state is a new object, so the same gain twice still holds the light. A meter without it has no light.
		limiter?: { limited: number } | null;
	} = $props();

	const FLOOR = -60; // dB at the left end
	const CEILING = 6;
	const FALL = 0.9; // Of the level kept each frame, so a peak falls about 20 dB a second
	const HOLD = 1500; // ms the limiting light stays on after the limiter last turned the song down

	let peak = $state(0);
	let loudest = $state(0); // Held since Play or since the image playing now began, as the ring keeps it
	let read = 0;
	let held = $state(1); // The lowest gain while the light has been on, or 1 while it is off
	let heldUntil = 0;

	const decibels = (level: number) => (level > 0 ? 20 * Math.log10(level) : -Infinity);
	const loud = (level: number) => (level > 0 ? `${decibels(level).toFixed(1)} dB` : 'silent');
	const share = (level: number) => Math.max(0, Math.min(1, (decibels(level) - FLOOR) / (CEILING - FLOOR)));

	$effect(() => {
		const gain = limiter?.limited ?? 1;
		if (gain >= 1) return;
		untrack(() => {
			const now = performance.now();
			held = now < heldUntil ? Math.min(held, gain) : gain;
			heldUntil = now + HOLD;
		});
	});

	onMount(() => {
		let frame = requestAnimationFrame(function loop() {
			let level = 0;
			if (ring) {
				const newest = ring.newest;
				const from = Math.max(read, newest - ring.capacity + 1);
				for (let i = from; i < newest; ++i) level = Math.max(level, Math.abs(ring.at(i)));
				read = newest;
			}
			peak = Math.max(level, peak * FALL < 1e-6 ? 0 : peak * FALL);
			loudest = ring?.loudest ?? 0;
			if (held < 1 && performance.now() >= heldUntil) held = 1;
			frame = requestAnimationFrame(loop);
		});
		return () => cancelAnimationFrame(frame);
	});
</script>

<div class="level">
	<div
		class="meter"
		class:off={!ring}
		role="meter"
		aria-label={label}
		aria-valuemin={0}
		aria-valuemax={1}
		aria-valuenow={peak}
		title={ring ? `${loud(peak)}, and loudest since Play ${loud(loudest)}` : 'No meter until audio starts'}
		data-testid="meter"
		data-peak={peak}
		data-loudest={loudest}
	>
		<div class="fill" class:hot={peak > 1} style:width="{share(peak) * 100}%"></div>
		<div class="zero" style:left="{share(1) * 100}%"></div>
	</div>
	{#if limiter !== undefined}
		<span
			class="limit"
			class:on={held < 1}
			role="img"
			aria-label={held < 1 ? `Limiting ${decibels(held).toFixed(1)} dB` : 'Not limiting'}
			title={held < 1
				? `Limiting: the limiter turned the song down by as much as ${(-decibels(held)).toFixed(1)} dB to keep it at full scale`
				: 'Lights when the limiter turns the song down to keep it at full scale'}
			data-testid={held < 1 ? 'limiting' : undefined}
		></span>
	{/if}
</div>

<style>
	.level {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}
	.meter {
		position: relative;
		flex: 1;
		min-width: 0;
		height: 4px;
		background: #0d1117;
		border-radius: 2px;
		overflow: hidden;
	}
	.meter.off {
		opacity: 0.4;
	}
	.fill {
		height: 100%;
		background: linear-gradient(90deg, #3fb950 0%, #3fb950 75%, #d29922 90%);
		background-size: 100vw 100%;
	}
	.fill.hot {
		background: #f85149;
	}
	.zero {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: #ffffff40;
	}
	.limit {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #30363d;
	}
	.limit.on {
		background: #f0883e;
		box-shadow: 0 0 4px #f0883e;
	}
</style>
