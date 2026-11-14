import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
function fixture(html, url = 'https://www.instagram.com/') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  dom.window.eval(script);
  return dom;
}
function snapshotDocument(page) { return new JSDOM(page.html).window.document; }
function plan(operations) { return { action: 'edit', message: 'Update the page', operations }; }
const card = title => `<article><img alt="${title} photo"><h2>${title}</h2><a href="/p/${title}/">Read post</a></article>`;

test('generic snapshots support Instagram-shaped posts and reversible reordering without site selectors', () => {
  const dom = fixture(`<main>${card('Zebra')}<aside>Ad</aside>${card('apple')}${card('Banana')}</main>`);
  try {
    const api = dom.window.browserAgent;
    const first = dom.window.document.querySelector('article');
    let clicks = 0;
    first.addEventListener('click', () => clicks++);
    const page = api.snapshot();
    const ids = [...snapshotDocument(page).querySelectorAll('article')].map(element => element.id);
    api.apply(plan([{ type: 'reorder', ids: [ids[1], ids[2], ids[0]] }]), page.id);
    assert.deepEqual([...dom.window.document.querySelectorAll('h2')].map(node => node.textContent), ['apple', 'Banana', 'Zebra']);
    assert.equal(dom.window.document.querySelector('main').children[1].tagName, 'ASIDE');
    first.click();
    assert.equal(clicks, 1);
    assert.equal(api.undo(), 'Undid the last page change.');
    assert.deepEqual([...dom.window.document.querySelectorAll('h2')].map(node => node.textContent), ['Zebra', 'apple', 'Banana']);
  } finally { dom.window.close(); }
});

test('YouTube titles can be discovered from compact HTML even when their selectors change', () => {
  const dom = fixture('<main><div class="row"><ytd-rich-item-renderer><yt-lockup-view-model><h3>Zulu title</h3></yt-lockup-view-model></ytd-rich-item-renderer></div><div class="row"><ytd-rich-item-renderer><yt-lockup-view-model><h3>Alpha title</h3></yt-lockup-view-model></ytd-rich-item-renderer></div></main>', 'https://www.youtube.com/');
  try {
    const page = dom.window.browserAgent.snapshot();
    const ids = [...snapshotDocument(page).querySelectorAll('ytd-rich-item-renderer')].map(node => node.id);
    assert.equal(ids.length, 2);
    dom.window.browserAgent.apply(plan([{ type: 'reorder', ids: ids.reverse() }]), page.id);
    assert.deepEqual([...dom.window.document.querySelectorAll('h3')].map(node => node.textContent), ['Alpha title', 'Zulu title']);
    dom.window.browserAgent.undo();
    assert.deepEqual([...dom.window.document.querySelectorAll('h3')].map(node => node.textContent), ['Zulu title', 'Alpha title']);
  } finally { dom.window.close(); }
});

test('snapshots cap context, prioritize main content, and omit private fields and irrelevant markup', () => {
  const dom = fixture(`<nav>${'<a href="/nav">Menu</a>'.repeat(1000)}</nav><main><h1>Important feed</h1><input type="password" value="secret123"><textarea>private draft</textarea><div contenteditable="true">private editor</div><script>secret script</script><svg><path d="big-vector"></path></svg><div hidden>hidden secret</div><div style="display:none">css secret</div><a href="/p/test/?token=secret">Public post</a>${card('Feed post').repeat(200)}</main>`);
  try {
    const page = dom.window.browserAgent.snapshot();
    assert.ok(page.html.length <= 24_000);
    assert.ok(page.html.includes('Important feed'));
    assert.ok(page.html.includes('Feed post'));
    assert.equal(page.truncated, true);
    assert.doesNotMatch(page.html, /secret|private|big-vector|<script|<svg|<input|<textarea/);
    assert.equal(page.estimatedTokens, Math.ceil(page.html.length / 4));
  } finally { dom.window.close(); }
});

test('style, hide, text and insert changes undo as a batch and inserted content remains text', () => {
  const dom = fixture('<main><h1>Original</h1><aside style="color: red">Distraction</aside></main>');
  try {
    const api = dom.window.browserAgent;
    const page = api.snapshot();
    const tree = snapshotDocument(page);
    api.apply(plan([
      { type: 'style', ids: [tree.querySelector('main').id], styles: { 'background-color': '#111111', color: '#ffffff' } },
      { type: 'hide', ids: [tree.querySelector('aside').id] },
      { type: 'text', id: tree.querySelector('h1').id, text: 'Changed' },
      { type: 'insert', parentId: tree.querySelector('main').id, tag: 'p', text: '<script>alert(1)</script>' },
    ]), page.id);
    assert.equal(dom.window.document.querySelector('aside').style.display, 'none');
    assert.equal(dom.window.document.querySelector('h1').textContent, 'Changed');
    assert.equal(dom.window.document.querySelector('script'), null);
    assert.equal(dom.window.document.querySelector('p').textContent, '<script>alert(1)</script>');
    api.undo();
    assert.equal(dom.window.document.querySelector('h1').textContent, 'Original');
    assert.equal(dom.window.document.querySelector('aside').getAttribute('style'), 'color: red');
    assert.equal(dom.window.document.querySelector('main').getAttribute('style'), null);
    assert.equal(dom.window.document.querySelector('p'), null);
  } finally { dom.window.close(); }
});

test('rejects stale snapshots, arbitrary code, external CSS, and invalid batches before editing', () => {
  const dom = fixture('<main><h1>Original</h1></main>');
  try {
    const api = dom.window.browserAgent;
    const page = api.snapshot();
    const id = snapshotDocument(page).querySelector('h1').id;
    assert.throws(() => api.apply(plan([{ type: 'text', id, text: 'Changed' }, { type: 'execute', code: 'alert(1)' }]), page.id), /unsupported/);
    assert.equal(dom.window.document.querySelector('h1').textContent, 'Original');
    assert.throws(() => api.apply(plan([{ type: 'style', ids: [id], styles: { color: 'url(https://evil.example)' } }]), page.id), /Unsupported/);
    api.snapshot();
    assert.throws(() => api.apply(plan([{ type: 'text', id, text: 'Changed' }]), page.id), /page changed/);
    dom.window.history.pushState({}, '', '/different');
    assert.match(api.undo(), /no page changes/);
  } finally { dom.window.close(); }
});
