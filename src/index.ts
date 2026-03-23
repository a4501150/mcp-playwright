#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createToolDefinitions } from "./tools.js";
import { setupRequestHandlers } from "./requestHandler.js";
import { Logger, RequestLoggingMiddleware } from "./logging/index.js";
import { MonitoringSystem } from "./monitoring/index.js";
import { startHttpServer } from "./http-server.js";
import { setGlobalBrowserConfig } from "./toolHandler.js";
import type { BrowserManagerConfig } from "./tools/browser/browserManager.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options: {
    port?: number;
    browserConfig: Partial<BrowserManagerConfig>;
  } = {
    browserConfig: {},
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--port':
        if (next) {
          options.port = parseInt(next, 10);
          if (isNaN(options.port) || options.port < 1 || options.port > 65535) {
            console.error('Error: --port must be a valid port number (1-65535)');
            process.exit(1);
          }
          i++;
        }
        break;

      case '--backend':
        if (next === 'patchright' || next === 'playwright') {
          options.browserConfig.backend = next;
          i++;
        } else {
          console.error('Error: --backend must be "patchright" or "playwright"');
          process.exit(1);
        }
        break;

      case '--browser':
        if (next === 'firefox' || next === 'chromium' || next === 'webkit') {
          options.browserConfig.browserType = next;
          i++;
        } else {
          console.error('Error: --browser must be "firefox", "chromium", or "webkit"');
          process.exit(1);
        }
        break;

      case '--stealth':
        options.browserConfig.stealth = next !== 'false';
        if (next === 'true' || next === 'false') i++;
        break;

      case '--no-stealth':
        options.browserConfig.stealth = false;
        break;

      case '--headless':
        options.browserConfig.headless = true;
        break;

      case '--humanize':
        options.browserConfig.humanize = next !== 'false';
        if (next === 'true' || next === 'false') i++;
        break;

      case '--no-humanize':
        options.browserConfig.humanize = false;
        break;

      case '--proxy':
        if (next) {
          options.browserConfig.proxy = next;
          i++;
        }
        break;

      case '--proxy-username':
        if (next) {
          options.browserConfig.proxyUsername = next;
          i++;
        }
        break;

      case '--proxy-password':
        if (next) {
          options.browserConfig.proxyPassword = next;
          i++;
        }
        break;

      case '--help':
      case '-h':
        console.error(`
Playwright MCP Server (Stealth Edition)

USAGE:
  playwright-mcp-server [OPTIONS]

OPTIONS:
  --port <number>         Run in HTTP mode on the specified port
  --backend <name>        Backend: "playwright" (default) or "patchright" (stealth Chromium)
  --browser <name>        Browser: "firefox" (default), "chromium", "webkit"
  --stealth / --no-stealth  Enable/disable stealth mode (default: enabled)
  --headless              Run browser in headless mode
  --humanize / --no-humanize  Enable/disable humanized interaction (default: enabled with stealth)
  --proxy <url>           Proxy server URL (e.g., http://proxy:8080 or socks5://proxy:1080)
  --proxy-username <user> Proxy authentication username
  --proxy-password <pass> Proxy authentication password
  --help, -h              Show this help message

STEALTH:
  With --backend patchright, Chromium is used with Runtime.Enable suppressed,
  making it harder for websites to detect automation.

  With --browser firefox (default), Firefox's native debugging protocol is used,
  which is not subject to CDP-level detection. Full console/network capture works.

EXAMPLES:
  # Default: Firefox with stealth + fingerprint randomization
  playwright-mcp-server

  # Stealth Chromium via Patchright
  playwright-mcp-server --backend patchright

  # No stealth (for testing your own sites)
  playwright-mcp-server --no-stealth --browser chromium

  # With proxy
  playwright-mcp-server --proxy http://proxy.example.com:8080

  # HTTP mode
  playwright-mcp-server --port 8931
`);
        process.exit(0);
    }
  }

  return options;
}

async function runServer() {
  const options = parseArgs();

  // Set global browser config from CLI args
  setGlobalBrowserConfig(options.browserConfig);

  // If port is specified, run in HTTP mode
  if (options.port) {
    process.stdout.write(`\n⏳ Initializing Playwright MCP Server on port ${options.port}...\n`);
    const config = options.browserConfig;
    const backendStr = config.backend || 'playwright';
    const browserStr = config.browserType || 'firefox';
    const stealthStr = config.stealth !== false ? 'enabled' : 'disabled';
    process.stdout.write(`   Backend: ${backendStr}, Browser: ${browserStr}, Stealth: ${stealthStr}\n`);
    await startHttpServer(options.port);
    return;
  }

  // Otherwise, run in stdio mode (default)
  const logger = Logger.getInstance({
    level: 'info',
    format: 'json',
    outputs: ['file'],
    filePath: `${process.env.HOME || '/tmp'}/playwright-mcp-server.log`,
    maxFileSize: 10485760,
    maxFiles: 5
  });
  const loggingMiddleware = new RequestLoggingMiddleware(logger);

  const monitoringSystem = new MonitoringSystem({
    enabled: false,
    metricsInterval: 30000,
    healthCheckInterval: 60000,
    memoryThreshold: 80,
    responseTimeThreshold: 5000
  });

  const serverInfo = {
    name: "playwright-mcp",
    version: "1.1.0",
    capabilities: {
      resources: {},
      tools: {},
    }
  };

  const server = new Server(
    { name: serverInfo.name, version: serverInfo.version },
    { capabilities: serverInfo.capabilities }
  );

  loggingMiddleware.logServerStartup(serverInfo);

  const TOOLS = createToolDefinitions();
  setupRequestHandlers(server, TOOLS, monitoringSystem);

  try {
    await monitoringSystem.startMetricsCollection(3001);
    logger.info('Monitoring system started', { port: 3001 });
  } catch (error) {
    logger.warn('Failed to start monitoring HTTP server', { error: error instanceof Error ? error.message : String(error) });
  }

  async function shutdown() {
    loggingMiddleware.logServerShutdown();
    logger.info('Shutdown signal received');
    try {
      await monitoringSystem.stopMetricsCollection();
    } catch (error) {
      logger.error('Error stopping monitoring system', error instanceof Error ? error : new Error(String(error)));
    }
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', shutdown);
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception', err, {
      category: 'system',
      nodeVersion: process.version,
      platform: process.platform,
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const config = options.browserConfig;
  logger.info('MCP Server connected and ready', {
    transport: 'stdio',
    toolCount: TOOLS.length,
    backend: config.backend || 'playwright',
    browser: config.browserType || 'firefox',
    stealth: config.stealth !== false,
  });
}

runServer().catch(() => {
  process.exit(1);
});
