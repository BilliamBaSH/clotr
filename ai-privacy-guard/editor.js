// Clotr: finding the chat box and editing it the way the page's own framework expects.
// Classic content script (loaded after ui-styles.js, before content.js); shares Clotr.editor.
(() => {
  "use strict";
  const LOG = "[Clotr]";

  // The real event target, even when it sits inside a web component's shadow DOM
  // (Gemini and NotebookLM); plain e.target only points at the outer component.
  function realTarget(event) {
    const path = event.composedPath();
    return path.length ? path[0] : event.target;
  }

  // Sign-in fields on an AI site's own pages (username, a password shown as text, one-time codes,
  // card forms) go to the site on purpose: Clotr never watches or records them (e2e LG1).
  const SIGN_IN_AUTOCOMPLETE = /\b(username|current-password|new-password|one-time-code|cc-[a-z-]+)\b/i;
  const SIGN_IN_WORDS = /pass(word|code|phrase)?|pwd|otp|verification|2fa|mfa/i;
  function isSignInField(input) {
    if (SIGN_IN_AUTOCOMPLETE.test(input.getAttribute("autocomplete") || "")) return true;
    if (SIGN_IN_WORDS.test(`${input.name} ${input.id} ${input.getAttribute("aria-label") || ""}`)) return true;
    return Boolean(input.form?.querySelector("input[type='password']"));
  }

  // Returns the textarea/input or contenteditable root (ProseMirror, Quill) for a node.
  function findEditor(node) {
    if (!(node instanceof Element)) return null;
    if (node.matches("input[type='text'], input:not([type])")) return isSignInField(node) ? null : node;
    if (node.matches("textarea")) return node;
    if (!node.isContentEditable) return null;
    let root = node;
    while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
    return root;
  }

  function getText(editor) {
    return editor.isContentEditable ? editor.innerText : editor.value;
  }

  function selectAll(editor) {
    editor.focus();
    if (editor.isContentEditable) {
      // The browser's own Select All (like Ctrl+A) is what rich editors track most reliably;
      // a plain range is the fallback if the command isn't handled.
      if (!document.execCommand("selectAll") || !editor.contains(window.getSelection().anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } else {
      editor.select();
    }
  }

  const sameText = (a, b) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Resolves once the editor's text differs from `before` (or after `ms`): some editors
  // (Lexical on Kimi) apply an edit a moment after the input event, not straight away.
  async function settled(editor, before, ms = 400) {
    for (let t = 0; t < ms && getText(editor) === before; t += 25) await wait(25);
  }
  // The next selectionchange (or `ms`), so an editor that tracks the selection itself has seen ours.
  const selectionSeen = (ms = 150) =>
    new Promise((r) => {
      const done = () => {
        clearTimeout(timer);
        document.removeEventListener("selectionchange", done);
        r();
      };
      const timer = setTimeout(done, ms);
      document.addEventListener("selectionchange", done);
    });

  // True while Clotr edits the chat box itself: the input events that edit causes (and any
  // half-done state an async editor shows on the way) aren't the user typing.
  let editing = false;

  // Replaces the chat box's text and resolves true only if it really changed to `text`.
  async function replaceText(editor, text) {
    editing = true;
    try {
      const before = getText(editor);
      selectAll(editor);
      // execCommand is deprecated, but it is still the one edit path that the page's
      // own framework (React, Angular, ProseMirror, Lexical) treats as genuine user input.
      document.execCommand("insertText", false, text);
      await settled(editor, before);
      if (sameText(getText(editor), text)) return true;
      // Lexical keeps its own copy of the caret and only updates it from the async
      // selectionchange event, so the first edit can land at the old caret (Perplexity,
      // Kimi). Select everything again, wait until the editor has seen it, replace once more.
      const now = getText(editor);
      const seen = selectionSeen();
      selectAll(editor);
      await seen;
      await wait(0);
      if (sameText(getText(editor), text)) return true;
      document.execCommand("insertText", false, text);
      await settled(editor, now);
      if (sameText(getText(editor), text)) return true;
    } catch (err) {
      console.warn(LOG, "editing the chat box failed", err);
    } finally {
      editing = false;
    }
    console.warn(LOG, "couldn't edit this chat box");
    return false;
  }

  globalThis.Clotr.editor = { realTarget, findEditor, getText, replaceText, isEditing: () => editing };
})();
