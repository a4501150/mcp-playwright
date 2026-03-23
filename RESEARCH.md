# Research: Stealth Browser Automation MCP Server

Research findings from our investigation into replacing chrome-devtools-mcp with a stealth-capable, iframe-supporting Playwright MCP server.

## Problems with chrome-devtools-mcp

1. **Detected as bot** by Google, Cloudflare, etc.
2. **Can't interact with cross-origin iframes** (Stripe Elements) — issue #703 open

## CDP Detection Mechanism

The core detection vector is `Runtime.Enable` — a CDP command that standard Playwright/Puppeteer must call. When active:

- V8 inspector hooks are installed that change observable browser behavior
- `console.debug(trapObject)` triggers getters that wouldn't fire without CDP
- Anti-bot scripts (Cloudflare Turnstile, DataDome) detect this behavioral difference
- This is **protocol-level** — not fixable with JS patches alone

## CDP & Cross-Origin Iframes

CDP **can** access cross-origin iframes (it operates below Same-Origin Policy):
- `Target.setAutoAttach({ autoAttach: true, flatten: true })` → `Target.attachedToTarget` events
- `Page.createIsolatedWorld` for execution context in frames
- chrome-devtools-mcp just doesn't implement this plumbing

## Solution: Patchright

[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) is a source-level fork of Playwright (npm: `patchright`). Drop-in replacement — change one import.

How it fixes Runtime.Enable detection:
1. **Suppresses `Runtime.Enable` entirely** — uses `Page.createIsolatedWorld` to get execution context IDs directly
2. **InitScripts injected via route interception** — not via `Runtime.Enable` + `Page.addScriptToEvaluateOnNewDocument`
3. **`Console.enable` disabled** — eliminates `consoleAPICalled` leak vector

Trade-off: Console capture doesn't work on Patchright+Chromium.

**Patchright is Chromium-only** — no Firefox/WebKit support.

## Browser Strategy: Firefox Default, Patchright Chromium Fallback

| | Firefox (Playwright) | Chromium (Patchright) | WebKit (Playwright) |
|---|---|---|---|
| CDP detection | N/A — uses Firefox Remote Debug Protocol | Suppressed by Patchright | N/A — uses WebKit Inspector Protocol |
| `navigator.webdriver` | `false` by default | `false` via flag | `false` by default |
| Console capture | Full | Limited (Console.enable disabled) | Full |
| TLS fingerprint | Natural Firefox | Chrome-like | Safari-like (suspicious on non-macOS) |
| Bot suspicion | Low — normal browser | Low with Patchright | Medium — WebKit ≠ Safari fingerprint mismatch |

Firefox is the sweet spot for stealth. WebKit on non-macOS produces a suspicious fingerprint (claiming Safari but running on Linux/Windows).

## Anti-Detect Layers

### Stealth Chromium Flags (~60 flags from Scrapling)
- `--disable-blink-features=AutomationControlled` — removes `navigator.webdriver = true`
- `--fingerprinting-canvas-image-data-noise` — canvas fingerprint noise
- `--webrtc-ip-handling-policy=disable_non_proxied_udp` — blocks WebRTC IP leaks
- `--disable-webgl` / `--disable-webgl2` — WebGL fingerprinting protection
- Various flags to disable telemetry, crash reporting, background networking

### Fingerprint Randomization (Apify fingerprint-suite)
- `fingerprint-generator` — Bayesian network trained on real browser traffic, generates consistent device profiles
- `fingerprint-injector` — injects fingerprint into Playwright context via init scripts
- `header-generator` — produces matching HTTP headers
- Key principle: **consistency over randomness** — all signals must tell the same story

### Human-like Interaction
- `ghost-cursor-playwright` — Bezier curve mouse movements based on Fitts's Law
- Randomized typing: variable inter-key delay (50-150ms), longer pauses after spaces

### Proxy Support
- Playwright natively supports HTTP/HTTPS/SOCKS5 proxies at browser and context level
- Residential proxies important for IP reputation
- Auto-match timezone/locale/geolocation to proxy IP location

## Alternatives Evaluated

| Option | Verdict |
|--------|---------|
| Official Playwright MCP (Microsoft, 28.5k stars) | 70+ tools, well-architected, but no iframe tools, too large to fork |
| Community Playwright MCP (executeautomation, 5.3k stars) | Already has iframe tools, small codebase (~25 tools), **chosen as fork base** |
| Fork chrome-devtools-mcp | Possible but harder — iframe plumbing complex, stuck with Chrome only |
| Scrapling | Wrong tool — scraper not interactive browser controller. But its stealth technique (Patchright) is useful |
| rebrowser-playwright | Alternative to Patchright — npm alias trick (zero code changes), but less aggressive patches |

## Key npm Packages

| Package | Purpose |
|---------|---------|
| `patchright` | Stealth Playwright fork (Chromium only) |
| `fingerprint-generator` | Generate realistic device fingerprints |
| `fingerprint-injector` | Inject fingerprints into Playwright contexts |
| `header-generator` | Generate matching HTTP headers |
| `ghost-cursor-playwright` | Human-like Bezier curve mouse movements |
