const $ = id => document.getElementById(id);
const helper = 'http://127.0.0.1:3210';
let connected = false;
let busy = false;
let polling;
let history = [];
let accountId;
let modelAccount;

async function api(path, data) {
  let response;
  try {
    response = await fetch(`${helper}${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Browser-Agent': chrome.runtime.id },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(path === '/plan' ? 95_000 : 35_000),
    });
  } catch {
    throw new Error('Cannot reach the local helper. Run “npm start” in the browser-agent folder, then check the connection again.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed. Please try again.');
  return result;
}

function addMessage(role, content, error = false) {
  const element = document.createElement('div');
  element.className = `message ${role}${error ? ' error' : ''}`;
  element.textContent = content;
  $('messages').append(element);
  $('messages').scrollTop = $('messages').scrollHeight;
  return element;
}

async function saveHistory() {
  await chrome.storage.session.set({ [`history:${accountId}`]: history.slice(-40) });
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('Open a web page in this Chrome window.');
  return tab;
}

async function updatePageLabel() {
  try {
    const tab = await currentTab();
    $('page-label').textContent = tab.url ? new URL(tab.url).hostname : 'Open a web page';
  } catch { $('page-label').textContent = 'Open a web page'; }
}

async function pageTarget() {
  const tab = await currentTab();
  let url;
  try { url = new URL(tab.url); } catch { /* Restricted browser pages have no editable document. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol)) throw new Error('Switch to a website tab. Browser settings and extension pages cannot be edited.');
  const origin = `${url.origin}/*`;
  const allowed = await chrome.permissions.contains({ origins: [origin] });
  if (!allowed && !await chrome.permissions.request({ origins: [origin] })) {
    throw new Error('Allow Browser Agent to read and change this site, then send your message again.');
  }
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => location.href });
  const target = { tabId: tab.id, documentId: result.documentId, url: result.result };
  await chrome.scripting.executeScript({ target: { tabId: target.tabId, documentIds: [target.documentId] }, files: ['content.js'] });
  return target;
}

async function onPage(target, method, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: target.tabId, documentIds: [target.documentId] },
    func: (expectedUrl, method, args) => {
      if (location.href !== expectedUrl) return { error: 'The page changed while processing your request. Send it again on the current page.' };
      try { return { value: globalThis.browserAgent[method](...args) }; }
      catch (error) { return { error: error.message }; }
    },
    args: [target.url, method, args],
  });
  if (result.result.error) throw new Error(result.result.error);
  return result.result.value;
}

async function loadModels() {
  const { models } = await api('/models');
  $('model').replaceChildren();
  for (const model of models) $('model').add(new Option(model.name, model.id));
  if (!models.length) throw new Error('This ChatGPT account has no available models. Check its plan and workspace settings.');
  const saved = await chrome.storage.local.get('model');
  if (models.some(model => model.id === saved.model)) $('model').value = saved.model;
}

async function checkConnection() {
  try {
    const state = await api('/status');
    const previousSelection = $('account').value;
    $('account').replaceChildren(new Option('Add a ChatGPT account', ''));
    for (const account of state.accounts) {
      $('account').add(new Option(`${account.email} · ${account.id.slice(-6)}`, account.id));
    }
    $('account').value = previousSelection || state.activeId || '';
    $('setup-status').textContent = state.error || (state.pending ? 'Finish signing in on OpenAI’s website…' : 'Local helper is ready. Connect your ChatGPT account.');
    $('connect').disabled = false;
    $('connect').textContent = state.pending ? 'Restart ChatGPT sign-in' : 'Continue with ChatGPT';
    if (state.pending) {
      if (!polling) polling = setInterval(checkConnection, 2000);
      connected = false;
      $('setup').hidden = false;
      $('chat').hidden = true;
      return;
    }
    connected = state.connected;
    if (!connected) {
      $('setup').hidden = false;
      $('chat').hidden = true;
      $('signout').hidden = true;
      return;
    }
    clearInterval(polling);
    polling = null;
    if (accountId !== state.activeId) {
      accountId = state.activeId;
      const key = `history:${accountId}`;
      history = (await chrome.storage.session.get(key))[key] || [];
      $('messages').replaceChildren();
      for (const item of history) addMessage(item.role, item.content);
      if (!history.length) addMessage('assistant', 'What would you like to change?\n\nI can read this page, rearrange items, hide distractions, change styles, or edit text. Try YouTube, Instagram, or another website.');
    }
    $('identity').textContent = state.email;
    if (modelAccount !== accountId) {
      await loadModels();
      modelAccount = accountId;
    }
    $('setup').hidden = true;
    $('chat').hidden = false;
    $('signout').hidden = false;
    await updatePageLabel();
  } catch (error) {
    connected = false;
    $('setup-status').textContent = error.message;
    $('setup').hidden = false;
    $('chat').hidden = true;
    $('connect').disabled = false;
  }
}

$('connect').addEventListener('click', async () => {
  $('connect').disabled = true;
  try {
    const { url } = await api('/auth/start', { accountId: $('account').value || undefined });
    await chrome.tabs.create({ url });
    $('setup-status').textContent = 'Finish signing in on OpenAI’s website, then return to your page.';
    clearInterval(polling);
    polling = setInterval(checkConnection, 2000);
  } catch (error) {
    $('setup-status').textContent = error.message;
    $('connect').disabled = false;
  }
});
$('retry').addEventListener('click', checkConnection);
$('signout').addEventListener('click', async () => {
  if (busy) return;
  $('signout').disabled = true;
  try {
    const { revoked } = await api('/auth/logout', {});
    connected = false;
    modelAccount = null;
    await checkConnection();
    if (!revoked) $('setup-status').textContent = 'Signed out locally. Remote revocation was not confirmed; you can disconnect Browser Agent in ChatGPT Settings.';
  } catch (error) { addMessage('assistant', error.message, true); }
  finally { $('signout').disabled = false; }
});
$('model').addEventListener('change', () => chrome.storage.local.set({ model: $('model').value }));

async function send(message) {
  if (busy || !connected || !message.trim()) return;
  busy = true;
  for (const id of ['send', 'undo', 'signout', 'model']) $(id).disabled = true;
  $('message').value = '';
  $('suggestions').hidden = true;
  addMessage('user', message);
  const progress = addMessage('assistant', 'Reading the page…');
  try {
    const target = await pageTarget();
    const page = await onPage(target, 'snapshot');
    const kilobytes = (page.characters / 1000).toFixed(1);
    $('context-size').textContent = `${kilobytes} KB · ~${page.estimatedTokens.toLocaleString()} tokens${page.truncated ? ' · partial page' : ''}`;
    progress.textContent = `Thinking with ${kilobytes} KB of page context…`;
    const result = await api('/plan', { message, model: $('model').value, page, history });
    if (result.action === 'reply') progress.textContent = result.message;
    else {
      const outcome = await onPage(target, 'apply', [result, page.id]);
      progress.textContent = result.action === 'undo' ? outcome : `${result.message}\n\nApplied ${outcome.count} page ${outcome.count === 1 ? 'edit' : 'edits'}.`;
    }
    history.push({ role: 'user', content: message }, { role: 'assistant', content: progress.textContent });
    await saveHistory();
  } catch (error) {
    progress.textContent = error.message;
    progress.classList.add('error');
  } finally {
    busy = false;
    for (const id of ['send', 'undo', 'signout', 'model']) $(id).disabled = false;
    $('message').focus();
  }
}

$('composer').addEventListener('submit', event => { event.preventDefault(); send($('message').value.trim()); });
$('message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send($('message').value.trim());
  }
});
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => send(button.dataset.prompt));
$('undo').addEventListener('click', async () => {
  if (busy) return;
  $('undo').disabled = true;
  try { addMessage('assistant', await onPage(await pageTarget(), 'undo')); }
  catch (error) { addMessage('assistant', error.message, true); }
  finally { $('undo').disabled = false; }
});
chrome.tabs.onActivated.addListener(updatePageLabel);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.status === 'complete') updatePageLabel();
});
checkConnection();
