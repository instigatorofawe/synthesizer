<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head><title>modsynth</title></svelte:head>

<nav>
	<a href="/"><strong>modsynth</strong></a>
</nav>
<main>{@render children()}</main>
