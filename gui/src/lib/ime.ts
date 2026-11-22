/** True while a CJK/Korean IME composition session is active on the key event (including Safari's keyCode 229 confirm). */
export function isImeComposing(event: {
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  keyCode?: number;
}): boolean {
  return event.nativeEvent?.isComposing === true || event.nativeEvent?.keyCode === 229 || event.keyCode === 229;
}
