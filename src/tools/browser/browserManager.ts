/**
 * BrowserManager: Centralized browser lifecycle management with configurable backend.
 *
 * Supports two backends:
 * - "playwright" (default): Standard Playwright for Firefox/WebKit/Chromium
 * - "patchright": Patched Playwright fork for stealth Chromium (suppresses Runtime.Enable)
 *
 * Stealth layers are applied based on config:
 * - Chromium flags (~60 anti-detect args)
 * - Fingerprint generation & injection (Apify fingerprint-suite)
 * - Human-like interaction helpers (exposed for tool use)
 */

import type { Browser, Page, BrowserContext, BrowserType } from 'playwright';
import { spawn } from 'child_process';
import { STEALTH_CHROMIUM_ARGS, HARMFUL_ARGS, STEALTH_VIEWPORT, DEFAULT_VIEWPORT } from './constants.js';
import { StealthManager, type StealthConfig } from './stealth.js';
import { NetworkCapture } from './network.js';
import { DockerManager } from './dockerManager.js';

export interface BrowserManagerConfig {
  /** Backend: "playwright" (default) or "patchright" (stealth Chromium) */
  backend: 'playwright' | 'patchright';
  /** Browser type: "firefox" (default), "chromium", "webkit" */
  browserType: 'firefox' | 'chromium' | 'webkit';
  /** Enable stealth mode (default: true) */
  stealth: boolean;
  /** Run headless (default: false) */
  headless: boolean;
  /** Proxy server URL */
  proxy?: string;
  /** Proxy username */
  proxyUsername?: string;
  /** Proxy password */
  proxyPassword?: string;
  /** Fingerprint config */
  fingerprint?: StealthConfig;
  /** Enable human-like interaction by default (default: true when stealth=true) */
  humanize: boolean;
  /** Run browser in Docker with Xvfb (headless that passes all bot detection) */
  dockerMode: boolean;
}

const DEFAULT_CONFIG: BrowserManagerConfig = {
  backend: 'playwright',
  browserType: 'firefox',
  stealth: true,
  headless: false,
  humanize: true,
  dockerMode: false,
};

/** Singleton BrowserManager */
let instance: BrowserManager | undefined;

export class BrowserManager {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private context: BrowserContext | undefined;
  private config: BrowserManagerConfig;
  private stealthManager: StealthManager;
  private networkCapture: NetworkCapture;
  private consoleRegisterFn?: (page: Page) => Promise<void>;
  private dockerManager: DockerManager | undefined;

  constructor(config: Partial<BrowserManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Patchright only supports Chromium
    if (this.config.backend === 'patchright' && this.config.browserType !== 'chromium') {
      console.error(`[BrowserManager] Patchright only supports Chromium. Forcing browserType=chromium (was: ${this.config.browserType})`);
      this.config.browserType = 'chromium';
    }

    this.stealthManager = new StealthManager(this.config.fingerprint);
    this.networkCapture = new NetworkCapture();
  }

  static getInstance(config?: Partial<BrowserManagerConfig>): BrowserManager {
    if (!instance) {
      instance = new BrowserManager(config);
    }
    return instance;
  }

  static resetInstance(): void {
    instance = undefined;
  }

  getConfig(): BrowserManagerConfig {
    return { ...this.config };
  }

  getNetworkCapture(): NetworkCapture {
    return this.networkCapture;
  }

  /**
   * Set the console registration function (called by toolHandler for backward compat)
   */
  setConsoleRegisterFn(fn: (page: Page) => Promise<void>): void {
    this.consoleRegisterFn = fn;
  }

  /**
   * Dynamically import the browser launcher based on backend config
   */
  private async getBrowserType(): Promise<BrowserType> {
    const { backend, browserType } = this.config;

    if (backend === 'patchright') {
      const patchright = await import('patchright');
      return patchright.chromium as unknown as BrowserType;
    }

    const playwright = await import('playwright');
    switch (browserType) {
      case 'firefox':
        return playwright.firefox;
      case 'webkit':
        return playwright.webkit;
      case 'chromium':
      default:
        return playwright.chromium;
    }
  }

