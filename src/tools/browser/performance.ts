/**
 * Performance tools: Playwright context.tracing API (cross-browser).
 * Records HAR, screenshots, and action snapshots.
 */

import { BrowserToolBase } from './base.js';
import { ToolContext, ToolResponse, createSuccessResponse, createErrorResponse } from '../common/types.js';
import path from 'path';
import os from 'os';

let tracingActive = false;

export class StartTracingTool extends BrowserToolBase {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      if (tracingActive) {
        return createErrorResponse('Tracing is already active. Stop it first with playwright_stop_trace.');
      }

      try {
        await page.context().tracing.start({
          screenshots: args.screenshots !== false,
          snapshots: args.snapshots !== false,
        });
        tracingActive = true;
        return createSuccessResponse('Tracing started. Perform actions, then call playwright_stop_trace to save.');
      } catch (error) {
        return createErrorResponse(`Failed to start tracing: ${(error as Error).message}`);
      }
    });
  }
}

export class StopTracingTool extends BrowserToolBase {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      if (!tracingActive) {
        return createErrorResponse('No active tracing session. Start one first with playwright_start_trace.');
      }

      const outputPath = args.outputPath || path.join(os.tmpdir(), `trace-${Date.now()}.zip`);

      try {
        await page.context().tracing.stop({ path: outputPath });
        tracingActive = false;
        return createSuccessResponse([
          `Tracing saved to: ${outputPath}`,
          `View with: npx playwright show-trace ${outputPath}`,
        ]);
      } catch (error) {
        tracingActive = false;
        return createErrorResponse(`Failed to stop tracing: ${(error as Error).message}`);
      }
    });
  }
}
