#!/bin/bash
set -e

BROWSER="${BROWSER:-chromium}"

# Run browser server inside Xvfb virtual display.
# Output is redirected to files because xvfb-run heavily buffers stdout/stderr.
# The host discovers the WS URL by polling /shared/ws-url.
xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
  node -e "
const pw = require('playwright-core');
const fs = require('fs');
(async () => {
  const browser = '${BROWSER}';
  try {
    const server = await pw[browser].launchServer({
      port: 3000,
      host: '0.0.0.0',
      headless: false,
      args: browser === 'chromium' ? ['--disable-blink-features=AutomationControlled'] : [],
    });
    const ws = server.wsEndpoint();
    // Write to shared volume for host discovery
    try { fs.writeFileSync('/shared/ws-url', ws); } catch(e) {}
    // Keep process alive
  } catch(e) {
    // Write error to shared volume for host diagnostics
    try { fs.writeFileSync('/shared/error', e.message + '\n' + e.stack); } catch(e2) {}
    process.exit(1);
  }
})();
"
