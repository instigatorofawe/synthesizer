<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head><title>modsynth</title></svelte:head>

{@render children()}
