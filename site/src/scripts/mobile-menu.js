// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

export function setupMobileMenu({ btn, nav, mediaQuery } = {}) {
  if (!btn || !nav) return () => {};

  let open = false;
  const setOpen = (next) => {
    open = Boolean(next);
    nav.hidden = !open;
    nav.style.display = open ? "flex" : "none";
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    btn.textContent = open ? "✕" : "☰";
  };
  const onClick = () => setOpen(!open);
  const onMediaChange = (event) => {
    if (event.matches) setOpen(false);
  };

  btn.addEventListener("click", onClick);
  if (mediaQuery?.addEventListener) mediaQuery.addEventListener("change", onMediaChange);
  else if (mediaQuery?.addListener) mediaQuery.addListener(onMediaChange);
  setOpen(false);

  return () => {
    btn.removeEventListener?.("click", onClick);
    if (mediaQuery?.removeEventListener) mediaQuery.removeEventListener("change", onMediaChange);
    else if (mediaQuery?.removeListener) mediaQuery.removeListener(onMediaChange);
  };
}
