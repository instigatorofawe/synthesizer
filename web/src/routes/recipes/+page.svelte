<script lang="ts">
	let { data } = $props();
</script>

<h1>Recipes</h1>
<p class="muted">Short pieces that ship with the app, from a supersaw to a drum loop. Play any of them as they are, or add one to the library to change it and use its patches in your own timelines.</p>

{#each data.groups as group}
	<h2>{group.name}</h2>
	<ul class="list">
		{#each group.recipes as recipe}
			<li>
				<a href="/recipes/{recipe.name}">{recipe.name}</a>
				<span class="muted">{recipe.listen_for}</span>
			</li>
		{/each}
	</ul>
{/each}
