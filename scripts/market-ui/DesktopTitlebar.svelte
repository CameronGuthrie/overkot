<script lang="ts">
  import { marketBridge } from "./desktop";
</script>

<header class="desktop-titlebar">
  <div class="desktop-brand"><img src="/overkot-icon.png" alt="" /><span>Overkot <span class="separator">/</span> Avakot Market</span></div>
  <button type="button" title="Close Market" aria-label="Close Market" on:click={() => marketBridge().close()}>×</button>
</header>

<style>
  :global(body) { padding-top: 34px; }
  :global(html body .page-wrapper .app-shell .top-bar) { top: 34px; }
  :global(.desktop-account-action) { padding: 0; border: 0; background: transparent; font-family: inherit; cursor: pointer; }
  .desktop-titlebar { position: fixed; z-index: 2000; inset: 0 0 auto; display: flex; align-items: center; justify-content: space-between; height: 34px; padding-left: 0.75rem; border-bottom: 1px solid var(--line-default); background: var(--surface-panel); color: var(--content-default); -webkit-app-region: drag; user-select: none; }
  .desktop-brand { display: flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; line-height: 1; }
  img { width: 20px; height: 20px; object-fit: contain; }
  .separator { margin: 0 0.25rem; color: var(--content-muted); }
  button { align-self: stretch; width: 42px; padding: 0; border: 0; border-left: 1px solid var(--line-default); background: transparent; color: inherit; font-size: 1.3rem; -webkit-app-region: no-drag; }
  button:hover { background: var(--error); color: white; }
  @media (min-width: 1025px) {
    :global(html body .page-wrapper .app-shell .sidebar),
    :global(html body .page-wrapper .app-shell.sidebar-collapsed .sidebar),
    :global(html body .page-wrapper .app-shell.sidebar-right.sidebar-collapsed .sidebar) {
      top: calc(var(--header-height) + 1.5rem + 34px);
      max-height: calc(100dvh - var(--header-height) - 3rem - 34px);
    }
  }
</style>
