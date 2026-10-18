/**
 * Account balance pill — shows the DeepSeek account's remaining balance in the
 * composer dock, i.e. the bottom-bar row that already carries the turn/step and
 * token-usage stat pills next to the context ring.
 *
 * The read goes through the shipped account Remote
 * (`remote.account.getBalance`), the very call the Settings > Account panel
 * uses, so no credential ever reaches the client and no private store is
 * touched. Every dependency is treated as optional: when the Remote, the
 * account grant or the dock slot itself is absent, the pill stays hidden
 * instead of disturbing the dock. A late-arriving Remote is picked up through
 * `ctx.inject`, a completed turn through the optional `useProjection` prop.
 */
window.__ModuleLoader__.load({
  id: 'dsh-account-balance-pill',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'accountBalance';
    const ENTRY_ID = 'account-balance';
    const SLOT = 'conversation.composer.dock';
    const STYLE_ID = 'dsh-account-balance-pill/Pill.module.css';

    const DEFAULT_INTERVAL_MS = 30000;
    const MIN_INTERVAL_MS = 5000;
    const MAX_INTERVAL_MS = 3600000;
    const MIN_REQUEST_SPACING_MS = 3000;
    const FRESH_MS = 15000;
    const RETRY_BASE_MS = 4000;
    const RETRY_MAX_MS = 60000;
    const TURN_DEBOUNCE_MS = 1500;

    // ---------------------------------------------------------------- text --
    // Registered into the Client locale service under `accountBalance`.
    const dictionaries = {
      zh: {
        label: '余额',
        title: '账户余额',
        toppedUp: '充值余额',
        granted: '赠送余额',
        updatedAt: '更新于 {time}',
        refresh: '点击刷新',
        failed: '余额读取失败，正在重试',
      },
      en: {
        label: 'Balance',
        title: 'Account balance',
        toppedUp: 'Topped-up',
        granted: 'Granted',
        updatedAt: 'Updated {time}',
        refresh: 'Click to refresh',
        failed: 'Balance read failed, retrying',
      },
    };

    // --------------------------------------------------------------- style --
    // `data-plugin` marks the tag as owned by this module: the loader claims,
    // inventories and removes package styles with the plugin.
    const css = [
      '.dsabp-anchor{display:inline-flex;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));}',
      '.dsabp-pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;max-width:100%;border:none;background:0 0;border-radius:var(--dsw-radius-sm,4px);color:var(--dsw-alias-label-tertiary,#8b8b8b);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}',
      '.dsabp-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#6b6b6b)}',
      '.dsabp-pill:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:2px}',
      '.dsabp-pill[data-stale="true"]{opacity:.55}',
      '.dsabp-pill[data-busy="true"]{opacity:.75}',
      '.dsabp-icon{flex:none;width:14px;height:14px}',
      '.dsabp-label{overflow:hidden;text-overflow:ellipsis;min-width:0}',
    ].join('');

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-account-balance-pill';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ------------------------------------------------------------ formatting --
    const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' };

    /** Group the integer digits of a plain decimal string. */
    function addCommas(text) {
      const parts = String(text).split('.');
      const integer = Number(parts[0]);
      const grouped = Number.isFinite(integer) ? integer.toLocaleString() : parts[0];
      return parts.length > 1 ? grouped + '.' + parts[1] : grouped;
    }

    /**
     * Truncate a decimal string to two fraction digits toward zero, mirroring
     * Big.roundDown: a balance is never displayed as more money than it is.
     */
    function truncateToCents(text) {
      const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
      if (match === null) return null;
      const fraction = (match[3] === undefined ? '' : match[3] + '00').slice(0, 2);
      return (match[1] === '-' ? '-' : '') + match[2] + '.' + fraction;
    }

    /**
     * Format a decimal balance string the way the shipped Settings > Account
     * panel does: grouped thousands, sub-cent amounts shown as `<¥0.01`, and
     * negative amounts floored at one cent.
     */
    function formatAmount(raw, symbol) {
      const text = typeof raw === 'string' ? raw.trim() : String(raw);
      const value = Number(text);
      if (!Number.isFinite(value)) return symbol + '--';
      if (value === 0) return symbol + '0.00';
      const truncated = truncateToCents(text);
      if (truncated === null) return symbol + '--';
      const negative = truncated.charAt(0) === '-';
      const magnitude = negative ? truncated.slice(1) : truncated;
      if (negative) return value > -0.01 ? '-' + symbol + '0.01' : '-' + symbol + addCommas(magnitude);
      if (value < 0.01) return '<' + symbol + '0.01';
      return symbol + addCommas(magnitude);
    }

    /** Build one display string from a summed decimal value. */
    function formatTotal(entry) {
      const symbol = CURRENCY_SYMBOLS[entry.currency];
      const raw = Number.isFinite(entry.value) ? entry.value.toFixed(6) : '0';
      return formatAmount(raw, symbol === undefined ? entry.currency + ' ' : symbol);
    }

    /** Keep only well-formed wallets: a 3-letter currency code and a decimal balance. */
    function normalizeWallets(wallets) {
      const result = [];
      if (!Array.isArray(wallets)) return result;
      for (let index = 0; index < wallets.length; index += 1) {
        const wallet = wallets[index];
        if (wallet === null || typeof wallet !== 'object') continue;
        const currency = typeof wallet.currency === 'string' ? wallet.currency.toUpperCase() : '';
        if (!/^[A-Z]{3}$/.test(currency)) continue;
        const raw = typeof wallet.balance === 'string' ? wallet.balance.trim() : typeof wallet.balance === 'number' ? String(wallet.balance) : '';
        if (!/^-?\d+(?:\.\d+)?$/.test(raw)) continue;
        result.push({ currency, balance: raw });
      }
      return result;
    }

    /** Sum wallets per currency. */
    function sumByCurrency(wallets) {
      const totals = new Map();
      for (let index = 0; index < wallets.length; index += 1) {
        const wallet = wallets[index];
        const value = Number(wallet.balance);
        if (!Number.isFinite(value)) continue;
        const current = totals.get(wallet.currency);
        totals.set(wallet.currency, current === undefined ? value : current + value);
      }
      const result = [];
      totals.forEach((value, currency) => { result.push({ currency, value }); });
      result.sort((left, right) => (left.currency === right.currency ? 0 : left.currency === 'CNY' ? -1 : right.currency === 'CNY' ? 1 : left.currency < right.currency ? -1 : 1));
      return result;
    }

    /** Topped-up and granted wallets combined per currency: the spendable total. */
    function combineTotals(main, granted) {
      const totals = new Map();
      const absorb = (entries) => {
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          const current = totals.get(entry.currency);
          totals.set(entry.currency, current === undefined ? entry.value : current + entry.value);
        }
      };
      absorb(main);
      absorb(granted);
      const result = [];
      totals.forEach((value, currency) => { result.push({ currency, value }); });
      result.sort((left, right) => (left.currency === right.currency ? 0 : left.currency === 'CNY' ? -1 : right.currency === 'CNY' ? 1 : left.currency < right.currency ? -1 : 1));
      return result;
    }

    function joinAmounts(entries) {
      const parts = [];
      for (let index = 0; index < entries.length; index += 1) parts.push(formatTotal(entries[index]));
      return parts.join(' + ');
    }

    function interpolate(template, params) {
      if (typeof template !== 'string') return '';
      if (params === undefined || params === null) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match));
    }

    function formatClock(timestamp) {
      try {
        return new Date(timestamp).toLocaleTimeString();
      } catch (error) {
        return '';
      }
    }

    // --------------------------------------------------------------- store --
    /** Poll interval override for power users / tests: window.__DSH_ACCOUNT_BALANCE__ = { intervalMs }. */
    function readIntervalOption() {
      try {
        const options = typeof window === 'undefined' ? undefined : window.__DSH_ACCOUNT_BALANCE__;
        const value = options !== null && typeof options === 'object' ? options.intervalMs : undefined;
        if (typeof value === 'number' && Number.isFinite(value)) {
          return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(value)));
        }
      } catch (error) {
        /* fall through to the default */
      }
      return DEFAULT_INTERVAL_MS;
    }

    /**
     * One shared balance store: polling, focus/visibility refresh, retry
     * backoff and the turn-completion nudge. It outlives individual pill
     * instances and only reads while at least one pill is mounted.
     */
    function createStore(ctx) {
      let snapshot = Object.freeze({ phase: 'idle', wallets: [], bonusWallets: [], updatedAt: 0, busy: false, error: false });
      const listeners = new Set();
      let intervalTimer = null;
      let retryTimer = null;
      let turnTimer = null;
      let visibilityHandler = null;
      let focusHandler = null;
      let activeCount = 0;
      let disposed = false;
      let inflight = null;
      let lastAttemptAt = 0;
      let lastSuccessAt = 0;
      let failures = 0;
      let lastSteps = -1;
      let loggedUnavailable = false;

      const publish = (patch) => {
        snapshot = Object.freeze(Object.assign({}, snapshot, patch));
        listeners.forEach((listener) => {
          try {
            listener();
          } catch (error) {
            console.error('[account-balance-pill] store listener failed', error);
          }
        });
      };

      const getSnapshot = () => snapshot;

      const subscribe = (listener) => {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };

      const getRemoteAccount = () => {
        // The account namespace is registered as its own Client Service
        // (`remote.account`). Reading it through the Service registry works
        // from any plugin context, while the `ctx.remote.account` property
        // path is only readable by a context that declares that exact
        // dependency, so prefer the registry.
        try {
          const namespaced = ctx.get('remote.account');
          if (namespaced !== null && namespaced !== undefined && typeof namespaced.getBalance === 'function') return namespaced;
        } catch (error) {
          /* fall through to the proxy shapes below */
        }
        let remote;
        try {
          remote = ctx.get('remote');
        } catch (error) {
          remote = undefined;
        }
        // Some client runtimes expose the connection as a context property
        // rather than through Service lookup; accept either shape.
        if (remote === null || remote === undefined) {
          try {
            remote = ctx.remote;
          } catch (error) {
            remote = undefined;
          }
        }
        if (remote === null || remote === undefined) return undefined;
        let account;
        try {
          account = remote.account;
        } catch (error) {
          account = undefined;
        }
        if (account === null || account === undefined || typeof account.getBalance !== 'function') return undefined;
        return account;
      };

      const clientMetadata = () => {
        let locale = 'en';
        try {
          const localeSnapshot = ctx.locale.getSnapshot();
          if (localeSnapshot !== null && typeof localeSnapshot === 'object' && typeof localeSnapshot.active === 'string' && localeSnapshot.active !== '') locale = localeSnapshot.active;
        } catch (error) {
          /* the host accepts any wire locale; keep the default */
        }
        let version = '0.0.0';
        try {
          const boot = typeof window === 'undefined' ? undefined : window.__DSH_BOOT__;
          const release = boot !== null && typeof boot === 'object' ? boot.release : undefined;
          if (release !== null && typeof release === 'object' && typeof release.version === 'string' && release.version !== '') version = release.version;
        } catch (error) {
          /* keep the fallback version */
        }
        return { version, locale, timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 };
      };

      const read = async () => {
        const account = getRemoteAccount();
        if (account === undefined) {
          if (!loggedUnavailable) {
            loggedUnavailable = true;
            console.info('[account-balance-pill] account Remote is not available yet; the pill stays hidden');
          }
          return { kind: 'unavailable' };
        }
        loggedUnavailable = false;
        const result = await account.getBalance(clientMetadata());
        if (result === null || typeof result !== 'object' || result.ok !== true) return { kind: 'failed' };
        const value = result.value;
        if (value === null || value === undefined) return { kind: 'empty' };
        if (value.status === 'failed') return { kind: 'failed' };
        if (value.status !== 'ready') return { kind: 'failed' };
        return { kind: 'ready', wallets: normalizeWallets(value.value), bonusWallets: normalizeWallets(value.bonusWallets) };
      };

      const clearRetry = () => {
        if (retryTimer !== null) {
          window.clearTimeout(retryTimer);
          retryTimer = null;
        }
      };

      const scheduleRetry = (delayOverride) => {
        clearRetry();
        if (disposed) return;
        const backoff = RETRY_BASE_MS * Math.pow(2, Math.min(failures, 4));
        const delay = typeof delayOverride === 'number' ? delayOverride : Math.min(RETRY_MAX_MS, backoff);
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          refresh('retry');
        }, delay);
      };

      const refresh = (reason) => {
        if (disposed) return Promise.resolve();
        if (inflight !== null) return inflight;
        const now = Date.now();
        if (reason !== 'manual' && now - lastAttemptAt < MIN_REQUEST_SPACING_MS) return Promise.resolve();
        lastAttemptAt = now;
        inflight = (async () => {
          publish({ busy: true });
          try {
            const outcome = await read();
            if (disposed) return;
            if (outcome.kind === 'ready') {
              failures = 0;
              lastSuccessAt = Date.now();
              clearRetry();
              const funds = outcome.wallets.length > 0 || outcome.bonusWallets.length > 0;
              publish({
                phase: funds ? 'ready' : 'empty',
                wallets: outcome.wallets,
                bonusWallets: outcome.bonusWallets,
                updatedAt: lastSuccessAt,
                busy: false,
                error: false,
              });
            } else if (outcome.kind === 'empty') {
              failures = 0;
              lastSuccessAt = Date.now();
              clearRetry();
              publish({ phase: 'empty', wallets: [], bonusWallets: [], updatedAt: lastSuccessAt, busy: false, error: false });
            } else if (outcome.kind === 'unavailable') {
              publish({ busy: false });
              scheduleRetry(RETRY_BASE_MS);
            } else {
              failures += 1;
              publish({ phase: snapshot.wallets.length > 0 || snapshot.bonusWallets.length > 0 ? 'ready' : 'error', busy: false, error: true });
              scheduleRetry();
              if (failures === 1) console.warn('[account-balance-pill] balance read failed', failures);
            }
          } catch (error) {
            if (disposed) return;
            failures += 1;
            publish({ phase: snapshot.wallets.length > 0 || snapshot.bonusWallets.length > 0 ? 'ready' : 'error', busy: false, error: true });
            scheduleRetry();
            if (failures === 1) console.warn('[account-balance-pill] balance read failed', error);
          } finally {
            inflight = null;
          }
        })();
        return inflight;
      };

      const startTimers = () => {
        if (intervalTimer !== null) return;
        const intervalMs = readIntervalOption();
        intervalTimer = window.setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          refresh('interval');
        }, intervalMs);
      };

      const stopTimers = () => {
        if (intervalTimer !== null) {
          window.clearInterval(intervalTimer);
          intervalTimer = null;
        }
        clearRetry();
        if (turnTimer !== null) {
          window.clearTimeout(turnTimer);
          turnTimer = null;
        }
      };

      const attachListeners = () => {
        if (typeof document !== 'undefined' && visibilityHandler === null) {
          visibilityHandler = () => {
            if (document.visibilityState === 'visible' && Date.now() - lastSuccessAt > FRESH_MS) refresh('visible');
          };
          document.addEventListener('visibilitychange', visibilityHandler);
        }
        if (typeof window !== 'undefined' && focusHandler === null) {
          focusHandler = () => {
            if (Date.now() - lastSuccessAt > FRESH_MS) refresh('focus');
          };
          window.addEventListener('focus', focusHandler);
        }
      };

      const detachListeners = () => {
        if (visibilityHandler !== null && typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', visibilityHandler);
          visibilityHandler = null;
        }
        if (focusHandler !== null && typeof window !== 'undefined') {
          window.removeEventListener('focus', focusHandler);
          focusHandler = null;
        }
      };

      const activate = () => {
        if (disposed) return;
        activeCount += 1;
        if (activeCount > 1) return;
        attachListeners();
        startTimers();
        refresh('mount');
      };

      const deactivate = () => {
        if (activeCount === 0) return;
        activeCount -= 1;
        if (activeCount > 0) return;
        detachListeners();
        stopTimers();
      };

      /** A completed turn changes the balance: refresh shortly after the step settles. */
      const noticeSteps = (steps) => {
        if (typeof steps !== 'number' || !Number.isFinite(steps) || steps < 0) return;
        if (lastSteps < 0) {
          lastSteps = steps;
          return;
        }
        if (steps === lastSteps) return;
        lastSteps = steps;
        if (turnTimer !== null) return;
        turnTimer = window.setTimeout(() => {
          turnTimer = null;
          refresh('turn');
        }, TURN_DEBOUNCE_MS);
      };

      /** Called when the account Remote arrives: read right away instead of at the next tick. */
      const wake = () => {
        if (disposed || activeCount === 0) return;
        refresh('wake');
      };

      const dispose = () => {
        disposed = true;
        stopTimers();
        detachListeners();
        listeners.clear();
      };

      return { subscribe, getSnapshot, activate, deactivate, noticeSteps, wake, refresh, dispose };
    }

    // -------------------------------------------------------------- render --
    /** Fallback for a React without useSyncExternalStore (18+ ships it). */
    function useSnapshot(store) {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      }
      const [value, setValue] = React.useState(store.getSnapshot);
      React.useEffect(() => {
        setValue(store.getSnapshot());
        return store.subscribe(() => setValue(store.getSnapshot()));
      }, []);
      return value;
    }

    function WalletIcon() {
      return h(
        'svg',
        {
          className: 'dsabp-icon',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('rect', { x: 3, y: 6, width: 18, height: 12, rx: 2.5 }),
        h('path', { d: 'M3 9.75h18' }),
        h('circle', { cx: 16.5, cy: 13.5, r: 1, fill: 'currentColor', stroke: 'none' }),
      );
    }

    const FALLBACK_SNAPSHOT = Object.freeze({ phase: 'idle', wallets: [], bonusWallets: [], updatedAt: 0, busy: false, error: false });
    const FALLBACK_STORE = Object.freeze({
      subscribe() {
        return () => {};
      },
      getSnapshot() {
        return FALLBACK_SNAPSHOT;
      },
      activate() {},
      deactivate() {},
      noticeSteps() {},
      refresh() {},
    });

    function BalancePill(props) {
      const provided = props.store;
      const hasStore = provided !== null && typeof provided === 'object' && typeof provided.subscribe === 'function' && typeof provided.getSnapshot === 'function';
      const store = hasStore ? provided : FALLBACK_STORE;
      const t = props.t;
      const useProjection = props.useProjection;
      const snapshot = useSnapshot(store);

      // Optional: a session assembly that serves the sessionStats projection
      // lets a completed turn refresh the balance right away.
      const projected = typeof useProjection === 'function' ? useProjection('sessionStats') : undefined;
      const steps = projected !== null && typeof projected === 'object' && typeof projected.steps === 'number' ? projected.steps : -1;

      React.useEffect(() => {
        store.noticeSteps(steps);
      }, [store, steps]);
      React.useEffect(() => {
        store.activate();
        return () => {
          store.deactivate();
        };
      }, [store]);

      const text = (key, params) => {
        const fallback = interpolate(dictionaries.en[key], params);
        if (typeof t !== 'function') return fallback;
        let translated;
        try {
          translated = params === undefined ? t(key) : t(key, params);
        } catch (error) {
          return fallback;
        }
        return typeof translated === 'string' && translated !== '' && translated !== key ? translated : fallback;
      };

      if (snapshot.phase !== 'ready') return null;

      const main = sumByCurrency(snapshot.wallets);
      const granted = sumByCurrency(snapshot.bonusWallets);
      // Granted wallets are usually present with a zero balance; only mention
      // the ones that actually carry money (same rule as the shipped panel).
      const grantedShown = granted.filter((entry) => entry.value > 0);
      const combined = combineTotals(main, grantedShown);
      if (combined.length === 0) return null;

      const label = text('label') + ' ' + joinAmounts(combined);
      const titleParts = [text('title')];
      if (main.length > 0) titleParts.push(text('toppedUp') + ' ' + joinAmounts(main));
      if (grantedShown.length > 0) titleParts.push(text('granted') + ' ' + joinAmounts(grantedShown));
      if (snapshot.updatedAt > 0) titleParts.push(text('updatedAt', { time: formatClock(snapshot.updatedAt) }));
      if (snapshot.error) titleParts.push(text('failed'));
      titleParts.push(text('refresh'));
      const tooltip = titleParts.join(' · ');

      return h(
        'span',
        { className: 'dsabp-anchor' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsabp-pill',
            title: tooltip,
            'aria-label': tooltip,
            'data-stale': snapshot.error ? 'true' : undefined,
            'data-busy': snapshot.busy ? 'true' : undefined,
            onClick: () => {
              store.refresh('manual');
            },
          },
          h(WalletIcon, null),
          h('span', { className: 'dsabp-label' }, label),
        ),
      );
    }

    const MemoBalancePill = React.memo(BalancePill);

    /** Keeps a rendering failure inside this entry instead of blanking the dock. */
    class PillBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        console.error('[account-balance-pill] pill failed to render', error);
      }

      render() {
        if (this.state.failed) return null;
        return this.props.children;
      }
    }

    function BalancePillEntry(props) {
      return h(PillBoundary, null, h(MemoBalancePill, props));
    }

    // -------------------------------------------------------------- plugin --
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const store = createStore(ctx);
        ctx.effect(
          () => () => {
            store.dispose();
          },
          'account-balance-pill: store lifetime',
        );
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'account-balance-pill: dictionaries');
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: ENTRY_ID,
              order: 5,
              locale: NS,
              inject: () => ({ store }),
            },
            BalancePillEntry,
          ),
        );
        // The account Remote is provided by a sibling client plugin; wait for it
        // without making the whole pill a hard dependent of it. Waiting on the
        // namespaced key too avoids a needless backoff tick when the transport
        // arrives after this module.
        ctx.inject(['remote'], () => {
          store.wake();
        });
        ctx.inject(['remote.account'], () => {
          store.wake();
        });
      },
    };
  },
});
