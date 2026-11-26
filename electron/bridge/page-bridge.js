/* Injected into the claude.ai page (isolated from Node). Plain JS on purpose: it is read as a
 * string at runtime and must not be touched by a TypeScript/esbuild transform.
 * Expects window.__ATLAS_SELECTORS and window.__ATLAS_LIMITS to be defined first. */
(() => {
  if (window.__atlasBridge) return;
  const S = window.__ATLAS_SELECTORS;
  const LIMITS = window.__ATLAS_LIMITS || [];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q1 = (list, root = document) => {
    for (const s of list) {
      try {
        const el = root.querySelector(s);
        if (el) return el;
      } catch (_) { /* invalid selector in this engine */ }
    }
    return null;
  };
  const qn = (list, root = document) => {
    for (const s of list) {
      try {
        const els = Array.from(root.querySelectorAll(s));
        if (els.length) return els;
      } catch (_) { /* ignore */ }
    }
    return [];
  };
  const enabled = (el) => !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  async function waitFor(fn, timeout = 15000, step = 120) {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = fn(); } catch (_) { v = null; }
      if (v) return v;
      if (Date.now() - t0 > timeout) return null;
      await sleep(step);
    }
  }

  const editor = () => q1(S.editor);
  const sendButton = () => q1(S.sendButton);
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  // A *hidden* Stop button must not count as "still streaming".
  const stopButton = () => {
    for (const s of S.stopButton) {
      try {
        const el = Array.from(document.querySelectorAll(s)).find(visible);
        if (el) return el;
      } catch (_) { /* ignore */ }
    }
    return null;
  };

  function attachmentCount() {
    const all = new Set();
    for (const s of S.attachment) {
      try { document.querySelectorAll(s).forEach((e) => all.add(e)); } catch (_) { /* ignore */ }
    }
    return all.size;
  }

  function b64ToFile(b64, name, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime, lastModified: Date.now() });
  }

  function dispatchPasteFile(file) {
    const ed = editor();
    if (!ed) return false;
    ed.focus();
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ed.dispatchEvent(ev);
    return true;
  }

  function dispatchDropFile(file) {
    const ed = editor();
    if (!ed) return false;
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      ed.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
    return true;
  }

  function setFileInput(file) {
    const input = q1(S.fileInput);
    if (!input) return false;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /** Attach a JPEG screenshot. Tries <input type=file>, then paste, then drag-and-drop. */
  async function attachImage(b64, mime, name) {
    const file = b64ToFile(b64, name || 'screen.jpg', mime || 'image/jpeg');
    const before = attachmentCount();
    const strategies = [
      ['file-input', () => setFileInput(file)],
      ['paste', () => dispatchPasteFile(file)],
      ['drop', () => dispatchDropFile(file)],
    ];
    for (const [label, run] of strategies) {
      let started = false;
      try { started = run(); } catch (_) { started = false; }
      if (!started) continue;
      const ok = await waitFor(() => attachmentCount() > before, 12000);
      if (ok) {
        // wait for any upload spinner / progress bar to finish
        await waitFor(() => !qn(S.uploading).some((e) => e.offsetParent !== null), 25000, 200);
        await waitFor(() => enabled(sendButton()), 20000, 200);
        return { attached: true, strategy: label };
      }
    }
    return { attached: false, strategy: null };
  }

  function selectAllAndDelete(ed) {
    ed.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete', false);
  }

  /** Put text in the ProseMirror composer. Paste (multi-line safe) → execCommand → raw DOM. */
  async function setText(text) {
    const ed = await waitFor(editor, 20000);
    if (!ed) throw new Error('Composer not found (claude.ai UI changed?)');
    selectAllAndDelete(ed);
    const probe = norm(text).slice(0, 24);
    const has = () => norm(ed.innerText).includes(probe);

    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(80);
    if (has()) return { method: 'paste' };

    selectAllAndDelete(ed);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (i > 0) document.execCommand('insertParagraph', false);
      if (line) document.execCommand('insertText', false, line);
    });
    await sleep(80);
    if (has()) return { method: 'execCommand' };

    ed.textContent = text;
    ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    await sleep(80);
    if (has()) return { method: 'dom' };
    throw new Error('Could not type into the claude.ai composer');
  }

  async function send() {
    const btn = await waitFor(() => { const b = sendButton(); return enabled(b) ? b : null; }, 20000, 150);
    if (btn) {
      btn.click();
      return { via: 'button' };
    }
    const ed = editor();
    if (!ed) throw new Error('Composer not found');
    ed.focus();
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    ed.dispatchEvent(new KeyboardEvent('keydown', opts));
    ed.dispatchEvent(new KeyboardEvent('keyup', opts));
    return { via: 'enter-key' };
  }

  function assistantNodes() { return qn(S.assistantMessage); }
  function assistantCount() { return assistantNodes().length; }

  function detectError() {
    const texts = [];
    for (const s of S.alerts) {
      try { document.querySelectorAll(s).forEach((e) => texts.push(norm(e.innerText))); } catch (_) { /* ignore */ }
    }
    const joined = texts.join(' | ').toLowerCase();
    if (!joined) return null;
    if (LIMITS.some((p) => joined.includes(p))) return { kind: 'rate_limit', text: texts.join(' | ').slice(0, 300) };
    if (/(something went wrong|try again|error)/.test(joined)) return { kind: 'error', text: texts.join(' | ').slice(0, 300) };
    return null;
  }

  function state() {
    const nodes = assistantNodes();
    const last = nodes[nodes.length - 1] || null;
    const streaming = !!stopButton() || !!q1(S.streaming);
    return {
      streaming,
      text: last ? last.innerText : '',
      codeBlocks: last ? Array.from(last.querySelectorAll('pre')).map((p) => p.innerText) : [],
      count: nodes.length,
      url: location.href,
      error: detectError(),
    };
  }

  function stop() {
    const b = stopButton();
    if (b) { b.click(); return true; }
    return false;
  }

  function pageInfo() {
    const path = location.pathname;
    return {
      url: location.href,
      path,
      onLogin: /^\/(login|logout|magic-link)/.test(path) || !!q1(S.loginMarkers) && !editor(),
      hasEditor: !!editor(),
      ready: document.readyState === 'complete' || document.readyState === 'interactive',
    };
  }

  function diagnose() {
    const counts = {};
    for (const [name, list] of Object.entries(S)) {
      const hits = [];
      for (const s of list) {
        try { hits.push(document.querySelectorAll(s).length); } catch (_) { hits.push(-1); }
      }
      counts[name] = hits;
    }
    return { info: pageInfo(), counts };
  }

  window.__atlasBridge = {
    attachImage, setText, send, state, stop, assistantCount, pageInfo, diagnose, attachmentCount,
  };
})();
