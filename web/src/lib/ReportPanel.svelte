<script lang="ts">
	import type { CompileReport } from '#lib/Request.ts';

	let { report }: { report: CompileReport } = $props();

	const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
	const shared = $derived(report.chunks.filter((c) => c.programs > 1).length);
</script>

<section class="report">
	<h3>Image</h3>
	<p>
		{kb(report.image_bytes)}, {report.chunks.length} chunks.
		{report.compiled_patches} of {report.library_patches} patches compiled in{#if report.programs.length > 1}, {shared}
			chunks shared between {report.programs.length} programs{/if}.
		{#if report.omitted_bytes > 0}{kb(report.omitted_bytes)} left out for a receiver that already has it.{/if}
	</p>
	{#each report.programs as program}
		<h4>{program.index}: {program.name}</h4>
		<ul>
			{#each program.patches as patch}
				<li><code>{patch.hash.slice(0, 8)}</code> {patch.id}</li>
			{/each}
		</ul>
	{/each}
	<table>
		<thead><tr><th>Kind</th><th>Hash</th><th>Size</th><th>Programs</th><th>In image</th></tr></thead>
		<tbody>
			{#each report.chunks as chunk}
				<tr class:thin={!chunk.present}>
					<td>{chunk.kind}</td>
					<td><code>{chunk.hash}</code></td>
					<td>{chunk.size}</td>
					<td>{chunk.programs}</td>
					<td>{chunk.present ? 'yes' : 'no'}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</section>

<style>
	.report {
		font-size: 0.85rem;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	th,
	td {
		text-align: left;
		padding: 0.15rem 0.5rem;
		border-bottom: 1px solid var(--line);
	}
	.thin {
		color: var(--muted);
	}
	ul {
		margin: 0.2rem 0;
		padding-left: 1.2rem;
	}
</style>
