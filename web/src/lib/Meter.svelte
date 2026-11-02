<script lang="ts">
	import { onMount } from 'svelte';
	import type { Ring } from '#lib/ScopeMath.ts';

	// A level meter on a tap, as a DAW puts on every track. It reads only samples that arrived since the last frame, so a tap
	// that stops sending falls to silence instead of holding its last level.
	let { ring, label }: { ring: Ring | null; label: string } = $props();

	const FLOOR = -60; // dB at the left end
	const CEILING = 6;
	const FALL = 0.9; // Of the level kept each frame, so a peak falls about 20 dB a second

	let peak = $state(0);
	let read = 0;

	const decibels = (level: number) => (level > 0 ? 20 * Math.log10(level) : -Infinity);
	const share = (level: number) => Math.max(0, Math.min(1, (decibels(level) - FLOOR) / (CEILING - FLOOR)));

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
			frame = requestAnimationFrame(loop);
		});
		return () => cancelAnimationFrame(frame);
	});
</script>

<div
	class="meter"
	class:off={!ring}
	role="meter"
	aria-label={label}
	aria-valuemin={0}
	aria-valuemax={1}
	aria-valuenow={peak}
	title={ring ? (peak > 0 ? `${decibels(peak).toFixed(1)} dB` : 'silent') : 'No meter until audio starts'}
	data-testid="meter"
	data-peak={peak}
>
	<div class="fill" class:hot={peak > 1} style:width="{share(peak) * 100}%"></div>
	<div class="zero" style:left="{share(1) * 100}%"></div>
</div>

<style>
	.meter {
		position: relative;
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
</style>
