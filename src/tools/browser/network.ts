/**
 * NetworkCapture: Captures and stores network requests/responses for inspection.
 *
 * Attaches to Playwright page events and stores in a ring buffer.
 * Provides tools for listing and inspecting captured requests.
 * Supports capture-time filtering by URL patterns and resource types.
 */

import type { Page, Request, Response } from 'playwright';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import { BrowserToolBase } from './base.js';
import { ToolContext, ToolResponse, createSuccessResponse, createErrorResponse } from '../common/types.js';

export interface CapturedRequest {
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  resourceType: string;
  timestamp: number;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  duration?: number;
}

export interface NetworkCaptureConfig {
  /** Max requests in buffer. 0 = unlimited. Default: 500 */
  maxRequests: number;
  /** Regex patterns — only capture URLs matching at least one. Empty/undefined = capture all */
  includePatterns?: string[];
  /** Regex patterns — drop URLs matching any */
  excludePatterns?: string[];
  /** Only capture these resource types (e.g. 'fetch', 'xhr', 'document'). Empty/undefined = all */
  resourceTypes?: string[];
}

const DEFAULT_CAPTURE_CONFIG: NetworkCaptureConfig = {
  maxRequests: 0, // unlimited by default (matches chrome-devtools MCP behavior)
};

export class NetworkCapture {
  private requests: CapturedRequest[] = [];
  private nextId = 0;
  private pendingRequests = new Map<string, CapturedRequest>();
  private config: NetworkCaptureConfig;
  private includeRegexes: RegExp[] = [];
  private excludeRegexes: RegExp[] = [];

  constructor(config?: Partial<NetworkCaptureConfig>) {
    this.config = { ...DEFAULT_CAPTURE_CONFIG, ...config };
    this.compilePatterns();
  }

  private compilePatterns(): void {
    this.includeRegexes = (this.config.includePatterns ?? []).map(p => new RegExp(p, 'i'));
    this.excludeRegexes = (this.config.excludePatterns ?? []).map(p => new RegExp(p, 'i'));
  }

  /**
   * Update capture config at runtime. Validates regex patterns before applying.
   * Filters only affect new requests — already-captured requests remain.
   */
  updateConfig(partial: Partial<NetworkCaptureConfig>): void {
    // Validate regex patterns before applying
    if (partial.includePatterns) {
      for (const p of partial.includePatterns) {
        new RegExp(p, 'i'); // throws on invalid
      }
    }
    if (partial.excludePatterns) {
      for (const p of partial.excludePatterns) {
        new RegExp(p, 'i'); // throws on invalid
      }
    }

    Object.assign(this.config, partial);
    this.compilePatterns();
  }

  getConfig(): NetworkCaptureConfig {
    return { ...this.config };
  }

  /**
   * Check if a request should be captured based on current filters.
   */
  private shouldCapture(url: string, resourceType: string): boolean {
    // Resource type filter
    if (this.config.resourceTypes && this.config.resourceTypes.length > 0) {
      if (!this.config.resourceTypes.includes(resourceType)) {
        return false;
      }
    }

    // Exclude patterns — drop if any match
    if (this.excludeRegexes.length > 0) {
      for (const re of this.excludeRegexes) {
        if (re.test(url)) return false;
      }
    }

    // Include patterns — must match at least one (if any are set)
    if (this.includeRegexes.length > 0) {
      let matched = false;
      for (const re of this.includeRegexes) {
        if (re.test(url)) { matched = true; break; }
      }
      if (!matched) return false;
    }

    return true;
  }

  /**
   * Attach request/response listeners to a Playwright page
   */
  attachToPage(page: Page): void {
    page.on('request', (request: Request) => {
      const url = request.url();
      const resourceType = request.resourceType();

      if (!this.shouldCapture(url, resourceType)) {
        return;
      }

      const captured: CapturedRequest = {
        id: this.nextId++,
        url,
        method: request.method(),
        headers: request.headers(),
        postData: request.postData() ?? undefined,
        resourceType,
        timestamp: Date.now(),
      };

      this.pendingRequests.set(url + request.method(), captured);
    });

    page.on('response', async (response: Response) => {
      const request = response.request();
      const key = request.url() + request.method();
      const captured = this.pendingRequests.get(key);

      if (captured) {
        captured.status = response.status();
        captured.statusText = response.statusText();
        captured.responseHeaders = response.headers();
        captured.duration = Date.now() - captured.timestamp;

        // Try to capture response body (best-effort, may fail for large/binary responses)
        try {
          const body = await response.text();
          captured.responseBody = body.length > 10000 ? body.substring(0, 10000) + '... [truncated]' : body;
        } catch {
          captured.responseBody = '[unable to capture body]';
        }

        this.pendingRequests.delete(key);
        this.requests.push(captured);

        // Ring buffer: evict oldest (skip if unlimited)
        if (this.config.maxRequests > 0 && this.requests.length > this.config.maxRequests) {
          this.requests = this.requests.slice(-this.config.maxRequests);
        }
      }
    });
  }

