/**
 * BrowserManager: Centralized browser lifecycle management with configurable backend.
 *
 * Supports three backends:
 * - "camoufox" (default): Anti-detect Firefox fork with C++-level fingerprint spoofing
 * - "playwright": Standard Playwright for Firefox/WebKit/Chromium
 * - "patchright": Patched Playwright fork for stealth Chromium (suppresses Runtime.Enable)
 *
 * Stealth layers are applied based on config:
 * - Camoufox: C++-level fingerprint spoofing (no JS injection needed)
 * - Chromium flags (~60 anti-detect args)
 * - Fingerprint generation & injection (Apify fingerprint-suite, disabled for camoufox)
 * - Human-like interaction helpers (exposed for tool use)
 */

import type { Browser, Page, BrowserContext, BrowserType } from 'playwright';
import { spawn } from 'child_process';
import { STEALTH_CHROMIUM_ARGS, HARMFUL_ARGS, STEALTH_VIEWPORT, DEFAULT_VIEWPORT } from './constants.js';
import { StealthManager, type StealthConfig } from './stealth.js';
import { NetworkCapture } from './network.js';
import { DockerManager } from './dockerManager.js';

export interface BrowserManagerConfig {
  /** Backend: "camoufox" (default, anti-detect Firefox), "playwright", or "patchright" (stealth Chromium) */
  backend: 'playwright' | 'patchright' | 'camoufox';
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
  backend: 'camoufox',
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

  // Isolated context support
  private contexts: Map<string, BrowserContext> = new Map();
  private pages: Array<{ page: Page; contextName: string }> = [];
  private activePageIndex: number = -1;

