import fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Page } from 'playwright';
import type { TextContent, ImageContent } from '@modelcontextprotocol/sdk/types.js';
import { BrowserToolBase } from './base.js';
import { ToolContext, ToolResponse, createSuccessResponse } from '../common/types.js';
import { resolveSelector } from './selectorUtils.js';

const defaultDownloadsPath = path.join(os.homedir(), 'Downloads');
const MAX_INLINE_SIZE = 2.5 * 1024 * 1024; // 2.5MB

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
      const format: 'png' | 'jpeg' | 'webp' = args.format || "png";
      let actualFormat = format;

      const screenshotOptions: any = {
        type: format,
        fullPage: !!args.fullPage
      };

      // Playwright only accepts quality for jpeg and webp
      if ((format === "jpeg" || format === "webp") && args.quality !== undefined) {
        screenshotOptions.quality = args.quality;
      }

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

      const saveToDisk = !!args.saveImg || !!args.savePath;

      const getExt = (fmt: string) => fmt === "jpeg" ? "jpg" : fmt;
      const getMimeType = (fmt: string) => fmt === "jpeg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png";

      // Only set path when saving to disk
      let outputPath: string | undefined;
      if (saveToDisk) {
        if (args.savePath && /\.\w+$/.test(path.basename(args.savePath))) {
          // savePath looks like a full file path
          outputPath = path.resolve(args.savePath);
          const dir = path.dirname(outputPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
        } else {
          // savePath is a directory (or not set, use default)
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const ext = getExt(format);
          const filename = `${args.name || 'screenshot'}-${timestamp}.${ext}`;
          const saveDir = args.savePath || defaultDownloadsPath;

          if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true });
          }

          outputPath = path.join(saveDir, filename);
        }
        screenshotOptions.path = outputPath;
      }

      let screenshot = await page.screenshot(screenshotOptions);
      let base64Screenshot = screenshot.toString('base64');

      // AutoCompress: if PNG exceeds inline limit, retry as JPEG
      let autoCompressed = false;
      if (!saveToDisk && args.autoCompress && format === "png" && screenshot.length > MAX_INLINE_SIZE) {
        const compressedOptions = { ...screenshotOptions, type: "jpeg" as const, quality: 80 };
        delete compressedOptions.path;
        const compressedScreenshot = await page.screenshot(compressedOptions);

        if (compressedScreenshot.length <= MAX_INLINE_SIZE) {
          const originalSize = screenshot.length;
          screenshot = compressedScreenshot;
          base64Screenshot = screenshot.toString('base64');
          actualFormat = "jpeg";
          autoCompressed = true;
        }
      }

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
        const ext = getExt(actualFormat);
        const filename = `${args.name || 'screenshot'}-${timestamp}.${ext}`;
        const tmpDir = os.tmpdir();
        const tmpPath = path.join(tmpDir, filename);
        fs.writeFileSync(tmpPath, screenshot);
        content.push({ type: "text", text: `Screenshot too large for inline (${(screenshot.length / 1024 / 1024).toFixed(1)}MB). Saved to: ${tmpPath}` });
      } else {
        // Inline mode: return ImageContent
        if (autoCompressed) {
          content.push({ type: "text", text: `Auto-compressed from PNG to JPEG (${(screenshot.length / 1024).toFixed(0)}KB)` });
        }
        content.push({ type: "image", data: base64Screenshot, mimeType: getMimeType(actualFormat) });
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