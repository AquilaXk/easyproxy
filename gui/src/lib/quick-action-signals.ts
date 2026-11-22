export const FOCUS_API_KEY_CREATE_EVENT = "easyproxy:focus-api-key-create";

let pendingApiKeyCreateFocus = false;

export function requestApiKeyCreateFocus(): void {
  pendingApiKeyCreateFocus = true;
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new window.Event(FOCUS_API_KEY_CREATE_EVENT));
    } catch {
      /* ignore non-browser event host */
    }
  }
}

export function hasPendingApiKeyCreateFocus(): boolean {
  return pendingApiKeyCreateFocus;
}

export function consumeApiKeyCreateFocus(): boolean {
  if (!pendingApiKeyCreateFocus) return false;
  pendingApiKeyCreateFocus = false;
  return true;
}

export function clearPendingApiKeyCreateFocusForTests(): void {
  pendingApiKeyCreateFocus = false;
}
