<script lang="ts">
	import type { View } from '#lib/Workspace.ts';

	// The two views as tabs in the top bar, each named for what it shows: the song open, and the patch the Patch view shows.
	let {
		view,
		song,
		patch,
		onview
	}: {
		view: View;
		song: string; // The open timeline's or example's name
		patch: string; // The name of the patch the Patch view shows
		onview: (view: View) => void;
	} = $props();

	const tabs = $derived([
		{ id: 'song' as const, icon: '♫', name: song || 'Song', hint: 'The song, its tracks, notes and mix' },
		{ id: 'patch' as const, icon: '◆', name: patch || 'Patch', hint: 'The patch, how one sound is made' }
	]);
</script>

<div class="views" role="tablist" aria-label="Views">
	{#each tabs as tab (tab.id)}
		<button
			type="button"
			role="tab"
			aria-selected={view === tab.id}
			aria-controls={`${tab.id}-view`}
			data-testid={`view-${tab.id}`}
			title={`${tab.hint}: ${tab.name}. The \` key switches views.`}
			onclick={() => onview(tab.id)}
		>
			<span aria-hidden="true">{tab.icon}</span>
			<span class="name">{tab.name}</span>
		</button>
	{/each}
</div>

<style>
	.views {
		display: flex;
		min-width: 0;
		flex: 0 1 auto;
	}
	button {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 3.5rem;
		max-width: 10rem;
		padding: 0.2rem 0.6rem;
		border-radius: 0;
		color: var(--muted);
	}
	button:first-child {
		border-radius: 5px 0 0 5px;
	}
	button:last-child {
		border-radius: 0 5px 5px 0;
		border-left: 0;
	}
	button[aria-selected='true'] {
		color: var(--text);
		background: #1f6feb33;
		border-color: var(--accent);
	}
	button:last-child[aria-selected='true'] {
		box-shadow: -1px 0 0 var(--accent);
	}
	.name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
</style>
