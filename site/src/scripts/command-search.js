export function renderEmptyState(grid, query, ownerDocument = grid.ownerDocument || document) {
  const empty = ownerDocument.createElement("div");
  empty.style.cssText = "background:var(--color-bg-raised); padding:32px; text-align:center; color:var(--color-text-muted);";
  const message = ownerDocument.createElement("span");
  message.textContent = `No commands match “${query}”`;
  empty.appendChild(message);
  grid.appendChild(empty);
}
