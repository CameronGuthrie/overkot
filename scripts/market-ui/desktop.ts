import { writable } from "svelte/store";
import { auth } from "../lib/auth";

export type DesktopState = {
  authenticated?: boolean;
  canTrade?: boolean;
  inventory?: { available?: boolean };
  user?: { id?: string } | null;
  accountConnection?: {
    signedIn?: boolean; authorizing?: boolean; busy?: boolean; error?: string;
    connected?: boolean; requiresReconnect?: boolean; requiresLink?: boolean;
    account?: { displayName?: string } | null;
  };
};

type DesktopBridge = {
  request: (request: { path: string; method: string; body?: unknown }) => Promise<{ status: number; body: unknown }>;
  getState: () => Promise<DesktopState>;
  onChanged: (listener: (state: DesktopState) => void) => (() => void);
  openAccountSettings: () => Promise<{ ok?: boolean; message?: string; state?: DesktopState }>;
  close: () => void;
};

export const desktopState = writable<DesktopState>({});

export function marketBridge(): DesktopBridge {
  const bridge = (window as unknown as { overkotMarket?: DesktopBridge }).overkotMarket;
  if (!bridge) throw new Error("Open the Market from Overkot to connect your account.");
  return bridge;
}

export async function openAccountSettings(): Promise<void> {
  try {
    const result = await marketBridge().openAccountSettings();
    if (result.state) desktopState.set(result.state);
    if (result.ok === false) throw new Error(result.message || "Overkot Settings could not be opened.");
  } catch (failure) {
    const error = failure instanceof Error ? failure.message : "Overkot Settings could not be opened.";
    desktopState.update(state => ({ ...state, accountConnection: { ...state.accountConnection, error } }));
  }
}

export function mountDesktopBridge(): () => void {
  let disposed = false;
  let receivedEvent = false;
  let previousIdentity: string | null = null;
  const update = (state: DesktopState) => {
    if (disposed) return;
    desktopState.set(state);
    const identity = `${state.accountConnection?.signedIn ? "connected" : "disconnected"}:${state.authenticated ? state.user?.id ?? "signed-in" : "signed-out"}`;
    if (previousIdentity !== null && identity !== previousIdentity) void auth.check();
    previousIdentity = identity;
  };
  const unsubscribe = marketBridge().onChanged(state => {
    receivedEvent = true;
    update(state);
  });
  const openAccountLink = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !/^\/(?:login|signup|avakot-login|account-link|account-sign-in|overkot-signin)(?:\/|$)/.test(url.pathname)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void openAccountSettings();
  };
  document.addEventListener("click", openAccountLink, true);
  void marketBridge().getState().then(state => { if (!receivedEvent) update(state); }).catch(() => {});
  return () => {
    disposed = true;
    unsubscribe();
    document.removeEventListener("click", openAccountLink, true);
  };
}
