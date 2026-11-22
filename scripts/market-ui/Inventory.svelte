<script lang="ts">
  import { onMount } from "svelte";
  import { connectInventoryFrame } from "./inventoryFrame";

  let frame: HTMLIFrameElement;
  onMount(() => connectInventoryFrame(frame));
</script>

<iframe bind:this={frame} class="inventory" src="/inventory.html" title="Sell items from your Soulframe inventory"></iframe>

<style>
  .inventory { display: block; width: 100%; height: 1px; border: 0; background: transparent; }
</style>
