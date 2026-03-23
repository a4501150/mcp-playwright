/**
 * StealthManager: Fingerprint generation, injection, and anti-detect configuration.
 *
 * Uses Apify's fingerprint-suite to generate realistic, internally-consistent
 * browser fingerprints and inject them into Playwright contexts.
 */

import type { BrowserContext } from 'playwright';
import { FingerprintGenerator } from 'fingerprint-generator';
import { FingerprintInjector } from 'fingerprint-injector';
import { HeaderGenerator } from 'header-generator';

export interface StealthConfig {
  /** Target OS: 'windows' | 'macos' | 'linux' (default: current platform) */
  os?: string;
  /** Target browser for fingerprint: 'chrome' | 'firefox' | 'safari' (auto-detected from browserType) */
  browser?: string;
  /** Target device: 'desktop' | 'mobile' (default: 'desktop') */
  device?: string;
  /** Locale (default: 'en-US') */
  locale?: string;
}

export class StealthManager {
  private config: StealthConfig;
  private fingerprintGenerator: FingerprintGenerator;
  private fingerprintInjector: FingerprintInjector;
  private headerGenerator: HeaderGenerator;
  private currentFingerprint: any;

  constructor(config?: StealthConfig) {
    this.config = config ?? {};
    this.fingerprintGenerator = new FingerprintGenerator();
    this.fingerprintInjector = new FingerprintInjector();
    this.headerGenerator = new HeaderGenerator();
  }

  /**
   * Map our browserType to fingerprint-generator browser names
   */
  private mapBrowser(browserType: string): string {
    switch (browserType) {
      case 'firefox': return 'firefox';
      case 'webkit': return 'safari';
      case 'chromium':
      default: return 'chrome';
    }
  }

  /**
   * Detect current OS for fingerprint consistency
   */
  private detectOS(): string {
    if (this.config.os) return this.config.os;
    switch (process.platform) {
      case 'darwin': return 'macos';
      case 'win32': return 'windows';
      default: return 'linux';
    }
  }

  /**
   * Generate a fingerprint matching the target browser/OS profile
   */
  generateFingerprint(browserType: string): any {
    const browser = this.config.browser || this.mapBrowser(browserType);
    const os = this.detectOS();
    const device = this.config.device || 'desktop';

    this.currentFingerprint = this.fingerprintGenerator.getFingerprint({
      browsers: [browser as any],
      operatingSystems: [os as any],
      devices: [device as any],
    });

    return this.currentFingerprint;
  }

  /**
   * Build Playwright context options from the generated fingerprint.
   * Called before context creation.
   */
  buildContextOptions(browserType: string): Record<string, any> {
    const fp = this.generateFingerprint(browserType);
    const options: Record<string, any> = {};

    if (fp.fingerprint) {
      const { screen, navigator: nav } = fp.fingerprint;

      // Viewport from fingerprint
      if (screen?.width && screen?.height) {
        options.viewport = {
          width: Math.min(screen.width, 1920),
          height: Math.min(screen.height, 1080),
        };
      }

      // User agent
      if (nav?.userAgent) {
        options.userAgent = nav.userAgent;
      }

      // Locale
      if (nav?.language) {
        options.locale = nav.language;
      }
    }

    // Generate matching headers
    try {
      const headers = this.headerGenerator.getHeaders({
        browsers: [this.mapBrowser(browserType) as any],
        operatingSystems: [this.detectOS() as any],
      });
      if (headers) {
        options.extraHTTPHeaders = {
          ...headers,
        };
        // Remove headers Playwright sets automatically
        delete options.extraHTTPHeaders['user-agent'];
        delete options.extraHTTPHeaders['User-Agent'];
      }
    } catch {
      // Header generation is best-effort
    }

    // Timezone / locale consistency
    options.locale = options.locale || this.config.locale || 'en-US';
    options.timezoneId = options.timezoneId || Intl.DateTimeFormat().resolvedOptions().timeZone;

    return options;
  }

  /**
   * Inject the generated fingerprint into an existing Playwright context.
   * Called after context creation.
   */
  async injectFingerprint(context: BrowserContext): Promise<void> {
    if (!this.currentFingerprint) return;

    try {
      await this.fingerprintInjector.attachFingerprintToPlaywright(
        context,
        this.currentFingerprint
      );
    } catch (error) {
      // Fingerprint injection is best-effort — don't crash if it fails
      console.error(`[StealthManager] Fingerprint injection failed: ${(error as Error).message}`);
    }
  }

  /**
   * Get the current fingerprint (for debugging/verification)
   */
  getCurrentFingerprint(): any {
    return this.currentFingerprint;
  }
}
