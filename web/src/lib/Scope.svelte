<script lang="ts">
	import { onMount } from 'svelte';
	import { columns, findTrigger, Ring } from '#lib/ScopeMath.ts';

	let {
		label,
		ring,
		sampleRate = 48000,
		compact = false
	}: { label: string; ring: Ring; sampleRate?: number; compact?: boolean } = $props();

	const TIMEBASES = [0.001, 0.005, 0.02, 0.1, 0.5, 1];
	let timebase = $state(0.02);
	let level = $state(0);
	let canvas: HTMLCanvasElement;
	let clipped = $state(false);
	let triggered = $state(false);
	let peak = $state(0);

	function draw() {
		const context = canvas.getContext('2d');
		if (!context) return;
		const { width, height } = canvas;
		context.fillStyle = '#0d1117';
		context.fillRect(0, 0, width, height);
		context.strokeStyle = '#21262d';
		context.beginPath();
		context.moveTo(0, height / 2);
		context.lineTo(width, height / 2);
		context.stroke();

		const span = Math.min(Math.round(timebase * sampleRate), ring.capacity - 1);
		if (ring.newest < span) return;
		const trigger = findTrigger(ring, span, level);
		triggered = trigger !== null;
		const start = trigger ?? ring.newest - span;
		const y = (v: number) => height / 2 - (Math.max(-1, Math.min(1, v)) * height) / 2;

		context.strokeStyle = '#3fb950';
		context.beginPath();
		let over = false;
		let loudest = 0;
		columns(ring, start, span, width).forEach(({ min, max }, x) => {
			context.moveTo(x + 0.5, y(max));
			context.lineTo(x + 0.5, Math.max(y(min), y(max) + 1));
			if (max > 1 || min < -1) over = true;
			loudest = Math.max(loudest, Math.abs(min), Math.abs(max));
		});
		context.stroke();
		clipped = over;
		peak = loudest;
	}

	onMount(() => {
		let frame = requestAnimationFrame(function loop() {
			draw();
			frame = requestAnimationFrame(loop);
		});
		return () => cancelAnimationFrame(frame);
	});
</script>

<figure class="scope">
	<figcaption>
		<span>{label}</span>
		<span class="flags">
			{#if clipped}<b class="clip">clip</b>{/if}
			<span class="dim" data-testid="peak" data-peak={peak}>
				{peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dB` : 'silent'}
			</span>
			{#if !compact}<span class:dim={!triggered}>{triggered ? 'trig' : 'auto'}</span>{/if}
		</span>
		{#if !compact}
			<label>
				<select bind:value={timebase} aria-label="Timebase for {label}">
					{#each TIMEBASES as t (t)}
						<option value={t}>{t * 1000} ms</option>
					{/each}
				</select>
			</label>
			<label class="level">
				<input type="range" min="-1" max="1" step="0.01" bind:value={level} aria-label="Trigger level for {label}" />
			</label>
		{/if}
	</figcaption>
	<canvas bind:this={canvas} width={compact ? 220 : 460} height={compact ? 60 : 120} class:compact></canvas>
</figure>

<style>
	.scope {
		margin: 0;
		border: 1px solid var(--line);
		border-radius: 6px;
		overflow: hidden;
		background: var(--panel);
	}
	figcaption {
		display: flex;
		gap: 0.6rem;
		align-items: center;
		padding: 0.3rem 0.5rem;
		font-size: 0.8rem;
	}
	.flags {
		margin-left: auto;
		display: flex;
		gap: 0.4rem;
	}
	.dim {
		color: var(--muted);
	}
	.clip {
		color: #f85149;
	}
	.level input {
		width: 4.5rem;
	}
	canvas {
		display: block;
		width: 100%;
		height: 120px;
	}
	canvas.compact {
		height: 60px;
	}
</style>
