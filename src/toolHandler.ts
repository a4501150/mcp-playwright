import type { Page } from 'playwright';
import { request } from 'playwright';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BROWSER_TOOLS, API_TOOLS } from './tools.js';
import type { ToolContext } from './tools/common/types.js';
import { ActionRecorder } from './tools/codegen/recorder.js';
import {
  startCodegenSession,
  endCodegenSession,
  getCodegenSession,
  clearCodegenSession
} from './tools/codegen/index.js';
import {
  ScreenshotTool,
  NavigationTool,
  CloseBrowserTool,
  ConsoleLogsTool,
  ExpectResponseTool,
  AssertResponseTool,
  CustomUserAgentTool,
  ResizeTool
} from './tools/browser/index.js';
import {
  ClickTool,
  IframeClickTool,
  FillTool,
  SelectTool,
  HoverTool,
  EvaluateTool,
  IframeFillTool,
  IframeEvaluateTool,
  UploadFileTool,
  WaitForTool
} from './tools/browser/interaction.js';
import {
  VisibleTextTool,
  VisibleHtmlTool
} from './tools/browser/visiblePage.js';
import {
  GetRequestTool,
  PostRequestTool,
  PutRequestTool,
  PatchRequestTool,
  DeleteRequestTool
} from './tools/api/requests.js';
import { GoBackTool, GoForwardTool } from './tools/browser/navigation.js';
import { DragTool, PressKeyTool } from './tools/browser/interaction.js';
import { SaveAsPdfTool } from './tools/browser/output.js';
import { ClickAndSwitchTabTool } from './tools/browser/interaction.js';
import { BrowserManager, type BrowserManagerConfig } from './tools/browser/browserManager.js';
import { NetworkRequestsTool, GetNetworkRequestTool, NetworkConfigTool, DumpNetworkTool } from './tools/browser/network.js';
import { SnapshotTool } from './tools/browser/snapshot.js';
import { StartTracingTool, StopTracingTool } from './tools/browser/performance.js';

// BrowserManager instance (replaces old global browser/page state)
let browserManager: BrowserManager | undefined;

/** Global config set from CLI args */
let globalConfig: Partial<BrowserManagerConfig> = {};

/**
 * Set the global BrowserManager config (called from CLI arg parsing)
 */
export function setGlobalBrowserConfig(config: Partial<BrowserManagerConfig>): void {
  globalConfig = config;
}

/**
 * Get or create the BrowserManager singleton
 */
function getBrowserManager(): BrowserManager {
  if (!browserManager) {
    browserManager = new BrowserManager(globalConfig);
    browserManager.setConsoleRegisterFn(registerConsoleMessage);
  }
  return browserManager;
}

/**
 * Resets browser and page variables
 */
export function resetBrowserState() {
  if (browserManager) {
    browserManager.reset();
  }
  browserManager = undefined;
  BrowserManager.resetInstance();
}

/**
 * Sets the provided page to the global page variable
 */
export function setGlobalPage(newPage: Page): void {
  getBrowserManager().setPage(newPage);
}

// Tool instances
let screenshotTool: ScreenshotTool;
let navigationTool: NavigationTool;
let closeBrowserTool: CloseBrowserTool;
let consoleLogsTool: ConsoleLogsTool;
let clickTool: ClickTool;
let iframeClickTool: IframeClickTool;
let iframeFillTool: IframeFillTool;
let iframeEvaluateTool: IframeEvaluateTool;
let fillTool: FillTool;
let selectTool: SelectTool;
let hoverTool: HoverTool;
let uploadFileTool: UploadFileTool;
let evaluateTool: EvaluateTool;
let expectResponseTool: ExpectResponseTool;
let assertResponseTool: AssertResponseTool;
let customUserAgentTool: CustomUserAgentTool;
let visibleTextTool: VisibleTextTool;
let visibleHtmlTool: VisibleHtmlTool;
let resizeTool: ResizeTool;

let getRequestTool: GetRequestTool;
let postRequestTool: PostRequestTool;
let putRequestTool: PutRequestTool;
let patchRequestTool: PatchRequestTool;
let deleteRequestTool: DeleteRequestTool;

let goBackTool: GoBackTool;
let goForwardTool: GoForwardTool;
let dragTool: DragTool;
let pressKeyTool: PressKeyTool;
let saveAsPdfTool: SaveAsPdfTool;
let clickAndSwitchTabTool: ClickAndSwitchTabTool;
let waitForTool: WaitForTool;

