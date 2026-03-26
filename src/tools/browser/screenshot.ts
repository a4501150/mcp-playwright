import fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Page } from 'playwright';
import type { TextContent, ImageContent } from '@modelcontextprotocol/sdk/types.js';
import { BrowserToolBase } from './base.js';
import { ToolContext, ToolResponse, createSuccessResponse } from '../common/types.js';
import { resolveSelector } from './selectorUtils.js';

const defaultDownloadsPath = path.join(os.homedir(), 'Downloads');
const MAX_INLINE_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * Tool for taking screenshots of pages or elements
 */
export class ScreenshotTool extends BrowserToolBase {
  private screenshots = new Map<string, string>();

  /**
   * Execute the screenshot tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      const screenshotOptions: any = {
        type: args.type || "png",
        fullPage: !!args.fullPage
      };

      if (args.selector) {
        const selector = resolveSelector(args.selector, args.nth, args.withinSelector);
        const element = await page.$(selector);
        if (!element) {
          return {
            content: [{
              type: "text",
              text: `Element not found: ${selector}`,
            }],
            isError: true
          };
        }
        screenshotOptions.element = element;
      }

      const saveToDisk = !!args.savePng || !!args.downloadsDir;

      // Only set path when saving to disk
      let outputPath: string | undefined;
      if (saveToDisk) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${args.name || 'screenshot'}-${timestamp}.png`;
        const downloadsDir = args.downloadsDir || defaultDownloadsPath;

        if (!fs.existsSync(downloadsDir)) {
          fs.mkdirSync(downloadsDir, { recursive: true });
        }

        outputPath = path.join(downloadsDir, filename);
        screenshotOptions.path = outputPath;
      }

      const screenshot = await page.screenshot(screenshotOptions);
      const base64Screenshot = screenshot.toString('base64');

      // Handle base64 storage for MCP resource access
      if (args.storeBase64 !== false) {
        this.screenshots.set(args.name || 'screenshot', base64Screenshot);
        this.server.notification({
          method: "notifications/resources/list_changed",
        });
      }

      const content: (TextContent | ImageContent)[] = [];

      if (saveToDisk) {
        // Disk mode: return text path
        content.push({ type: "text", text: `Screenshot saved to: ${path.relative(process.cwd(), outputPath!)}` });
        if (args.storeBase64 !== false) {
          content.push({ type: "text", text: `Screenshot also stored in memory with name: '${args.name || 'screenshot'}'` });
        }
      } else if (screenshot.length > MAX_INLINE_SIZE) {
        // Inline mode but too large: fall back to saving to temp file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${args.name || 'screenshot'}-${timestamp}.png`;
        const tmpDir = os.tmpdir();
        const tmpPath = path.join(tmpDir, filename);
        fs.writeFileSync(tmpPath, screenshot);
        content.push({ type: "text", text: `Screenshot too large for inline (${(screenshot.length / 1024 / 1024).toFixed(1)}MB). Saved to: ${tmpPath}` });
      } else {
        // Inline mode: return ImageContent
        content.push({ type: "image", data: base64Screenshot, mimeType: "image/png" });
      }

      return { content, isError: false };
    });
  }

  /**
   * Get all stored screenshots
   */
  getScreenshots(): Map<string, string> {
    return this.screenshots;
  }
} 