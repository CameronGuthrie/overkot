<script lang="ts">
  import { desktopState, openAccountSettings } from "./desktop";

  let opening = false;
  let error = "";
  $: connected = !!$desktopState.accountConnection?.signedIn;
  $: pending = !!($desktopState.accountConnection?.authorizing || $desktopState.accountConnection?.busy);

  async function openConnections() {
    if (opening) return;
    opening = true;
    error = "";
    try { await openAccountSettings(); }
    catch (failure) {
      error = failure instanceof Error ? failure.message : "Overkot Settings could not be opened.";
    } finally { opening = false; }
  }
</script>

<svelte:head><title>Account connection | Overkot Market</title></svelte:head>
<section class="signin-card">
  <h1>Your avakot.dev connection</h1>
  {#if $desktopState.accountConnection?.requiresReconnect}
    <p>Reconnect your avakot.dev account in Overkot Settings → Connections to approve Market sign-in.</p>
  {:else if $desktopState.accountConnection?.requiresLink}
    <p>Open Overkot Settings → Connections, choose Manage account to connect your Market account, then retry the connection.</p>
  {:else if connected}
    <p>Your avakot.dev account is connected in Overkot. Market uses this connection to sign in. Manage your connection in Settings → Connections.</p>
  {:else}
    <p>Connect your avakot.dev account in Overkot Settings → Connections. You can also create an account there.</p>
  {/if}
  {#if pending}<p role="status">Your account connection is updating. Complete any browser approval, then return to Overkot.</p>{/if}
  <button class="primary" type="button" disabled={opening} on:click={openConnections}>{opening ? "Opening Settings…" : "Open Overkot Connections"}</button>
  {#if error || $desktopState.accountConnection?.error}<p class="error" role="alert">{error || $desktopState.accountConnection?.error}</p>{/if}
</section>

<style>
  .signin-card { max-width: 32rem; padding: 1.5rem; border: 1px solid var(--line-default); background: var(--surface-panel); }
  h1 { margin: 0 0 1rem; font-size: 1.4rem; }
  p { line-height: 1.6; }
  button { padding: 0.7rem 1rem; border: 1px solid var(--line-strong); background: var(--brand); color: var(--on-accent); font: inherit; }
  button:disabled { opacity: 0.6; }
  .error { color: var(--error); }
</style>