// New tools
let networkRequestsTool: NetworkRequestsTool;
let getNetworkRequestTool: GetNetworkRequestTool;
let networkConfigTool: NetworkConfigTool;
let dumpNetworkTool: DumpNetworkTool;
let snapshotTool: SnapshotTool;
let startTracingTool: StartTracingTool;
let stopTracingTool: StopTracingTool;

async function registerConsoleMessage(page: Page) {
  page.on("console", (msg) => {
    if (consoleLogsTool) {
      const type = msg.type();
      const text = msg.text();

      if (text.startsWith("[Playwright]")) {
        const payload = text.replace("[Playwright]", "");
        consoleLogsTool.registerConsoleMessage("exception", payload);
      } else {
        consoleLogsTool.registerConsoleMessage(type, text);
      }
    }
  });

  page.on("pageerror", (error) => {
    if (consoleLogsTool) {
      const message = error.message;
      const stack = error.stack || "";
      consoleLogsTool.registerConsoleMessage("exception", `${message}\n${stack}`);
    }
  });

  await page.addInitScript(() => {
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      const message = typeof reason === "object" && reason !== null
          ? reason.message || JSON.stringify(reason)
          : String(reason);
      const stack = reason?.stack || "";
      console.error(`[Playwright][Unhandled Rejection In Promise] ${message}\n${stack}`);
    });
  });
}

/**
 * Creates a new API request context
 */
async function ensureApiContext(url: string) {
  return await request.newContext({
    baseURL: url,
  });
}

/**
 * Initialize all tool instances
 */
function initializeTools(server: any) {
  const mgr = getBrowserManager();
  const networkCapture = mgr.getNetworkCapture();

  // Browser tools
  if (!screenshotTool) screenshotTool = new ScreenshotTool(server);
  if (!navigationTool) navigationTool = new NavigationTool(server);
  if (!closeBrowserTool) closeBrowserTool = new CloseBrowserTool(server);
  if (!consoleLogsTool) consoleLogsTool = new ConsoleLogsTool(server);
  if (!clickTool) clickTool = new ClickTool(server);
  if (!iframeClickTool) iframeClickTool = new IframeClickTool(server);
  if (!iframeFillTool) iframeFillTool = new IframeFillTool(server);
  if (!iframeEvaluateTool) iframeEvaluateTool = new IframeEvaluateTool(server);
  if (!fillTool) fillTool = new FillTool(server);
  if (!selectTool) selectTool = new SelectTool(server);
  if (!hoverTool) hoverTool = new HoverTool(server);
  if (!uploadFileTool) uploadFileTool = new UploadFileTool(server);
  if (!evaluateTool) evaluateTool = new EvaluateTool(server);
  if (!expectResponseTool) expectResponseTool = new ExpectResponseTool(server);
  if (!assertResponseTool) assertResponseTool = new AssertResponseTool(server);
  if (!customUserAgentTool) customUserAgentTool = new CustomUserAgentTool(server);
  if (!visibleTextTool) visibleTextTool = new VisibleTextTool(server);
  if (!visibleHtmlTool) visibleHtmlTool = new VisibleHtmlTool(server);
  if (!resizeTool) resizeTool = new ResizeTool(server);

  // API tools
  if (!getRequestTool) getRequestTool = new GetRequestTool(server);
  if (!postRequestTool) postRequestTool = new PostRequestTool(server);
  if (!putRequestTool) putRequestTool = new PutRequestTool(server);
  if (!patchRequestTool) patchRequestTool = new PatchRequestTool(server);
  if (!deleteRequestTool) deleteRequestTool = new DeleteRequestTool(server);

  // Existing tools
  if (!goBackTool) goBackTool = new GoBackTool(server);
  if (!goForwardTool) goForwardTool = new GoForwardTool(server);
  if (!dragTool) dragTool = new DragTool(server);
  if (!pressKeyTool) pressKeyTool = new PressKeyTool(server);
  if (!saveAsPdfTool) saveAsPdfTool = new SaveAsPdfTool(server);
  if (!clickAndSwitchTabTool) clickAndSwitchTabTool = new ClickAndSwitchTabTool(server);
  if (!waitForTool) waitForTool = new WaitForTool(server);

  // New tools
  if (!networkRequestsTool) networkRequestsTool = new NetworkRequestsTool(server, networkCapture);
  if (!getNetworkRequestTool) getNetworkRequestTool = new GetNetworkRequestTool(server, networkCapture);
  if (!networkConfigTool) networkConfigTool = new NetworkConfigTool(server, networkCapture);
  if (!dumpNetworkTool) dumpNetworkTool = new DumpNetworkTool(server, networkCapture);
  if (!snapshotTool) snapshotTool = new SnapshotTool(server);
  if (!startTracingTool) startTracingTool = new StartTracingTool(server);
  if (!stopTracingTool) stopTracingTool = new StopTracingTool(server);
}

