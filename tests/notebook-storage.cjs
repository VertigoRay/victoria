// Run with: node --test tests/notebook-storage.cjs
// Synthetic learner data in an isolated DOM/storage fixture; no remote requests.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'notebook-quest.html'), 'utf8');
const storageKey = html.match(/const STORAGE_KEY = '([^']+)'/)[1];

function fixture({storage = new Map(), readDenied = false, writeDenied = false} = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[1], {
      id: match[1], value: '', textContent: '', checked: false,
      hidden: /\bhidden\b/.test(match[0]), style: {}, dataset: {}, handlers: {},
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      dispatch(type) { for (const fn of this.handlers[type] || []) fn({target: this}); },
    });
  }
  const checks = [];
  for (const match of html.matchAll(/<input\b[^>]*>/g)) {
    if (!/type="checkbox"/.test(match[0])) continue;
    const id = match[0].match(/\bid="([^"]+)"/)[1];
    const element = elements.get(id);
    element.dataset.xp = match[0].match(/data-xp="([^"]+)"/)[1];
    checks.push(element);
  }
  const access = {readDenied, writeDenied};
  let writes = 0;
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)][0][1];
  vm.runInNewContext(script, {
    document: {
      getElementById: id => elements.get(id),
      querySelectorAll: () => checks,
    },
    localStorage: {
      getItem(key) { if (access.readDenied) throw new Error('Synthetic read denial'); return storage.get(key) ?? null; },
      setItem(key, value) { if (access.writeDenied) throw new Error('Synthetic quota/denial'); storage.set(key, value); writes++; },
    },
  }, {timeout: 1000});
  return {
    elements, checks, storage, access, writes: () => writes,
    status: () => elements.get('save-status').textContent,
    retry: () => elements.get('retry-save').dispatch('click'),
    toggle(index, checked) { checks[index].checked = checked; checks[index].dispatch('change'); },
    input(id, value) { const element = elements.get(id); element.value = value; element.dispatch('input'); },
  };
}

test('fresh page does not claim a save or write empty progress', () => {
  const f = fixture();
  assert.match(f.status(), /Make a change/);
  assert.equal(f.writes(), 0);
  assert.equal(f.elements.get('retry-save').hidden, true);
  assert.equal(f.checks.length, 9);
});
test('successful checkbox write confirms saving and persists the check', () => {
  const f = fixture(); f.toggle(0, true);
  assert.match(f.status(), /^Progress saved/);
  assert.equal(JSON.parse(f.storage.get(storageKey)).checks[f.checks[0].id], true);
});
test('all missions retain 100 XP and unchecking reduces it', () => {
  const f = fixture();
  f.checks.forEach((_, i) => f.toggle(i, true));
  assert.equal(f.elements.get('xp').textContent, '100');
  f.toggle(0, false);
  assert.equal(f.elements.get('xp').textContent, '90');
});
test('name, notes, XP and checks survive a fixture reload', () => {
  const f = fixture();
  f.input('player-name', 'Synthetic Learner');
  f.input('boss-notes', 'Synthetic teach-back');
  f.toggle(0, true);
  const loaded = fixture({storage: f.storage});
  assert.equal(loaded.elements.get('player-name').value, 'Synthetic Learner');
  assert.equal(loaded.elements.get('boss-notes').value, 'Synthetic teach-back');
  assert.equal(loaded.elements.get('xp').textContent, '10');
  assert.equal(loaded.checks[0].checked, true);
  assert.match(loaded.status(), /^Progress loaded/);
});
test('duplicate checked events cannot farm XP', () => {
  const f = fixture(); f.toggle(0, true); f.toggle(0, true);
  assert.equal(f.elements.get('xp').textContent, '10');
});
test('malformed saved JSON is not silently overwritten at startup', () => {
  const storage = new Map([[storageKey, '{broken']]);
  const f = fixture({storage});
  assert.match(f.status(), /could not be loaded/);
  assert.equal(storage.get(storageKey), '{broken');
  assert.equal(f.writes(), 0);
});
test('read denial warns without claiming a successful save', () => {
  const f = fixture({readDenied: true, writeDenied: true});
  assert.match(f.status(), /could not be loaded/);
  assert.doesNotMatch(f.elements.get('welcome').textContent, /saved/i);
});
test('storage denial keeps name, notes and checkbox interaction usable', () => {
  const f = fixture({readDenied: true, writeDenied: true});
  f.input('player-name', 'Synthetic Learner');
  f.input('boss-notes', 'Temporary notes');
  f.toggle(0, true);
  assert.equal(f.elements.get('player-name').value, 'Synthetic Learner');
  assert.equal(f.elements.get('boss-notes').value, 'Temporary notes');
  assert.equal(f.elements.get('xp').textContent, '10');
  assert.match(f.status(), /^Not saved/);
  assert.match(f.status(), /Keep this page open/);
  assert.equal(f.elements.get('retry-save').hidden, false);
});
test('a quota failure after a previous save replaces the success message', () => {
  const f = fixture(); f.toggle(0, true);
  f.access.writeDenied = true; f.toggle(1, true);
  assert.match(f.status(), /^Not saved/);
  assert.equal(JSON.parse(f.storage.get(storageKey)).checks[f.checks[1].id], undefined);
});
test('notes-only failure updates the warning immediately', () => {
  const f = fixture(); f.toggle(0, true);
  f.access.writeDenied = true; f.input('boss-notes', 'Unsaved note');
  assert.match(f.status(), /^Not saved/);
  assert.equal(f.elements.get('retry-save').hidden, false);
});
test('retry during continued failure leaves the warning and work intact', () => {
  const f = fixture({writeDenied: true});
  f.input('boss-notes', 'Keep this note'); f.retry();
  assert.match(f.status(), /^Not saved/);
  assert.equal(f.elements.get('boss-notes').value, 'Keep this note');
});
test('explicit retry saves the latest unsaved work and survives reload', () => {
  const f = fixture({writeDenied: true});
  f.input('player-name', 'Synthetic Learner');
  f.input('boss-notes', 'Latest unsaved note'); f.toggle(0, true);
  f.access.writeDenied = false; f.retry();
  assert.match(f.status(), /^Progress saved/);
  assert.equal(f.elements.get('retry-save').hidden, true);
  const loaded = fixture({storage: f.storage});
  assert.equal(loaded.elements.get('boss-notes').value, 'Latest unsaved note');
  assert.equal(loaded.elements.get('player-name').value, 'Synthetic Learner');
  assert.equal(loaded.checks[0].checked, true);
});
test('the next normal edit can recover without using the retry button', () => {
  const f = fixture({writeDenied: true});
  f.input('boss-notes', 'First note'); f.access.writeDenied = false;
  f.input('boss-notes', 'New note');
  assert.match(f.status(), /^Progress saved/);
  assert.equal(JSON.parse(f.storage.get(storageKey)).bossNotes, 'New note');
});
test('feedback is a polite status region and retry is a native button', () => {
  assert.match(html, /id="save-status" role="status" aria-live="polite"/);
  assert.match(html, /<button[^>]+id="retry-save"[^>]+type="button"/);
});
