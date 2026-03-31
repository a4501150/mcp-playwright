import { BrowserToolBase } from "./base.js";
import type { ToolContext, ToolResponse } from "../common/types.js";
import { createSuccessResponse, createErrorResponse } from "../common/types.js";
import type { NetworkCapture } from "./network.js";

const BODY_PREVIEW_LIMIT = 2000;
const DEFAULT_LOOKBACK_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Tool for waiting for a network response matching a URL pattern.
 * Checks the network capture buffer first, then falls back to live waiting.
 */
export class WaitForResponseTool extends BrowserToolBase {
  private networkCapture: NetworkCapture;

  constructor(server: any, networkCapture: NetworkCapture) {
    super(server);
    this.networkCapture = networkCapture;
  }

  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      if (!args.urlPattern) {
        return createErrorResponse("Missing required parameter: urlPattern");
      }

      const timeout = args.timeout ?? DEFAULT_TIMEOUT_MS;
      let regex: RegExp;
      try {
        regex = new RegExp(args.urlPattern, "i");
      } catch (e) {
        return createErrorResponse(
          `Invalid regex pattern: ${(e as Error).message}`,
        );
      }

      // Step 1: Check network capture buffer for a recent matching response
      const sinceTimestamp = Date.now() - DEFAULT_LOOKBACK_MS;
      const buffered = this.networkCapture.getRequests({
        urlPattern: args.urlPattern,
        sinceTimestamp,
        resourceType: args.resourceType,
      });

      // Only consider completed requests (those with a status)
      const completed = buffered.filter(
        (r) => r.status !== undefined && r.status > 0,
      );
      if (completed.length > 0) {
        const match = completed[completed.length - 1]; // most recent
        return createSuccessResponse(
          formatResponse(
            match.method,
            match.status!,
            match.url,
            match.duration,
            match.responseBody,
            "buffer",
          ),
        );
      }

      // Step 2: Wait for the next matching response via Playwright
      try {
        const response = await page.waitForResponse(
          (resp) => {
            if (!regex.test(resp.url())) return false;
            if (args.resourceType) {
              return (
                resp.request().resourceType().toLowerCase() ===
                args.resourceType.toLowerCase()
              );
            }
            return true;
          },
          { timeout },
        );

        const status = response.status();
        const url = response.url();
        const method = response.request().method();
        let body: string | undefined;
        try {
          body = await response.text();
        } catch {
          // Body may not be available (e.g., redirects)
        }

        return createSuccessResponse(
          formatResponse(method, status, url, undefined, body, "live"),
        );
      } catch (error) {
        return createErrorResponse(
          `Timed out waiting for response matching "${args.urlPattern}" (${timeout}ms)`,
        );
      }
    });
  }
}

function formatResponse(
  method: string,
  status: number,
  url: string,
  duration?: number,
  body?: string,
  source?: string,
): string {
  const lines = [`Response matched (${source}): ${method} ${status} ${url}`];
  if (duration !== undefined) {
    lines.push(`Duration: ${duration}ms`);
  }
  if (body) {
    const preview =
      body.length > BODY_PREVIEW_LIMIT
        ? body.slice(0, BODY_PREVIEW_LIMIT) + "...(truncated)"
        : body;
    lines.push(`Body preview: ${preview}`);
  }
  return lines.join("\n");
}
