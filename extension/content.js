(() => {
  const version = 2;
  if (globalThis.browserAgent?.version === version) return;

  const limit = 24_000;
  const nodes = new Map();
  const ids = new WeakMap();
  const undoStack = [];
  const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);
  const semantic = new Set(['BODY', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'SECTION', 'ARTICLE', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'BUTTON', 'H1', 'H2', 'H3', 'H4', 'P', 'IMG', 'VIDEO']);
  const styleProperties = new Set(['color', 'background-color', 'font-size', 'font-family', 'font-weight', 'font-style', 'text-align', 'text-decoration', 'line-height', 'letter-spacing', 'display', 'visibility', 'opacity', 'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height', 'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'gap', 'row-gap', 'column-gap', 'border', 'border-color', 'border-width', 'border-style', 'border-radius', 'box-shadow', 'grid-template-columns', 'grid-template-rows', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'order', 'overflow', 'object-fit']);
  let nextId = 0;
  let snapshotId;
  let snapshotUrl;
  let pageUrl = location.href;

  const clean = (text, max = 180) => (text || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  function idFor(element) {
    if (!ids.has(element)) ids.set(element, `n${++nextId}`);
    const id = ids.get(element);
    nodes.set(id, element);
    return id;
  }
  function resetOnNavigation() {
    if (pageUrl === location.href) return;
    for (const entry of undoStack) entry.cleanup();
    undoStack.length = 0;
    nodes.clear();
    snapshotId = null;
    pageUrl = location.href;
  }

  function snapshot() {
    resetOnNavigation();
    nodes.clear();
    snapshotId = crypto.randomUUID();
    snapshotUrl = location.href;
    let scanned = 0;
    let included = 0;
    let used = 0;
    let truncated = false;
    const styleCache = new WeakMap();
    function visible(element) {
      if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
      let style = styleCache.get(element);
      if (!style) { style = getComputedStyle(element); styleCache.set(element, style); }
      return style.display !== 'none' && style.visibility !== 'hidden';
    }
    const main = document.querySelector('main, [role="main"], ytd-page-manager');
    function visit(element) {
      if (++scanned > 12_000 || used > limit - 600 || included >= 450) { truncated = true; return ''; }
      if (ignored.has(element.tagName) || element.isContentEditable || element.hasAttribute('contenteditable') || !visible(element)) return '';
      const ownText = clean([...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(' '));
      const children = [...element.children];
      if (main) children.sort((a, b) => Number(b === main || b.contains(main)) - Number(a === main || a.contains(main))); 
      // Collapse single-child framework wrappers, while retaining cards and layout containers.
      const keep = semantic.has(element.tagName) || element.hasAttribute('role') || Boolean(ownText) || children.length > 1 || element.tagName.includes('-');
      if (!keep) return children.map(visit).join('');
      const id = idFor(element);
      const tag = element.tagName.toLowerCase();
      let attributes = ` id="${id}"`;
      const role = clean(element.getAttribute('role'), 40);
      const label = clean(element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title'), 140);
      // A small hint helps the model recognize titles/cards without sending long CSS classes.
      const hint = clean([element.id, ...element.classList].filter(value => /title|card|post|feed|grid|content|caption|description|sidebar|menu/i.test(value)).slice(0, 2).join(' '), 80);
      if (role) attributes += ` role="${escape(role)}"`;
      if (label) attributes += ` label="${escape(label)}"`;
      if (hint) attributes += ` hint="${escape(hint)}"`;
      if (element.tagName === 'A') {
        try {
          const url = new URL(element.getAttribute('href'), location.href);
          if (['http:', 'https:'].includes(url.protocol)) attributes += ` href="${escape(clean(url.origin + url.pathname, 120))}"`;
        } catch { /* Omit invalid links. */ }
      }
      const open = `<${tag}${attributes}>${escape(ownText)}`;
      const close = `</${tag}>`;
      used += open.length + close.length;
      included++;
      return open + children.map(visit).join('') + close;
    }
    const html = visit(document.body);
    return {
      id: snapshotId,
      url: location.origin + location.pathname,
      title: clean(document.title, 180),
      html,
      nodeCount: included,
      characters: html.length,
      estimatedTokens: Math.ceil(html.length / 4),
      truncated,
      canUndo: undoStack.length > 0,
    };
  }

  function resolve(id) {
    const element = nodes.get(id);
    if (!element?.isConnected) throw new Error('The page changed while planning. Send your request again to read the current page.');
    return element;
  }
  function targets(operation) {
    if (!Array.isArray(operation.ids) || !operation.ids.length || operation.ids.length > 450 || new Set(operation.ids).size !== operation.ids.length) throw new Error('Invalid page targets.');
    return operation.ids.map(resolve);
  }
  function prepare(operation) {
    if (operation.type === 'reorder') {
      const ordered = targets(operation);
      if (ordered.length < 2 || ordered.some(node => node === document.body || ordered.some(other => other !== node && node.contains(other)))) throw new Error('Choose separate cards or list items to reorder.');
      const original = [...ordered].sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
      return () => {
        const anchors = original.map(node => {
          const anchor = document.createComment('browser-agent-undo');
          node.before(anchor);
          return anchor;
        });
        ordered.forEach((node, index) => anchors[index].after(node));
        return {
          undo: () => anchors.forEach((anchor, index) => { if (anchor.isConnected && original[index].isConnected) anchor.replaceWith(original[index]); }),
          cleanup: () => anchors.forEach(anchor => anchor.remove()),
        };
      };
    }
    if (operation.type === 'style' || operation.type === 'hide') {
      const elements = targets(operation);
      const styles = operation.type === 'hide' ? { display: 'none' } : operation.styles;
      if (!styles || typeof styles !== 'object' || Array.isArray(styles) || Object.keys(styles).length > 30) throw new Error('Invalid page styles.');
      for (const [property, value] of Object.entries(styles)) {
        if (!styleProperties.has(property) || typeof value !== 'string' || value.length > 180 || /url\s*\(|expression\s*\(|@import/i.test(value)) throw new Error('Unsupported page style.');
      }
      return () => {
        const previous = elements.map(element => element.getAttribute('style'));
        elements.forEach(element => { for (const [property, value] of Object.entries(styles)) element.style.setProperty(property, value, 'important'); });
        return { undo: () => elements.forEach((element, index) => previous[index] === null ? element.removeAttribute('style') : element.setAttribute('style', previous[index])), cleanup() {} };
      };
    }
    if (operation.type === 'text') {
      const element = resolve(operation.id);
      if (element.childElementCount || ignored.has(element.tagName) || element.isContentEditable) throw new Error('Text edits must target a text-only element.');
      if (typeof operation.text !== 'string' || operation.text.length > 4000) throw new Error('Invalid replacement text.');
      return () => {
        const previous = element.textContent;
        element.textContent = operation.text;
        return { undo: () => { element.textContent = previous; }, cleanup() {} };
      };
    }
    if (operation.type === 'insert') {
      const parent = resolve(operation.parentId);
      if (!['div', 'p', 'span', 'h1', 'h2', 'h3', 'section', 'li'].includes(operation.tag) || typeof operation.text !== 'string' || operation.text.length > 4000) throw new Error('Unsupported inserted content.');
      const before = operation.beforeId ? resolve(operation.beforeId) : null;
      if (before && before.parentElement !== parent) throw new Error('The insert position does not belong to its parent.');
      return () => {
        const element = document.createElement(operation.tag);
        element.textContent = operation.text;
        parent.insertBefore(element, before);
        return { undo: () => element.remove(), cleanup() {} };
      };
    }
    throw new Error('The model returned an unsupported page edit.');
  }

  function undo() {
    resetOnNavigation();
    const entry = undoStack.pop();
    if (!entry) return 'There are no page changes to undo on this page.';
    entry.undo();
    entry.cleanup();
    return 'Undid the last page change.';
  }

  function apply(plan, expectedSnapshotId) {
    resetOnNavigation();
    if (!snapshotId || snapshotId !== expectedSnapshotId || snapshotUrl !== location.href) throw new Error('The page changed while planning. Send your request again.');
    if (plan.action === 'undo') return undo();
    if (plan.action === 'reply') return { changed: false, count: 0 };
    if (plan.action !== 'edit' || !Array.isArray(plan.operations) || !plan.operations.length || plan.operations.length > 30) throw new Error('Invalid page edits.');
    // Validate every operation before changing the DOM; roll back a failed batch.
    const prepared = plan.operations.map(prepare);
    const changes = [];
    try { for (const run of prepared) changes.push(run()); }
    catch (error) {
      for (const change of changes.reverse()) { change.undo(); change.cleanup(); }
      throw error;
    }
    undoStack.push({
      undo: () => { for (const change of [...changes].reverse()) change.undo(); },
      cleanup: () => { for (const change of changes) change.cleanup(); },
    });
    if (undoStack.length > 20) undoStack.shift().cleanup();
    return { changed: true, count: plan.operations.length };
  }

  globalThis.browserAgent = { version, snapshot, apply, undo };
})();
