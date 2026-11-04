<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';

	let { children } = $props();

	// Until the page has hydrated, typing into it is lost or cut into, because nothing yet holds what is typed. Mounting comes
	// after the whole page has hydrated, so this marks the moment it can be used, for the browser tests to wait for. It waits for
	// the app's fonts too, so nothing is measured in a fallback's widths.
	onMount(() => {
		void document.fonts.ready.then(() => (document.body.dataset.hydrated = ''));
	});
</script>

<svelte:head><title>modsynth</title></svelte:head>

{@render children()}