  constructor(config: Partial<BrowserManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Patchright only supports Chromium
    if (this.config.backend === 'patchright' && this.config.browserType !== 'chromium') {
      console.error(`[BrowserManager] Patchright only supports Chromium. Forcing browserType=chromium (was: ${this.config.browserType})`);
      this.config.browserType = 'chromium';
    }

    // Camoufox only supports Firefox
    if (this.config.backend === 'camoufox' && this.config.browserType !== 'firefox') {
      console.error(`[BrowserManager] Camoufox only supports Firefox. Forcing browserType=firefox (was: ${this.config.browserType})`);
      this.config.browserType = 'firefox';
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

    if (backend === 'camoufox') {
      const playwright = await import('playwright');
      return playwright.firefox;
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
   * Build launch options for Camoufox backend.
   * Uses camoufox-js to get Playwright-compatible options (executablePath, args, env, etc.)
   */
  private async buildCamoufoxLaunchOptions(headless: boolean): Promise<Record<string, any>> {
    const { launchOptions } = await import('camoufox-js');
    const proxy = this.buildProxyConfig();

    const camoufoxOpts: Record<string, any> = {
      headless,
    };

    if (proxy) {
      camoufoxOpts.proxy = proxy;
    }

    return await launchOptions(camoufoxOpts);
  }

  /**
   * Install browser if not found
   */
  private async installBrowser(): Promise<{ success: boolean; message: string }> {
    if (this.config.backend === 'camoufox') {
      return new Promise((resolve) => {
        console.error(`[BrowserManager] Fetching Camoufox browser binary...`);
        const installProcess = spawn('npx', ['camoufox-js', 'fetch'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let errorOutput = '';
        installProcess.stderr?.on('data', (data) => { errorOutput += data.toString(); });

        installProcess.on('close', (code) => {
          if (code === 0) {
            console.error(`[BrowserManager] Successfully fetched Camoufox binary`);
            resolve({ success: true, message: `Fetched Camoufox binary` });
          } else {
            console.error(`[BrowserManager] Camoufox fetch failed: ${errorOutput}`);
            resolve({ success: false, message: `Failed to fetch Camoufox binary. Run: npx camoufox-js fetch` });
          }
        });

        installProcess.on('error', (error) => {
          resolve({ success: false, message: `Install error: ${error.message}` });
        });

        setTimeout(() => {
          installProcess.kill();
          resolve({ success: false, message: 'Camoufox fetch timed out' });
        }, 300000);
      });
    }

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
   *
   * When isolatedContext is provided, creates or reuses a named BrowserContext
   * with separate cookies/storage. Each context gets its own stealth fingerprint.
   */
  async ensureBrowser(overrides?: {
    viewport?: { width?: number; height?: number };
    userAgent?: string;
    headless?: boolean;
    browserType?: 'chromium' | 'firefox' | 'webkit';
    isolatedContext?: string;
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

    // Handle isolated context request
    if (overrides?.isolatedContext) {
      const name = overrides.isolatedContext;
      let ctx = this.contexts.get(name);

      if (!ctx) {
        // Create a new isolated context with its own stealth fingerprint
        ctx = await this.createContextWithStealth(overrides);
        this.contexts.set(name, ctx);
      }

      // Check if we already have a non-closed page in this context
      const existingEntry = this.pages.find(
        (entry) => entry.contextName === name && !entry.page.isClosed()
      );
      if (existingEntry) {
        // Switch to the existing page
        const idx = this.pages.indexOf(existingEntry);
        this.activePageIndex = idx;
        this.page = existingEntry.page;
        await this.page.bringToFront();
        this.networkCapture.attachToPage(this.page);
        return this.page;
      }

      // Create a new page in the isolated context
      return await this.createPageInContext(ctx, name);
    }

    // Default path: no isolated context
    if (!this.page || this.page.isClosed()) {
      // Create default context if it doesn't exist yet
      if (!this.context) {
        this.context = await this.createContextWithStealth(overrides);
      }
      await this.createPageInContext(this.context, 'default');
    }

    return this.page!;
  }

  /**
   * Create a new BrowserContext with stealth fingerprint applied.
   * Reusable helper for both initial launch and isolated context creation.
   */
  private async createContextWithStealth(overrides?: {
    viewport?: { width?: number; height?: number };
    userAgent?: string;
  }): Promise<BrowserContext> {
    const isCamoufox = this.config.backend === 'camoufox';

    // Camoufox handles its own fingerprinting at C++ level; skip JS-level stealth
    const applyJsStealth = this.config.stealth && !isCamoufox;

    const viewport = applyJsStealth
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

    if (applyJsStealth) {
      const fpOptions = this.stealthManager.buildContextOptions(this.config.browserType);
      Object.assign(contextOptions, fpOptions);
    }

    const context = await this.browser!.newContext(contextOptions);

    if (applyJsStealth) {
      await this.stealthManager.injectFingerprint(context);
    }

    return context;
  }

  /**
   * Create a new page in a context and set it as active.
   */
  private async createPageInContext(context: BrowserContext, contextName: string): Promise<Page> {
    const page = await context.newPage();
    this.networkCapture.attachToPage(page);
    if (this.consoleRegisterFn) {
      await this.consoleRegisterFn(page);
    }
    this.pages.push({ page, contextName });
    this.activePageIndex = this.pages.length - 1;
    this.page = page;
    return page;
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
    if (this.config.dockerMode && this.config.backend === 'camoufox') {
      throw new Error('Camoufox backend does not support headless-docker mode. Use --headless instead, or switch to --backend playwright.');
    }
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

    const playwright = await import('playwright');
    const browserType = this.config.browserType === 'webkit'
      ? playwright.webkit
      : this.config.browserType === 'firefox'
        ? playwright.firefox
        : playwright.chromium;

    this.browser = await browserType.connect(wsEndpoint);
    this.browser.on('disconnected', () => this.reset());
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

    if (this.config.backend === 'camoufox') {
      try {
        const camoufoxOptions = await this.buildCamoufoxLaunchOptions(headless);
        this.browser = await browserType.launch(camoufoxOptions);
      } catch (launchError: any) {
        if (
          launchError.message?.includes("Executable doesn't exist") ||
          launchError.message?.includes("Failed to launch") ||
          launchError.message?.includes("browserType.launch") ||
          launchError.message?.includes("spawn")
        ) {
          const result = await this.installBrowser();
          if (result.success) {
            const camoufoxOptions = await this.buildCamoufoxLaunchOptions(headless);
            this.browser = await browserType.launch(camoufoxOptions);
          } else {
            throw new Error(result.message);
          }
        } else {
          throw launchError;
        }
      }
      this.browser!.on('disconnected', () => this.reset());
      return;
    }

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

    // Track the page if not already tracked (e.g. from ClickAndSwitchTabTool)
    const alreadyTracked = this.pages.some((entry) => entry.page === newPage);
    if (!alreadyTracked) {
      this.pages.push({ page: newPage, contextName: 'default' });
      this.activePageIndex = this.pages.length - 1;
    }
  }

  /**
   * Get info about all tracked pages (compacts out closed pages).
   */
  getPages(): Array<{ index: number; url: string; contextName: string; isActive: boolean }> {
    // Compact: remove closed pages
    this.pages = this.pages.filter((entry) => !entry.page.isClosed());
    // Fix activePageIndex after compaction
    if (this.page) {
      this.activePageIndex = this.pages.findIndex((entry) => entry.page === this.page);
    }
    return this.pages.map((entry, idx) => ({
      index: idx,
      url: entry.page.url(),
      contextName: entry.contextName,
      isActive: idx === this.activePageIndex,
    }));
  }

  /**
   * Switch the active page by index.
   */
  async switchToPage(index: number): Promise<Page> {
    // Compact closed pages first
    this.pages = this.pages.filter((entry) => !entry.page.isClosed());

    if (index < 0 || index >= this.pages.length) {
      throw new Error(`Invalid page index ${index}. Available: 0-${this.pages.length - 1}`);
    }

    const entry = this.pages[index];
    this.activePageIndex = index;
    this.page = entry.page;
    await this.page.bringToFront();
    this.networkCapture.attachToPage(this.page);
    if (this.consoleRegisterFn) {
      await this.consoleRegisterFn(this.page);
    }
    return this.page;
  }

  reset(): void {
    this.browser = undefined;
    this.page = undefined;
    this.context = undefined;
    this.contexts.clear();
    this.pages = [];
    this.activePageIndex = -1;
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

  isCamoufox(): boolean {
    return this.config.backend === 'camoufox';
  }
}
