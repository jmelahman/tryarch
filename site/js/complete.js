// Autocomplete for the spec box: a dropdown under the input that
// completes the package name the caret sits in, switches to completing
// versions once an "@" is typed, and takes arrow keys, Tab, Enter and
// Escape.
//
// The fragment logic is the caret's word, and for a version the text
// after the last range operator — so ">=1.7" completes "1.7" and leaves
// ">=" alone. Both spellings the spec lane accepts are handled, since
// "bash>=5" has no "@" to switch on.

import { names } from "./index.js";
import { versionsOf } from "./versions.js";
import { RANGE_COMPLETIONS } from "./config.js";

const RANGE_OPERATORS = /(?:.*(?:>=|<=|>|<|=))?([A-Za-z0-9._+*:-]*)$/;
const MIN_NAME_PREFIX = 2;

export class RangeComplete {
  constructor({ input, dropdown, onAccept = () => {} }) {
    this.input = input;
    this.dropdown = dropdown;
    this.onAccept = onAccept;
    this.suggestions = [];
    this.selected = -1;

    input.addEventListener("input", () => this.refresh());
    input.addEventListener("blur", () => setTimeout(() => this.hide(), 150));
    input.addEventListener("keydown", (event) => this.onKeyDown(event));
    // mousedown, not click: the input's blur would hide the dropdown
    // before a click ever lands.
    dropdown.addEventListener("mousedown", (event) => {
      const item = event.target.closest("button[data-i]");
      if (item !== null) {
        event.preventDefault();
        this.accept(Number(item.dataset.i));
      }
    });
  }

  // The word the caret sits in, and where the completable part starts.
  fragment() {
    const upto = this.input.value.slice(0, this.input.selectionStart);
    const wordStart = upto.search(/\S+$/);
    if (wordStart === -1) {
      return null;
    }
    const word = upto.slice(wordStart);

    // A name ends at "@" or at the first comparison operator, whichever
    // the reader typed.
    const split = word.search(/[@<>=]/);
    if (split === -1) {
      return { mode: "name", name: null, start: wordStart, prefix: word };
    }

    const name = word.slice(0, split);
    const rest =
      word[split] === "@" ? word.slice(split + 1) : word.slice(split);
    const match = RANGE_OPERATORS.exec(rest);
    const prefix = match === null ? "" : match[1];
    return {
      mode: "version",
      name,
      start: wordStart + word.length - prefix.length,
      prefix,
    };
  }

  async refresh() {
    const fragment = this.fragment();
    if (
      fragment === null ||
      (fragment.mode === "name" && fragment.prefix.length < MIN_NAME_PREFIX)
    ) {
      this.hide();
      return;
    }

    let pool;
    if (fragment.mode === "name") {
      pool = [...(await names()).keys()].filter((name) =>
        name.startsWith(fragment.prefix),
      );
    } else {
      pool = (await versionsOf(fragment.name))
        .map((build) => build.version)
        .filter((version) => version.startsWith(fragment.prefix));
    }

    this.suggestions = pool
      .slice(0, RANGE_COMPLETIONS)
      .map((text) => ({ text, fragment }));
    this.selected = -1;

    if (this.suggestions.length === 0) {
      this.hide();
      return;
    }

    this.dropdown.replaceChildren(
      ...this.suggestions.map(({ text }, i) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "completion";
        item.dataset.i = String(i);
        item.textContent = text;
        return item;
      }),
    );
    this.dropdown.hidden = false;
  }

  hide() {
    this.suggestions = [];
    this.selected = -1;
    this.dropdown.hidden = true;
  }

  accept(i) {
    const { text, fragment } = this.suggestions[i];
    const caret = this.input.selectionStart;
    const value = this.input.value;
    this.input.value =
      value.slice(0, fragment.start) + text + value.slice(caret);

    const position = fragment.start + text.length;
    this.input.setSelectionRange(position, position);
    this.input.focus();
    this.hide();
    this.onAccept();
  }

  move(delta) {
    if (this.suggestions.length === 0) {
      return;
    }
    this.selected =
      (this.selected + delta + this.suggestions.length) %
      this.suggestions.length;
    for (const [i, item] of [...this.dropdown.children].entries()) {
      item.classList.toggle("selected", i === this.selected);
    }
  }

  onKeyDown(event) {
    if (this.dropdown.hidden) {
      return;
    }
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
      this.hide();
      return;
    }
    // Enter with nothing highlighted submits the form instead.
    if (
      (event.key === "Tab" || event.key === "Enter") &&
      this.suggestions.length > 0
    ) {
      const i = this.selected === -1 ? 0 : this.selected;
      if (event.key === "Tab" || this.selected !== -1) {
        event.preventDefault();
        this.accept(i);
      }
    }
  }
}
