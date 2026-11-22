// The local inventory renderer retains the validated listing composer. It is
// part of the Market document visually: the Market owns its palette and page
// scrolling, while the frame only isolates the inventory renderer's markup.
export function connectInventoryFrame(frame: HTMLIFrameElement): () => void {
  let disposeDocument = () => {};

  const connect = () => {
    disposeDocument();
    const child = frame.contentDocument;
    if (!child?.body) return;
    const root = child.documentElement;
    const body = child.body;
    const childWindow = frame.contentWindow;
    const outerRoot = document.documentElement;
    let animation: number | null = null;
    let disposed = false;
    let restoreScroll: (() => void) | null = null;

    // Reuse the shared build's font faces, including its hashed font assets.
    // Place them ahead of the inventory styles so embedded overrides stay last.
    const local = new URL(location.href);
    const firstInventoryStyle = child.head.querySelector('link[rel="stylesheet"], style');
    for (const stylesheet of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) {
      const source = new URL(stylesheet.href);
      if (source.protocol !== local.protocol || source.host !== local.host || source.username || source.password) continue;
      const link = child.createElement("link");
      link.rel = "stylesheet";
      link.href = stylesheet.href;
      link.dataset.inventorySharedStyle = "";
      child.head.insertBefore(link, firstInventoryStyle);
    }

    const syncTheme = () => {
      const parent = getComputedStyle(document.documentElement);
      for (const property of parent) {
        if (property.startsWith("--")) root.style.setProperty(property, parent.getPropertyValue(property));
      }
      const font = getComputedStyle(document.body);
      root.style.setProperty("--inventory-font-family", font.fontFamily);
      root.style.setProperty("--inventory-font-size", font.fontSize);
      root.style.setProperty("--inventory-color-scheme", document.documentElement.dataset.theme === "light" ? "light" : "dark");
      root.dataset.theme = document.documentElement.dataset.theme || "dark";
      scheduleLayout();
    };

    const layout = () => {
      animation = null;
      if (disposed) return;
      // Fixed dialogs do not contribute to body height. A short/filtered list
      // must still give its modal a full viewport inside the iframe; otherwise
      // its lower controls are painted outside the frame and cannot be clicked.
      // Closing the modal lets the frame shrink back to the list's height.
      const rect = frame.getBoundingClientRect();
      const height = Math.max(1, Math.ceil(body.getBoundingClientRect().height),
        child.querySelector("dialog[open]") ? Math.ceil(window.innerHeight - rect.top) : 0);
      if (frame.style.height !== `${height}px`) frame.style.height = `${height}px`;

      // A modal centered in a tall iframe would open far below the viewport.
      // Align it with the visible portion below the desktop titlebar instead.
      const titlebar = document.querySelector(".desktop-titlebar")?.getBoundingClientRect();
      const header = document.querySelector(".app-shell .top-bar")?.getBoundingClientRect();
      const visibleTop = Math.max(16, (titlebar?.bottom || 0) + 16, (header?.bottom || 0) + 16, rect.top + 16);
      const visibleBottom = window.innerHeight - 16;
      root.style.setProperty("--inventory-dialog-top", `${Math.max(16, visibleTop - rect.top)}px`);
      root.style.setProperty("--inventory-dialog-height", `${Math.max(120, visibleBottom - visibleTop)}px`);
    };

    function scheduleLayout() {
      if (animation === null && !disposed) animation = requestAnimationFrame(layout);
    }

    const syncDialog = () => {
      if (child.querySelector("dialog[open]")) {
        if (!restoreScroll) {
          const overflow = outerRoot.style.getPropertyValue("overflow");
          const overflowPriority = outerRoot.style.getPropertyPriority("overflow");
          const behavior = outerRoot.style.getPropertyValue("scroll-behavior");
          const behaviorPriority = outerRoot.style.getPropertyPriority("scroll-behavior");
          restoreScroll = () => {
            if (overflow) outerRoot.style.setProperty("overflow", overflow, overflowPriority);
            else outerRoot.style.removeProperty("overflow");
            if (behavior) outerRoot.style.setProperty("scroll-behavior", behavior, behaviorPriority);
            else outerRoot.style.removeProperty("scroll-behavior");
          };
          // Native dialog focus can otherwise continue a smooth scroll started
          // by selecting an item. Freeze the page underneath the open modal;
          // the modal's own scroll area remains available for a long editor.
          outerRoot.style.setProperty("scroll-behavior", "auto");
          window.scrollTo({ top: window.scrollY, left: window.scrollX, behavior: "instant" });
          outerRoot.style.setProperty("overflow", "hidden");
        }
      } else if (restoreScroll) {
        restoreScroll();
        restoreScroll = null;
      }
      scheduleLayout();
    };

    const childScroll = () => {
      // Only the composer may scroll inside the frame, never its viewport.
      if (childWindow && (childWindow.scrollY || childWindow.scrollX)) {
        childWindow.scrollTo({ top: 0, left: 0, behavior: "instant" });
      }
      scheduleLayout();
    };

    const resize = new ResizeObserver(scheduleLayout);
    resize.observe(body);
    const theme = new MutationObserver(syncTheme);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    theme.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const dialogs = new MutationObserver(syncDialog);
    dialogs.observe(body, { attributes: true, attributeFilter: ["open"], subtree: true });
    window.addEventListener("resize", scheduleLayout);
    window.addEventListener("scroll", scheduleLayout, { capture: true, passive: true });
    childWindow?.addEventListener("scroll", childScroll, { capture: true, passive: true });
    child.addEventListener("focusin", scheduleLayout);
    child.fonts?.addEventListener("loadingdone", scheduleLayout);
    syncTheme();
    syncDialog();

    disposeDocument = () => {
      disposed = true;
      resize.disconnect();
      theme.disconnect();
      dialogs.disconnect();
      window.removeEventListener("resize", scheduleLayout);
      window.removeEventListener("scroll", scheduleLayout, true);
      childWindow?.removeEventListener("scroll", childScroll, true);
      child.removeEventListener("focusin", scheduleLayout);
      child.fonts?.removeEventListener("loadingdone", scheduleLayout);
      if (animation !== null) cancelAnimationFrame(animation);
      restoreScroll?.();
      child.querySelectorAll("[data-inventory-shared-style]").forEach(style => style.remove());
    };
  };

  frame.addEventListener("load", connect);
  if (frame.contentDocument?.readyState === "complete") connect();
  return () => {
    frame.removeEventListener("load", connect);
    disposeDocument();
  };
}