  /**
   * Build launch arguments based on stealth config
   */
  private buildLaunchArgs(): string[] {
    const args: string[] = [];

    if (this.config.stealth && this.config.browserType === 'chromium') {
      args.push(...STEALTH_CHROMIUM_ARGS);
    }

    // Filter out harmful args that may be inherited
    return args.filter(arg => !HARMFUL_ARGS.some(harmful => arg.startsWith(harmful)));
  }

  /**
   * Build proxy config for Playwright
   */
  private buildProxyConfig(): { server: string; username?: string; password?: string } | undefined {
    if (!this.config.proxy) return undefined;
    return {
      server: this.config.proxy,
      ...(this.config.proxyUsername && { username: this.config.proxyUsername }),
      ...(this.config.proxyPassword && { password: this.config.proxyPassword }),
    };
  }

  /**
   * Install browser if not found
   */
  private async installBrowser(): Promise<{ success: boolean; message: string }> {
    const browserType = this.config.browserType;
    const cmd = this.config.backend === 'patchright' ? 'patchright' : 'playwright';

    return new Promise((resolve) => {
      console.error(`[BrowserManager] Installing ${browserType} via ${cmd}...`);
      const installProcess = spawn('npx', [cmd, 'install', browserType], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let errorOutput = '';
      installProcess.stderr?.on('data', (data) => { errorOutput += data.toString(); });

      installProcess.on('close', (code) => {
        if (code === 0) {
          console.error(`[BrowserManager] Successfully installed ${browserType}`);
          resolve({ success: true, message: `Installed ${browserType}` });
        } else {
          console.error(`[BrowserManager] Install failed: ${errorOutput}`);
          resolve({ success: false, message: `Failed to install ${browserType}. Run: npx ${cmd} install ${browserType}` });
        }
      });

      installProcess.on('error', (error) => {
        resolve({ success: false, message: `Install error: ${error.message}` });
      });

      setTimeout(() => {
        installProcess.kill();
        resolve({ success: false, message: 'Install timed out' });
      }, 120000);
    });
  }

  /**
   * Ensure browser is launched and return the page.
   * This is the main entry point called by toolHandler.
   */
  async ensureBrowser(overrides?: {
    viewport?: { width?: number; height?: number };
    userAgent?: string;
    headless?: boolean;
    browserType?: 'chromium' | 'firefox' | 'webkit';
  }): Promise<Page> {
    // Check if browser exists but is disconnected
    if (this.browser && !this.browser.isConnected()) {
      await this.browser.close().catch(() => {});
      this.reset();
    }

    // Launch new browser if needed
    if (!this.browser) {
      await this.launch(overrides);
    }

    // Verify page is still valid
    if (!this.page || this.page.isClosed()) {
      const ctx = this.browser!.contexts()[0] || await this.browser!.newContext();
      this.page = await ctx.newPage();
      this.networkCapture.attachToPage(this.page);
      if (this.consoleRegisterFn) {
        await this.consoleRegisterFn(this.page);
      }
    }

    return this.page!;
  }

  /**
   * Launch browser with stealth config applied.
   * In docker mode, starts a Docker container and connects via WebSocket.
   */
  private async launch(overrides?: {
    viewport?: { width?: number; height?: number };
    userAgent?: string;
    headless?: boolean;
    browserType?: 'chromium' | 'firefox' | 'webkit';
  }): Promise<void> {
    if (this.config.dockerMode) {
      await this.launchDocker(overrides);
    } else {
      await this.launchLocal(overrides);
    }
  }

  /**
   * Launch browser via Docker container with Xvfb.
   * Connects to the containerized browser server over WebSocket.
   */
  private async launchDocker(overrides?: {
    viewport?: { width?: number; height?: number };
    userAgent?: string;
  }): Promise<void> {
    this.dockerManager = new DockerManager();
    const wsEndpoint = await this.dockerManager.start(this.config.browserType);

    // Connect to the remote browser via WebSocket using standard playwright
    // (patchright is irrelevant in docker mode — the browser runs headed inside Xvfb)
    const playwright = await import('playwright');
    const browserType = this.config.browserType === 'webkit'
      ? playwright.webkit
      : this.config.browserType === 'firefox'
        ? playwright.firefox
        : playwright.chromium;

    this.browser = await browserType.connect(wsEndpoint);
    this.browser.on('disconnected', () => this.reset());

    // Create context with stealth fingerprint if enabled
    const viewport = this.config.stealth
      ? STEALTH_VIEWPORT
      : {
          width: overrides?.viewport?.width ?? DEFAULT_VIEWPORT.width,
          height: overrides?.viewport?.height ?? DEFAULT_VIEWPORT.height,
        };

    const contextOptions: Record<string, any> = {
      viewport,
      deviceScaleFactor: 1,
      ...(overrides?.userAgent && { userAgent: overrides.userAgent }),
    };

    if (this.config.stealth) {
      const fpOptions = this.stealthManager.buildContextOptions(this.config.browserType);
      Object.assign(contextOptions, fpOptions);
    }

    this.context = await this.browser.newContext(contextOptions);

    if (this.config.stealth) {
      await this.stealthManager.injectFingerprint(this.context);
    }

    this.page = await this.context.newPage();
    this.networkCapture.attachToPage(this.page);

    if (this.consoleRegisterFn) {
      await this.consoleRegisterFn(this.page);
    }
  }

  /**
   * Launch browser locally (original path).
   */
  private async launchLocal(overrides?: {
    viewport?: { width?: number; height?: number };
    userAgent?: string;
    headless?: boolean;
    browserType?: 'chromium' | 'firefox' | 'webkit';
  }): Promise<void> {
    const browserType = await this.getBrowserType();
    const headless = overrides?.headless ?? this.config.headless;
    const executablePath = process.env.CHROME_EXECUTABLE_PATH || undefined;
    const args = this.buildLaunchArgs();
    const proxy = this.buildProxyConfig();

    const launchOptions: Record<string, any> = {
      headless,
      ...(args.length > 0 && { args }),
      ...(proxy && { proxy }),
      ...(executablePath && this.config.browserType === 'chromium' && { executablePath }),
    };

    try {
      this.browser = await browserType.launch(launchOptions);
    } catch (launchError: any) {
      if (
        launchError.message?.includes("Executable doesn't exist") ||
        launchError.message?.includes("Failed to launch") ||
        launchError.message?.includes("browserType.launch")
      ) {
        const result = await this.installBrowser();
        if (result.success) {
          this.browser = await browserType.launch(launchOptions);
        } else {
          throw new Error(result.message);
        }
      } else {
        throw launchError;
      }
    }

    this.browser!.on('disconnected', () => this.reset());

    // Create context with stealth fingerprint if enabled
    const viewport = this.config.stealth
      ? STEALTH_VIEWPORT
      : {
          width: overrides?.viewport?.width ?? DEFAULT_VIEWPORT.width,
          height: overrides?.viewport?.height ?? DEFAULT_VIEWPORT.height,
        };

    const contextOptions: Record<string, any> = {
      viewport,
      deviceScaleFactor: 1,
      ...(overrides?.userAgent && { userAgent: overrides.userAgent }),
    };

    // Apply fingerprint if stealth is enabled
    if (this.config.stealth) {
      const fpOptions = this.stealthManager.buildContextOptions(this.config.browserType);
      Object.assign(contextOptions, fpOptions);
    }

    this.context = await this.browser!.newContext(contextOptions);

    // Inject fingerprint into context if stealth
    if (this.config.stealth) {
      await this.stealthManager.injectFingerprint(this.context);
    }

    this.page = await this.context.newPage();

    // Attach network capture
    this.networkCapture.attachToPage(this.page);

    // Register console messages (backward compat)
    if (this.consoleRegisterFn) {
      await this.consoleRegisterFn(this.page);
    }
  }

  getBrowser(): Browser | undefined {
    return this.browser;
  }

  getPage(): Page | undefined {
    return this.page;
  }

  setPage(newPage: Page): void {
    this.page = newPage;
    this.page.bringToFront();
    this.networkCapture.attachToPage(newPage);
  }

  reset(): void {
    this.browser = undefined;
    this.page = undefined;
    this.context = undefined;
    this.networkCapture.clear();
  }

  async close(): Promise<void> {
    if (this.browser?.isConnected()) {
      await this.browser.close().catch(() => {});
    }
    if (this.dockerManager) {
      await this.dockerManager.stop();
      this.dockerManager = undefined;
    }
    this.reset();
  }

  isPatchright(): boolean {
    return this.config.backend === 'patchright';
  }
}
