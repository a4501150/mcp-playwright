/**
 * NetworkCapture: Captures and stores network requests/responses for inspection.
 *
 * Attaches to Playwright page events and stores in a ring buffer.
 * Provides tools for listing and inspecting captured requests.
 */

import type { Page, Request, Response } from 'playwright';
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

export class NetworkCapture {
  private requests: CapturedRequest[] = [];
  private maxRequests: number;
  private nextId = 0;
  private pendingRequests = new Map<string, CapturedRequest>();

  constructor(maxRequests = 500) {
    this.maxRequests = maxRequests;
  }

  /**
   * Attach request/response listeners to a Playwright page
   */
  attachToPage(page: Page): void {
    page.on('request', (request: Request) => {
      const captured: CapturedRequest = {
        id: this.nextId++,
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        postData: request.postData() ?? undefined,
        resourceType: request.resourceType(),
        timestamp: Date.now(),
      };

      this.pendingRequests.set(request.url() + request.method(), captured);
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

        // Ring buffer: evict oldest
        if (this.requests.length > this.maxRequests) {
          this.requests = this.requests.slice(-this.maxRequests);
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