  /**
   * Get all captured requests, optionally filtered
   */
  getRequests(filter?: {
    urlPattern?: string;
    method?: string;
    statusMin?: number;
    statusMax?: number;
    limit?: number;
  }): CapturedRequest[] {
    let results = [...this.requests];

    if (filter?.urlPattern) {
      const regex = new RegExp(filter.urlPattern, 'i');
      results = results.filter(r => regex.test(r.url));
    }
    if (filter?.method) {
      results = results.filter(r => r.method.toUpperCase() === filter.method!.toUpperCase());
    }
    if (filter?.statusMin !== undefined) {
      results = results.filter(r => r.status !== undefined && r.status >= filter.statusMin!);
    }
    if (filter?.statusMax !== undefined) {
      results = results.filter(r => r.status !== undefined && r.status <= filter.statusMax!);
    }
    if (filter?.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /**
   * Get a single request by ID
   */
  getRequestById(id: number): CapturedRequest | undefined {
    return this.requests.find(r => r.id === id);
  }

  clear(): void {
    this.requests = [];
    this.pendingRequests.clear();
    this.nextId = 0;
  }
}

/**
 * Tool: List captured network requests
 */
export class NetworkRequestsTool extends BrowserToolBase {
  private networkCapture: NetworkCapture;

  constructor(server: any, networkCapture: NetworkCapture) {
    super(server);
    this.networkCapture = networkCapture;
  }

  async execute(args: any, _context: ToolContext): Promise<ToolResponse> {
    const requests = this.networkCapture.getRequests({
      urlPattern: args.urlPattern,
      method: args.method,
      statusMin: args.statusMin,
      statusMax: args.statusMax,
      limit: args.limit || 50,
    });

    if (requests.length === 0) {
      return createSuccessResponse('No network requests matching the criteria');
    }

    const lines = requests.map(r =>
      `[${r.id}] ${r.method} ${r.status ?? '???'} ${r.url} (${r.duration ?? '?'}ms)`
    );

    return createSuccessResponse([
      `Captured ${requests.length} request(s):`,
      ...lines,
    ]);
  }
}

/**
 * Tool: Get details of a specific network request
 */
export class GetNetworkRequestTool extends BrowserToolBase {
  private networkCapture: NetworkCapture;

  constructor(server: any, networkCapture: NetworkCapture) {
    super(server);
    this.networkCapture = networkCapture;
  }

  async execute(args: any, _context: ToolContext): Promise<ToolResponse> {
    const request = this.networkCapture.getRequestById(args.id);
    if (!request) {
      return createErrorResponse(`Request with ID ${args.id} not found`);
    }

    const details: string[] = [
      `Request #${request.id}`,
      `URL: ${request.url}`,
      `Method: ${request.method}`,
      `Status: ${request.status ?? 'pending'} ${request.statusText ?? ''}`,
      `Resource Type: ${request.resourceType}`,
      `Duration: ${request.duration ?? 'N/A'}ms`,
      '',
      '--- Request Headers ---',
      ...Object.entries(request.headers).map(([k, v]) => `${k}: ${v}`),
    ];

    if (request.postData) {
      details.push('', '--- Request Body ---', request.postData);
    }

    if (request.responseHeaders) {
      details.push('', '--- Response Headers ---',
        ...Object.entries(request.responseHeaders).map(([k, v]) => `${k}: ${v}`)
      );
    }

    if (request.responseBody) {
      details.push('', '--- Response Body ---', request.responseBody);
    }

    return createSuccessResponse(details);
  }
}

/**
 * Tool: Configure network capture filters and buffer size at runtime
 */
export class NetworkConfigTool extends BrowserToolBase {
  private networkCapture: NetworkCapture;

  constructor(server: any, networkCapture: NetworkCapture) {
    super(server);
    this.networkCapture = networkCapture;
  }

  async execute(args: any, _context: ToolContext): Promise<ToolResponse> {
    const update: Partial<NetworkCaptureConfig> = {};

    if (args.maxRequests !== undefined) update.maxRequests = args.maxRequests;
    if (args.includePatterns !== undefined) update.includePatterns = args.includePatterns;
    if (args.excludePatterns !== undefined) update.excludePatterns = args.excludePatterns;
    if (args.resourceTypes !== undefined) update.resourceTypes = args.resourceTypes;

    try {
      this.networkCapture.updateConfig(update);
    } catch (err) {
      return createErrorResponse(`Invalid config: ${(err as Error).message}`);
    }

    const config = this.networkCapture.getConfig();
    const lines = [
      'Network capture config updated:',
      `  Buffer size: ${config.maxRequests === 0 ? 'unlimited' : config.maxRequests}`,
      `  Include patterns: ${config.includePatterns?.length ? config.includePatterns.join(', ') : '(none — capture all URLs)'}`,
      `  Exclude patterns: ${config.excludePatterns?.length ? config.excludePatterns.join(', ') : '(none)'}`,
      `  Resource types: ${config.resourceTypes?.length ? config.resourceTypes.join(', ') : '(all)'}`,
    ];

    return createSuccessResponse(lines);
  }
}

/**
 * Tool: Export captured network requests to a JSON file
 */
export class DumpNetworkTool extends BrowserToolBase {
  private networkCapture: NetworkCapture;

  constructor(server: any, networkCapture: NetworkCapture) {
    super(server);
    this.networkCapture = networkCapture;
  }

  async execute(args: any, _context: ToolContext): Promise<ToolResponse> {
    const filePath = resolve(args.outputPath);
    const requests = this.networkCapture.getRequests(args.filter);

    if (requests.length === 0) {
      return createSuccessResponse('No requests to export (buffer is empty or filter matched nothing)');
    }

    const json = JSON.stringify(requests, null, 2);

    try {
      await writeFile(filePath, json, 'utf-8');
      return createSuccessResponse(`Exported ${requests.length} request(s) to ${filePath}`);
    } catch (err) {
      return createErrorResponse(`Failed to write file: ${(err as Error).message}`);
    }
  }
}
