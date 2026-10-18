# dsh-account-balance-pill

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin that shows the remaining balance of the signed-in DeepSeek account in the composer bottom bar — the stat row under the message box that already carries `N turns · M steps`, tokens/s, token usage and the context ring.

```
[welcome icon] 余额 ¥12.34        [stats] 1 轮 160 步 · 254 tok/s     [usage] 10.9M tok · 缓存命中 98%   (ring) 9%
```

The pill shows the **total spendable balance** (topped-up + granted) per currency, e.g. `余额 ¥17.34`; hovering it breaks the total down into topped-up and granted amounts, shows when it was last refreshed, and reminds you that a click refreshes it.

- Package name: `dsh-account-balance-pill`
- Shape: one DSH **bundle** — a Host row inserted by `dsh.bundle.patch` plus a Web Client half; no dependencies, no build step
- Rendering: a single entry (id `account-balance`) in the slot `conversation.composer.dock`, next to the shipped `activity` and `usage` pills
- Data: the account Remote that ships with DSH (`ctx.get('remote.account').getBalance(...)`, the same call the **Settings → Account** panel makes). The plugin stores nothing, reads no credential file, and makes no network request of its own.

## Install / 安装

Install from GitHub into the profile you use:

```sh
dsh plugin --profile <profile> add github:azkbzxf/dsh-account-balance-pill
```

A newly added bundle activates on the running instance (the Host row is live immediately and the Client half hot-loads into the open page). Replacing an already-installed copy needs a DSH restart for the fresh client build.

Inside DSH Desktop you can also use the plugin manager:

```json
{ "action": "install_bundle", "target": "D:\\path\\to\\dsh-account-balance-pill" }
```

Remove:

```sh
dsh plugin --profile <profile> remove dsh-account-balance-pill
```

## What it shows / 显示规则

| Account state | Bottom bar |
| --- | --- |
| Signed in with a balance | Wallet icon + `余额 ¥12.34`; tooltip with the topped-up / granted breakdown, last-update time and a click-to-refresh hint |
| Signed out, or no account grant (the Remote returns `null`) | Nothing — no placeholder, no error |
| Read failure (offline, host refused) | Keeps the last known value, dimmed as stale; stays hidden if no value was ever read |
| Currencies | `¥` for CNY and `$` for USD; topped-up + granted are combined per currency, CNY first |

Amounts are formatted by truncating to cents, matching the official Settings page so the pill never shows more money than is actually available; thousands are grouped. `0` shows `¥0.00`, anything under one cent shows `<¥0.01`.

## Refresh / 刷新时机

1. immediately when the pill mounts;
2. every 30 s while the page is visible (skipped while hidden, one catch-up read when it becomes visible again);
3. 1.5 s after a turn completes (when the `sessionStats` projection's `steps` changes);
4. when the window regains focus or the page becomes visible (only if the data is older than 15 s);
5. as soon as a late-loading account Remote appears;
6. on click.

One request is in flight at a time, requests are at least 3 s apart, and failures back off exponentially from 4 s up to 60 s before recovering automatically.

## Compatibility / 兼容性

- Targets the DSH Web GUI (the browser UI shared by DSH Desktop and `dsh web`), verified on DSH Desktop 2.0.18 with client `0.2.1-rc.2`.
- Uses only supported extension points: the list slot `conversation.composer.dock` and the shipped account Remote. It never replaces or edits existing UI, never reads another plugin's DOM or styles, never appends to `document.body`.
- Styles use Harness theme tokens only (`--dsw-*` / `--dsh-*`), so light/dark themes and font-size changes are inherited. All visible text goes through the DSH client locale service (zh/en) and follows the interface language.
- Every dependency is optional: no account Remote → the plugin loads and stays hidden; a read failure keeps the last value; a render failure is caught by an error boundary scoped to this one entry, so the rest of the dock is unaffected.
- The account service is read through the service registry (`ctx.get('remote.account')`) because the `ctx.remote.account` property chain is only readable from contexts that declare that dependency explicitly.
- `package.json` exports `"./package.json"` because DSH's client-module composition locates the package manifest through that export, and the `dsh.bundle.patch` row `name` matches the package name.
- The Host half is a no-op: it registers no credential, network client, tool or session resource.

## Configuration / 可调参数

The poll interval can be overridden globally (milliseconds, clamped to 5 s – 1 h):

```js
window.__DSH_ACCOUNT_BALANCE__ = { intervalMs: 60000 };
```

## Development / 开发

`test/harness.mjs` is an offline smoke test: it loads `client.js` with stub React/document/locale/slots/remote implementations and asserts the slot registration, locale namespace, request metadata, formatting, hidden/stale states and timer counts.

```sh
node test/harness.mjs client.js
```

File map: `client.js` — Client half (pill, store, formatting, styles); `index.js` — no-op Host half; `cordis.patch.yml` — the bundle patch; `locale/{en,zh}.json` — display metadata for the plugin list; `icon.svg` — artwork.

## Known limitations / 已知限制

- The balance comes from the DeepSeek account platform and is up to a few seconds behind, not ledger-real-time.
- The dock row only renders while a session's composer is visible (existing behaviour of the shipped slot).
- If the platform keeps failing while signed in, the plugin keeps backing off and logs one console warning on the first failure; it never opens a dialog.

## License

MIT.