/**
 * Main handler for tool calls
 */
export async function handleToolCall(
  name: string,
  args: any,
  server: any
): Promise<CallToolResult> {
  initializeTools(server);

  try {
    // Handle codegen tools
    switch (name) {
      case 'start_codegen_session':
        return await handleCodegenResult(startCodegenSession.handler(args));
      case 'end_codegen_session':
        return await handleCodegenResult(endCodegenSession.handler(args));
      case 'get_codegen_session':
        return await handleCodegenResult(getCodegenSession.handler(args));
      case 'clear_codegen_session':
        return await handleCodegenResult(clearCodegenSession.handler(args));
    }

    // Record tool action if there's an active session
    const recorder = ActionRecorder.getInstance();
    const activeSession = recorder.getActiveSession();
    if (activeSession && name !== 'playwright_close') {
      recorder.recordAction(name, args);
    }

    const mgr = getBrowserManager();

    // Special case for browser close
    if (name === "playwright_close") {
      await mgr.close();
      return {
        content: [{ type: "text", text: "Browser closed successfully" }],
        isError: false,
      };
    }

    // Special case for runtime mode switch
    if (name === "playwright_set_browser_mode") {
      const { mode, browser, backend } = args;

      // Update global config based on mode
      if (mode === "headed") {
        globalConfig.headless = false;
        globalConfig.dockerMode = false;
      } else if (mode === "headless") {
        globalConfig.headless = true;
        globalConfig.dockerMode = false;
      } else if (mode === "headless-docker") {
        globalConfig.headless = false;
        globalConfig.dockerMode = true;
      }

      if (backend) {
        globalConfig.backend = backend;
        // Force correct browser type for backend
        if (backend === 'patchright') {
          globalConfig.browserType = 'chromium';
        }
      }

      if (browser) {
        globalConfig.browserType = browser;
      }

      // close() handles resource cleanup (disconnect WS, stop Docker container)
      // resetBrowserState() destroys the singleton so next tool call creates a fresh one
      await mgr.close();
      resetBrowserState();

      const backendStr = backend || globalConfig.backend || "playwright";
      const browserStr = browser || globalConfig.browserType || "firefox";
      return {
        content: [{ type: "text", text: `Browser mode set to '${mode}' with ${backendStr}/${browserStr}. Next browser action will launch with new settings.` }],
        isError: false,
      };
    }

    // Special case for listing pages (no browser launch needed)
    if (name === "playwright_list_pages") {
      const pages = mgr.getPages();
      const text = pages.length === 0
        ? "No pages open."
        : pages.map(p =>
            `[${p.index}] ${p.url} (context: ${p.contextName})${p.isActive ? " *active*" : ""}`
          ).join("\n");
      return {
        content: [{ type: "text", text }],
        isError: false,
      };
    }

    // Special case for switching active page
    if (name === "playwright_select_page") {
      const page = await mgr.switchToPage(args.index);
      return {
        content: [{ type: "text", text: `Switched to page [${args.index}]: ${page.url()}` }],
        isError: false,
      };
    }

    // Network config tools (no browser launch needed)
    if (name === "playwright_network_config") {
      return await networkConfigTool.execute(args, { server });
    }
    if (name === "playwright_dump_network") {
      return await dumpNetworkTool.execute(args, { server });
    }

    // Check if we have a disconnected browser that needs cleanup
    const currentBrowser = mgr.getBrowser();
    if (currentBrowser && !currentBrowser.isConnected() && BROWSER_TOOLS.includes(name)) {
      mgr.reset();
    }

    // Prepare context
    const context: ToolContext = { server };

    // Set up browser if needed
    if (BROWSER_TOOLS.includes(name)) {
      try {
        context.page = await mgr.ensureBrowser({
          viewport: { width: args.width, height: args.height },
          userAgent: name === "playwright_custom_user_agent" ? args.userAgent : undefined,
          headless: args.headless,
          browserType: args.browserType,
          isolatedContext: args.isolatedContext,
        });
        context.browser = mgr.getBrowser();
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to initialize browser: ${(error as Error).message}. Please try again.` }],
          isError: true,
        };
      }
    }

    // Set up API context if needed
    if (API_TOOLS.includes(name)) {
      try {
        context.apiContext = await ensureApiContext(args.url);
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to initialize API context: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }

    // Route to appropriate tool
    switch (name) {
      // Browser tools
      case "playwright_navigate":
        return await navigationTool.execute(args, context);
      case "playwright_screenshot":
        return await screenshotTool.execute(args, context);
      case "playwright_resize":
        return await resizeTool.execute(args, context);
      case "playwright_close":
        return await closeBrowserTool.execute(args, context);
      case "playwright_console_logs":
        return await consoleLogsTool.execute(args, context);
      case "playwright_click":
        return await clickTool.execute(args, context);
      case "playwright_iframe_click":
        return await iframeClickTool.execute(args, context);
      case "playwright_iframe_fill":
        return await iframeFillTool.execute(args, context);
      case "playwright_iframe_evaluate":
        return await iframeEvaluateTool.execute(args, context);
      case "playwright_fill":
        return await fillTool.execute(args, context);
      case "playwright_select":
        return await selectTool.execute(args, context);
      case "playwright_hover":
        return await hoverTool.execute(args, context);
      case "playwright_upload_file":
        return await uploadFileTool.execute(args, context);
      case "playwright_evaluate":
        return await evaluateTool.execute(args, context);
      case "playwright_expect_response":
        return await expectResponseTool.execute(args, context);
      case "playwright_assert_response":
        return await assertResponseTool.execute(args, context);
      case "playwright_custom_user_agent":
        return await customUserAgentTool.execute(args, context);
      case "playwright_get_visible_text":
        return await visibleTextTool.execute(args, context);
      case "playwright_get_visible_html":
        return await visibleHtmlTool.execute(args, context);
      case "playwright_go_back":
        return await goBackTool.execute(args, context);
      case "playwright_go_forward":
        return await goForwardTool.execute(args, context);
      case "playwright_drag":
        return await dragTool.execute(args, context);
      case "playwright_press_key":
        return await pressKeyTool.execute(args, context);
      case "playwright_save_as_pdf":
        return await saveAsPdfTool.execute(args, context);
      case "playwright_click_and_switch_tab":
        return await clickAndSwitchTabTool.execute(args, context);
      case "playwright_wait_for":
        return await waitForTool.execute(args, context);

      // New tools
      case "playwright_snapshot":
        return await snapshotTool.execute(args, context);
      case "playwright_network_requests":
        return await networkRequestsTool.execute(args, context);
      case "playwright_get_network_request":
        return await getNetworkRequestTool.execute(args, context);
      case "playwright_start_trace":
        return await startTracingTool.execute(args, context);
      case "playwright_stop_trace":
        return await stopTracingTool.execute(args, context);

      // API tools
      case "playwright_get":
        return await getRequestTool.execute(args, context);
      case "playwright_post":
        return await postRequestTool.execute(args, context);
      case "playwright_put":
        return await putRequestTool.execute(args, context);
      case "playwright_patch":
        return await patchRequestTool.execute(args, context);
      case "playwright_delete":
        return await deleteRequestTool.execute(args, context);

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    if (BROWSER_TOOLS.includes(name)) {
      const errorMessage = (error as Error).message;
      if (
        errorMessage.includes("Target page, context or browser has been closed") ||
        errorMessage.includes("Browser has been disconnected") ||
        errorMessage.includes("Target closed") ||
        errorMessage.includes("Protocol error") ||
        errorMessage.includes("Connection closed")
      ) {
        resetBrowserState();
        return {
          content: [{ type: "text", text: `Browser connection error: ${errorMessage}. Browser state has been reset, please try again.` }],
          isError: true,
        };
      }
    }

    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

async function handleCodegenResult(resultPromise: Promise<any>): Promise<CallToolResult> {
  try {
    const result = await resultPromise;
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: false,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

export function getConsoleLogs(): string[] {
  return consoleLogsTool?.getConsoleLogs() ?? [];
}

export function getScreenshots(): Map<string, string> {
  return screenshotTool?.getScreenshots() ?? new Map();
}

export { registerConsoleMessage };
