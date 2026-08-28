// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderEmptyState } from "../src/scripts/command-search.js";
import { setupMobileMenu } from "../src/scripts/mobile-menu.js";

class FakeElement {
  constructor() {
    this.style = {};
    this.hidden = false;
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.textContent = "";
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type) { this.listeners.delete(type); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.children = children; }
  dispatch(type, event = {}) { this.listeners.get(type)?.(event); }
}

function fakeDocument() {
  return { createElement: () => new FakeElement() };
}

test("hostile command-search text cannot create elements or handlers", () => {
  const grid = new FakeElement();
  const hostile = '<img src=x onerror="alert(1)">';
  renderEmptyState(grid, hostile, fakeDocument());

  assert.equal(grid.children.length, 1);
  const message = grid.children[0].children[0];
  assert.equal(message.textContent, `No commands match “${hostile}”`);
  assert.equal(message.children.length, 0);
  assert.equal(message.listeners.size, 0);

  const source = fs.readFileSync(path.join(process.cwd(), "src/pages/commands.astro"), "utf8");
  assert.doesNotMatch(source, /innerHTML/);
  assert.match(source, /renderEmptyState\(grid, query\)/);
});

test("mobile disclosure resets when the viewport crosses 900px", () => {
  const btn = new FakeElement();
  const nav = new FakeElement();
  const mediaQuery = new FakeElement();
  mediaQuery.matches = false;
  setupMobileMenu({ btn, nav, mediaQuery });

  btn.dispatch("click");
  assert.equal(nav.hidden, false);
  assert.equal(nav.style.display, "flex");
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  assert.equal(btn.textContent, "✕");

  mediaQuery.dispatch("change", { matches: true });
  assert.equal(nav.hidden, true);
  assert.equal(nav.style.display, "none");
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.equal(btn.getAttribute("aria-label"), "Open menu");
  assert.equal(btn.textContent, "☰");
});
