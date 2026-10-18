/**
 * Offline harness for the account-balance-pill Client half.
 *
 * Loads client.js with a minimal browser/React/locale/slots/remote stand-in,
 * then exercises the store and the rendered label without a real browser.
 * Run: node harness.mjs <path-to-client.js>
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const CLIENT_PATH = process.argv[2];
if (!CLIENT_PATH) throw new Error('usage: node harness.mjs <client.js>');

// ------------------------------------------------------------- environment --
const createdStyles = [];
const cleanups = [];
const timers = { intervals: 0, timeouts: 0 };
let pendingEffects = [];

const documentStub = {
  visibilityState: 'visible',
  head: { appendChild(tag) { createdStyles.push(tag); } },
  createElement(tag) { return { tag, dataset: {}, textContent: '' }; },
  querySelector() { return null; },
  addEventListener() {},
  removeEventListener() {},
};

const React = {
  createElement(type, props, ...children) {
    return { type, props: Object.assign({}, props || {}, { children: children.length <= 1 ? children[0] : children }) };
  },
  memo(fn) { return fn; },
  Component: class Component {
    constructor(props) { this.props = props; this.state = {}; }
    setState() {}
  },
  useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot(); },
  useEffect(fn) { pendingEffects.push(fn); },
  useState(initial) { return [initial, () => {}]; },
};

let moduleFactory = null;
globalThis.window = globalThis;
globalThis.window.__ModuleLoader__ = { load(definition) { moduleFactory = definition.factory; } };
globalThis.window.__DSH_BOOT__ = { release: { version: '0.2.1-rc.2' } };
globalThis.document = documentStub;
// A browser window is an EventTarget; Node's globalThis is not.
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const RealSetTimeout = globalThis.setTimeout;
const RealClearTimeout = globalThis.clearTimeout;
const RealSetInterval = globalThis.setInterval;
const RealClearInterval = globalThis.clearInterval;
globalThis.setTimeout = (...args) => { timers.timeouts += 1; return RealSetTimeout(...args); };
globalThis.clearTimeout = (...args) => RealClearTimeout(...args);
globalThis.setInterval = (...args) => { timers.intervals += 1; return RealSetInterval(...args); };
globalThis.clearInterval = (...args) => RealClearInterval(...args);

await import(pathToFileURL(CLIENT_PATH).href);
assert.ok(moduleFactory, 'client module registered a factory');

const require = (name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require(${name})`);
};
const plugin = moduleFactory(require);
assert.ok(plugin && typeof plugin.apply === 'function', 'factory returned { apply }');
console.log('module inject:', JSON.stringify(plugin.inject));

// ------------------------------------------------------------------- mocks --
let accountCalls = [];
let remoteBehavior = 'ready';
let walletOverride = null;
const remote = {
  account: {
    async getBalance(metadata) {
      accountCalls.push(metadata);
      if (walletOverride !== null) {
        return { ok: true, value: { status: 'ready', value: [walletOverride.wallet], bonusWallets: walletOverride.bonus } };
      }
      if (remoteBehavior === 'throw') throw new Error('connection lost');
      if (remoteBehavior === 'null') return { ok: true, value: null };
      if (remoteBehavior === 'failed') return { ok: true, value: { status: 'failed' } };
      if (remoteBehavior === 'transport') return { ok: false, error: { code: 'OFFLINE' } };
      return {
        ok: true,
        value: {
          status: 'ready',
          value: [{ currency: 'CNY', balance: '12.34' }],
          bonusWallets: [{ currency: 'CNY', balance: '5' }],
        },
      };
    },
  },
};

let captured = null;
const ctx = {
  get(key) { return key === 'remote' ? remote : undefined; },
  effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup; },
  slotRegistrations: [],
  slots: {
    inject(owner, callback) { const cleanup = callback(); return typeof cleanup === 'function' ? cleanup : () => {}; },
    register(options, component) { captured = { options, component }; ctx.slotRegistrations.push(options); return () => {}; },
  },
  locale: {
    getSnapshot() { return { active: 'zh' }; },
    register(namespace, dictionaries) { ctx.localeNamespace = namespace; ctx.localeDictionaries = dictionaries; return () => {}; },
  },
  inject(deps, callback) { (ctx.injectedDeps ??= []).push(deps); callback({}); },
};

plugin.apply(ctx);
assert.equal(createdStyles.length, 1, 'style tag injected once');
assert.match(createdStyles[0].textContent, /dsabp-pill/);
assert.equal(ctx.slotRegistrations.length, 1, 'one dock registration');
assert.equal(ctx.localeNamespace, 'accountBalance', 'locale namespace registered');
assert.ok(ctx.localeDictionaries.zh && ctx.localeDictionaries.en, 'zh + en dictionaries');
assert.deepEqual(
  [...ctx.injectedDeps].sort(),
  [['remote'], ['remote.account']],
  'waits for the account Remote (base service and namespaced key)',
);

const options = captured.options;
assert.equal(options.name, 'conversation.composer.dock');
assert.equal(options.id, 'account-balance');
assert.equal(options.order, 5);
assert.equal(options.locale, 'accountBalance');

const store = options.inject().store;
assert.ok(store && typeof store.subscribe === 'function' && typeof store.activate === 'function');

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

// ------------------------------------------------------------- rendering ---
const Component = captured.component;

function findText(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(findText).join('');
  return findText(node.props && node.props.children);
}

function findButton(node) {
  if (node === null || node === undefined) return null;
  if (typeof node !== 'object') return null;
  if (node.type === 'button') return node;
  const children = node.props && node.props.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findButton(child);
      if (found) return found;
    }
    return null;
  }
  return findButton(children);
}

/** Run the component the way the slot renderer would, with t bound to a locale. */
function render(locale, target = store) {
  pendingEffects = [];
  const t = (key, params) => {
    let template = ctx.localeDictionaries[locale][key];
    if (typeof template !== 'string') template = ctx.localeDictionaries.en[key];
    if (typeof template !== 'string') return key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
  const wrapper = Component({ store: target, t, useProjection: () => ({ steps: 3 }) });
  assert.ok(wrapper && wrapper.props && wrapper.props.children, 'entry renders a boundary');
  const inner = wrapper.props.children;
  const tree = inner.type(inner.props);
  const effectCleanups = pendingEffects.map((fn) => fn()).filter((cleanup) => typeof cleanup === 'function');
  effectCleanups.forEach((cleanup) => cleanup());
  return tree;
}

const renderLabel = (locale) => findText(render(locale));

store.activate();
await flush();
assert.equal(accountCalls.length, 1, 'read on mount');
const metadata = accountCalls[0];
assert.equal(metadata.locale, 'zh');
assert.equal(metadata.version, '0.2.1-rc.2');
assert.equal(typeof metadata.timezoneOffsetSeconds, 'number');

let snapshot = store.getSnapshot();
assert.equal(snapshot.phase, 'ready');
assert.deepEqual(snapshot.wallets, [{ currency: 'CNY', balance: '12.34' }]);
assert.deepEqual(snapshot.bonusWallets, [{ currency: 'CNY', balance: '5' }]);

let tree = render('zh');
let label = findText(tree);
let button = findButton(tree);
assert.ok(label.includes('余额 ¥17.34'), `zh label: ${label}`);
assert.ok(button.props.title.includes('充值余额 ¥12.34'), `title: ${button.props.title}`);
assert.ok(button.props.title.includes('赠送余额 ¥5.00'), `title: ${button.props.title}`);
assert.ok(button.props.title.includes('更新于'), `title has updated-at: ${button.props.title}`);

tree = render('en');
assert.ok(findText(tree).includes('Balance ¥17.34'), 'en label');

// Click requests a refresh even inside the min-spacing window.
const beforeClick = accountCalls.length;
findButton(render('zh')).props.onClick();
await flush();
assert.ok(accountCalls.length >= beforeClick + 1, 'manual refresh bypasses spacing');

// Sub-cent, zero, grouped, multi-currency and negative formatting.
async function expectLabel(wallet, bonus, expected) {
  walletOverride = { wallet, bonus };
  store.refresh('manual');
  await flush();
  const text = renderLabel('zh');
  assert.ok(text.includes(expected), `expected ${expected} in ${text}`);
}

await expectLabel({ currency: 'CNY', balance: '12345.678' }, [], '余额 ¥12,345.67');
await expectLabel({ currency: 'CNY', balance: '0.001' }, [], '余额 <¥0.01');
await expectLabel({ currency: 'CNY', balance: '0' }, [], '余额 ¥0.00');
await expectLabel({ currency: 'USD', balance: '3.5' }, [{ currency: 'CNY', balance: '1' }], '余额 ¥1.00 + $3.50');
await expectLabel({ currency: 'CNY', balance: '-0.5' }, [], '余额 -¥0.50');
walletOverride = null;

// Signed out / absent grant: the pill disappears but keeps its timestamp.
remoteBehavior = 'null';
store.refresh('manual');
await flush();
assert.equal(store.getSnapshot().phase, 'empty');
assert.equal(render('zh'), null, 'hidden when no balance');
assert.ok(store.getSnapshot().updatedAt > 0);

// A good read restores the pill after the signed-out gap.
walletOverride = { wallet: { currency: 'CNY', balance: '2' }, bonus: [] };
store.refresh('manual');
await flush();
walletOverride = null;
assert.equal(findText(render('zh')).trim(), '余额 ¥2.00');

// Failure keeps the last good value visible but marked stale.
remoteBehavior = 'throw';
store.refresh('manual');
await flush();
snapshot = store.getSnapshot();
assert.equal(snapshot.error, true);
assert.equal(snapshot.phase, 'ready', 'stale value kept');
assert.equal(snapshot.busy, false);
button = findButton(render('zh'));
assert.equal(button.props['data-stale'], 'true');
assert.ok(button.props.title.includes('余额读取失败'), `stale title: ${button.props.title}`);

// Initial failure with no previous value stays hidden: a fresh store whose
// Remote is missing entirely must idle quietly; a transport failure must hide.
const originalGet = ctx.get;
ctx.get = () => undefined;
remoteBehavior = 'ready';
plugin.apply(ctx);
const isolated = captured.options.inject().store;
isolated.activate();
await flush();
assert.equal(isolated.getSnapshot().phase, 'idle', 'missing Remote stays idle');
assert.equal(render('zh', isolated), null, 'missing Remote stays hidden');
ctx.get = originalGet;
remoteBehavior = 'transport';
isolated.refresh('manual');
await flush();
assert.equal(isolated.getSnapshot().phase, 'error', 'transport failure with no data is an error');
assert.equal(render('zh', isolated), null, 'transport failure stays hidden');
isolated.dispose();

// Unmount stops polling; a second mount restarts it.
store.deactivate();
assert.equal(timers.intervals, 2, 'one interval per store, two stores created');
store.activate();
store.deactivate();
store.dispose();

console.log('all assertions passed');
process.exit(0);
