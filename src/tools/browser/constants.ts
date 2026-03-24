/**
 * Stealth constants for anti-bot detection.
 * Ported from Scrapling's stealth implementation.
 */

/** Chromium flags that should never be used — they enable automation detection */
export const HARMFUL_ARGS = [
  '--enable-automation',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-component-update',
  '--disable-popup-blocking',
  '--remote-debugging-pipe',
];

/**
 * Stealth Chromium launch arguments.
 * These reduce the browser's fingerprint surface and disable telemetry.
 */
export const STEALTH_CHROMIUM_ARGS = [
  // Core anti-detect
  '--disable-blink-features=AutomationControlled',

  // Canvas fingerprint noise
  '--fingerprinting-canvas-image-data-noise',
  '--fingerprinting-canvas-measuretext-noise',
  '--fingerprinting-client-rects-noise',

  // WebRTC leak prevention
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--force-webrtc-ip-handling-policy',
  '--enforce-webrtc-ip-permission-check',

  // Disable telemetry and background services
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-crash-reporter',
  '--disable-dev-shm-usage',
  '--disable-domain-reliability',
  '--disable-features=TranslateUI',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-renderer-backgrounding',
  '--disable-sync',

  // Disable features that leak automation signals
  '--disable-features=AutofillServerCommunication',
  '--disable-features=CertificateTransparencyComponentUpdater',
  '--disable-features=OptimizationHints',
  '--disable-features=MediaRouter',
  '--disable-features=DialMediaRouteProvider',
  '--disable-features=CalculateNativeWinOcclusion',

  // Network & security
  '--no-first-run',
  '--no-service-autorun',
  '--no-default-browser-check',
  '--password-store=basic',
  '--use-mock-keychain',

  // GPU/rendering (reduce fingerprint surface)
  '--disable-gpu-sandbox',

  // Misc
  '--metrics-recording-only',
  '--no-pings',
  '--disable-infobars',
  '--lang=en-US',
];

/** Fallback viewport when explicit dimensions are provided but incomplete */
export const DEFAULT_VIEWPORT = {
  width: 1440,
  height: 900,
};
