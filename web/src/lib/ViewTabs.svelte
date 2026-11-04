<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { View } from '#lib/Workspace.ts';

	// The two views as tabs in the top bar, each named for what it shows: the song open, and the patch the Patch view shows.
	// The Song tab carries the song's ▾ menu at its right end. The ▾ is beside the tabs rather than in one, since a tab holds
	// no other control, and is drawn over the Song tab's end. Nothing around it is transformed, since its menu is fixed to the
	// window.
	let {
		view,
		song,
		patch,
		alone = false,
		menu,
		onview
	}: {
		view: View;
		song: string; // The open timeline's or example's name
		patch: string; // The name of the patch the Patch view shows
		alone?: boolean; // Whether that patch is what plays, on its own, rather than the song
		menu?: Snippet; // The song's ▾ menu
		onview: (view: View) => void;
	} = $props();

	let songWidth = $state(0);

	const tabs = $derived([
		{ id: 'song' as const, icon: '♫', name: song || 'Song', hint: 'The song, its tracks, notes and mix' },
		{ id: 'patch' as const, icon: '◆', name: patch || 'Patch', hint: 'The patch, how one sound is made' }
	]);
	const aloneWords = $derived(`Playing ${patch || 'a patch'} on its own. Play goes back to the song.`);

	// How far a tab gives way: its name to 10 characters, or all of a shorter one, so the top bar always says what is open. A
	// name's own smallest size is all of it, so each tab's is worked out here: its padding, its icon and the gap, then the name.
	const shown = (name: string) => `${Math.min(name.length, 10)}ch`;
	const songFloor = $derived(`calc(${menu ? '2.4rem' : '1.3rem'} + 0.35rem + 1.2em + ${shown(tabs[0].name)})`);
	const patchFloor = $derived(`calc(1.3rem + 0.35rem + 1.2em + ${shown(tabs[1].name)}${alone ? ' + 1.6em' : ''})`);
</script>

<div class="views" class:menu={!!menu} style:min-width={`calc(${songFloor} + ${patchFloor})`}>
	<div class="tabs" role="tablist" aria-label="Views">
		{#each tabs as tab (tab.id)}
			{#if tab.id === 'song'}
				<button
					type="button"
					role="tab"
					aria-selected={view === tab.id}
					aria-controls={`${tab.id}-view`}
					data-testid={`view-${tab.id}`}
					title={`${tab.hint}: ${tab.name}. The \` key switches views.`}
					style:min-width={songFloor}
					bind:offsetWidth={songWidth}
					onclick={() => onview(tab.id)}
				>
					<span aria-hidden="true">{tab.icon}</span>
					<span class="name">{tab.name}</span>
				</button>
			{:else}
				<button
					type="button"
					role="tab"
					aria-selected={view === tab.id}
					aria-controls={`${tab.id}-view`}
					data-testid={`view-${tab.id}`}
					title={`${tab.hint}: ${tab.name}. The \` key switches views.${alone ? ` ${aloneWords}` : ''}`}
					style:min-width={patchFloor}
					onclick={() => onview(tab.id)}
				>
					<span aria-hidden="true">{tab.icon}</span>
					<span class="name">{tab.name}</span>
					{#if alone}
						<span class="alone" data-testid="playing-alone" title={aloneWords}
							><span aria-hidden="true">♪</span><span class="hidden">, playing on its own</span></span
						>
					{/if}
				</button>
			{/if}
		{/each}
	</div>
	{#if menu}
		<span class="songmenu" style:left="calc({songWidth}px - 1.55rem)">{@render menu()}</span>
	{/if}
</div>

<style>
	.views {
		position: relative;
		display: flex;
		flex: 0 1 auto;
	}
	.tabs {
		display: flex;
		min-width: 0;
	}
	button {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		max-width: 10rem;
		padding: 0.2rem 0.6rem;
		border-radius: 0;
		color: var(--muted);
	}
	button:first-child {
		border-radius: 5px 0 0 5px;
	}
	/* Room at the Song tab's end for its ▾. */
	.menu button:first-child {
		padding-right: 1.7rem;
	}
	/* The patch's name is the shorter, as a rule, so the song's gives way first. */
	button:last-child {
		flex-shrink: 0.001; /* Even a fraction of a pixel cuts a name with an ellipsis */
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
	.songmenu {
		position: absolute;
		top: 0;
		bottom: 0;
		display: flex;
		align-items: center;
	}
	.alone {
		flex: none;
		color: #d29922;
	}
	.hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
