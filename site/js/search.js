// The package picker: type a name, pick one, and the page resolves the
// version. Everything comes from the generated index at runtime;
// nothing about the package universe is bundled.

import { searchNames } from "./index.js";
import { SEARCH_LIMIT } from "./config.js";

// How long the box sits still before a keystroke becomes a search.
const DEBOUNCE_MS = 120;

// The repos with a colour of their own — the official two, the
// Archive's older builds, a recipe out of the AUR and the package the
// guest made from one; anything else — a repo somebody pasted the URL
// of — shares one.
const KNOWN_REPOS = new Set(["core", "extra", "archive", "aur", "built"]);

export const repoClass = (repo) =>
  `repo repo-${KNOWN_REPOS.has(repo) ? repo : "other"}`;

export class PackagePicker {
  // onPick hears one hit ({name, desc, repo}) each time one is chosen;
  // the page owns the selection, since packages also arrive from the
  // spec lane and from the link the reader followed. `search` is how a
  // query becomes hits, so the AUR lane gets this picker by handing it
  // searchAur instead of the index's own search.
  constructor({ input, results, onPick, search = searchNames }) {
    this.input = input;
    this.results = results;
    this.onPick = onPick;
    // Not `this.search`: that is the method this one is called from.
    this.searchFor = search;
    this.hits = [];
    this.selected = -1;

    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.search(), DEBOUNCE_MS);
    });
    input.addEventListener("keydown", (event) => this.onKeyDown(event));
  }

  async search() {
    const query = this.input.value.trim();
    if (query === "") {
      this.clear();
      return;
    }

    const hits = await this.searchFor(query, SEARCH_LIMIT);
    // A slow answer for a query the reader has already typed past is
    // not the answer to what is in the box now.
    if (this.input.value.trim() !== query) {
      return;
    }

    this.hits = hits;
    this.selected = -1;

    if (hits.length === 0) {
      this.results.replaceChildren(
        el("p", { className: "muted" }, `no package named ${query}`),
      );
      return;
    }

    this.results.replaceChildren(
      ...hits.map((hit, i) => {
        const node = el(
          "button",
          { className: "hit", type: "button", onclick: () => this.pick(i) },
          el("span", { className: "pkg" }, hit.name),
          el("span", { className: repoClass(hit.repo) }, hit.repo),
          el("span", { className: "desc" }, hit.desc),
        );
        // Set rather than assigned: the reflected `role` property is
        // newer than the browsers this page still runs in.
        node.setAttribute("role", "option");
        node.setAttribute("aria-selected", "false");
        return node;
      }),
    );
  }

  clear() {
    this.hits = [];
    this.selected = -1;
    this.results.replaceChildren();
  }

  pick(i) {
    const hit = this.hits[i];
    if (hit !== undefined) {
      this.onPick(hit);
    }
  }

  // Arrow keys walk the list, Enter takes the highlighted hit (or the
  // first, so a reader who types a name and presses Enter gets it).
  move(delta) {
    if (this.hits.length === 0) {
      return;
    }
    this.selected =
      (this.selected + delta + this.hits.length) % this.hits.length;
    for (const [i, node] of [...this.results.children].entries()) {
      const on = i === this.selected;
      node.classList.toggle("selected", on);
      node.setAttribute("aria-selected", String(on));
      if (on) {
        node.scrollIntoView({ block: "nearest" });
      }
    }
  }

  onKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.move(-1);
      return;
    }
    if (event.key === "Escape") {
      this.clear();
      return;
    }
    if (event.key === "Enter" && this.hits.length > 0) {
      event.preventDefault();
      this.pick(this.selected === -1 ? 0 : this.selected);
    }
  }
}

// Minimal element helper: tag, properties, children.
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== "" && c !== null));
  return node;
}
