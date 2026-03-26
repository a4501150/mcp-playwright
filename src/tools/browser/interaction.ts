import { BrowserToolBase } from './base.js';
import { ToolContext, ToolResponse, createSuccessResponse, createErrorResponse } from '../common/types.js';
import { setGlobalPage } from '../../toolHandler.js';
import { createCursor } from 'ghost-cursor-playwright';
import { resolveSelector } from './selectorUtils.js';
/**
 * Tool for clicking elements on the page
 */
export class ClickTool extends BrowserToolBase {
  /**
   * Execute the click tool
   * @param args.selector CSS selector for the element to click
   * @param args.humanize If true, use Bezier curve mouse movement (default: false)
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      const selector = resolveSelector(args.selector, args.nth, args.withinSelector);
      if (args.humanize) {
        try {
          const cursor = await createCursor(page);
          await cursor.actions.click({
            target: selector,
            waitBeforeClick: [50, 200],
          });
          return createSuccessResponse(`Clicked element (humanized): ${selector}`);
        } catch {
          // Fall back to normal click if ghost-cursor fails
          await page.click(selector);
          return createSuccessResponse(`Clicked element (fallback): ${selector}`);
        }
      }
      await page.click(selector);
      return createSuccessResponse(`Clicked element: ${selector}`);
    });
  }
}
/**
 * Tool for clicking a link and switching to the new tab
 */
export class ClickAndSwitchTabTool extends BrowserToolBase {
  /**
   * Execute the click and switch tab tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    
    return this.safeExecute(context, async (page) => {
      // Listen for a new tab to open
      const [newPage] = await Promise.all([
        //context.browser.waitForEvent('page'), // Wait for a new page (tab) to open
        page.context().waitForEvent('page'),// Wait for a new page (tab) to open
        page.click(args.selector), // Click the link that opens the new tab
      ]);

      // Wait for the new page to load
      await newPage.waitForLoadState('domcontentloaded');

      // Switch control to the new tab
      setGlobalPage(newPage);
      //page= newPage; // Update the current page to the new tab
      //context.page = newPage;
      //context.page.bringToFront(); // Bring the new tab to the front
      return createSuccessResponse(`Clicked link and switched to new tab: ${newPage.url()}`);
      //return createSuccessResponse(`Clicked link and switched to new tab: ${context.page.url()}`);
    });
  }
}
/**
 * Tool for clicking elements inside iframes
 */
export class IframeClickTool extends BrowserToolBase {
  /**
   * Execute the iframe click tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      const frame = page.frameLocator(args.iframeSelector);
      if (!frame) {
        return createErrorResponse(`Iframe not found: ${args.iframeSelector}`);
      }
      
      await frame.locator(args.selector).click();
      return createSuccessResponse(`Clicked element ${args.selector} inside iframe ${args.iframeSelector}`);
    });
  }
}

/**
 * Tool for filling elements inside iframes
 */
export class IframeFillTool extends BrowserToolBase {
  /**
   * Execute the iframe fill tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      const frame = page.frameLocator(args.iframeSelector);
      if (!frame) {
        return createErrorResponse(`Iframe not found: ${args.iframeSelector}`);
      }
      
      await frame.locator(args.selector).fill(args.value);
      return createSuccessResponse(`Filled element ${args.selector} inside iframe ${args.iframeSelector} with: ${args.value}`);
    });
  }
}

/**
 * Tool for filling form fields
 */
export class FillTool extends BrowserToolBase {
  /**
   * Execute the fill tool
   * @param args.selector CSS selector for input field
   * @param args.value Value to fill
   * @param args.humanize If true, type with randomized delays (default: false)
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      const selector = resolveSelector(args.selector, args.nth, args.withinSelector);
      await page.waitForSelector(selector);

      if (args.humanize) {
        // Clear existing value first
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');

        // Type with humanized delays
        for (const char of args.value) {
          const delay = char === ' '
            ? Math.floor(Math.random() * 100) + 80   // longer pause after space
            : Math.floor(Math.random() * 100) + 30;  // 30-130ms per char
          await page.keyboard.type(char, { delay });

          // Occasional hesitation (3% chance)
          if (Math.random() < 0.03) {
            await page.waitForTimeout(Math.floor(Math.random() * 300) + 100);
          }
        }
        return createSuccessResponse(`Filled ${selector} with humanized typing: ${args.value}`);
      }

      await page.fill(selector, args.value);
      return createSuccessResponse(`Filled ${selector} with: ${args.value}`);
    });
  }
}

/**
 * Tool for selecting options from dropdown menus
 */
export class SelectTool extends BrowserToolBase {
  /**
   * Execute the select tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      const selector = resolveSelector(args.selector, args.nth, args.withinSelector);
      await page.waitForSelector(selector);
      await page.selectOption(selector, args.value);
      return createSuccessResponse(`Selected ${selector} with: ${args.value}`);
    });
  }
}

/**
 * Tool for hovering over elements
 */
export class HoverTool extends BrowserToolBase {
  /**
   * Execute the hover tool
   * @param args.selector CSS selector for element to hover
   * @param args.humanize If true, use Bezier curve mouse movement (default: false)
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      const selector = resolveSelector(args.selector, args.nth, args.withinSelector);
      await page.waitForSelector(selector);

      if (args.humanize) {
        try {
          const cursor = await createCursor(page);
          await cursor.actions.move(selector);
          return createSuccessResponse(`Hovered (humanized) ${selector}`);
        } catch {
          await page.hover(selector);
          return createSuccessResponse(`Hovered (fallback) ${selector}`);
        }
      }

      await page.hover(selector);
      return createSuccessResponse(`Hovered ${selector}`);
    });
  }
}

/**
 * Tool for uploading files
 */
export class UploadFileTool extends BrowserToolBase {
  /**
   * Execute the upload file tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
        const selector = resolveSelector(args.selector, args.nth, args.withinSelector);
        await page.waitForSelector(selector);
        await page.setInputFiles(selector, args.filePath);
        return createSuccessResponse(`Uploaded file '${args.filePath}' to '${selector}'`);
    });
  }
}

/**
 * Tool for executing JavaScript in the browser
 */
export class EvaluateTool extends BrowserToolBase {
  /**
   * Execute the evaluate tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      const result = await page.evaluate(args.script);
      
      // Convert result to string for display
      let resultStr: string;
      try {
        resultStr = JSON.stringify(result, null, 2);
      } catch (error) {
        resultStr = String(result);
      }
      
      return createSuccessResponse([
        `Executed JavaScript:`,
        `${args.script}`,
        `Result:`,
        `${resultStr}`
      ]);
    });
  }
}

/**
 * Tool for dragging elements on the page
 */
export class DragTool extends BrowserToolBase {
  /**
   * Execute the drag tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      const sourceElement = await page.waitForSelector(args.sourceSelector);
      const targetElement = await page.waitForSelector(args.targetSelector);
      
      const sourceBound = await sourceElement.boundingBox();
      const targetBound = await targetElement.boundingBox();
      
      if (!sourceBound || !targetBound) {
        return createErrorResponse("Could not get element positions for drag operation");
      }

      await page.mouse.move(
        sourceBound.x + sourceBound.width / 2,
        sourceBound.y + sourceBound.height / 2
      );
      await page.mouse.down();
      await page.mouse.move(
        targetBound.x + targetBound.width / 2,
        targetBound.y + targetBound.height / 2
      );
      await page.mouse.up();
      
      return createSuccessResponse(`Dragged element from ${args.sourceSelector} to ${args.targetSelector}`);
    });
  }
}

/**
 * Tool for pressing keyboard keys
 */
export class PressKeyTool extends BrowserToolBase {
  /**
   * Execute the key press tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      if (args.selector) {
        const selector = resolveSelector(args.selector, args.nth, args.withinSelector);
        await page.waitForSelector(selector);
        await page.focus(selector);
      }

      await page.keyboard.press(args.key);
      return createSuccessResponse(`Pressed key: ${args.key}`);
    });
  }
} 


/**
 * Tool for evaluating JavaScript inside an iframe
 */
export class IframeEvaluateTool extends BrowserToolBase {
  /**
   * Execute JavaScript inside a specific iframe.
   * Supports CSS selector (iframeSelector) or URL pattern (urlPattern) to identify the iframe.
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      try {
        let result: any;

        if (args.urlPattern) {
          // Find frame by URL pattern
          const frame = page.frames().find(f => f.url().includes(args.urlPattern));
          if (!frame) {
            return createErrorResponse(`No iframe found matching URL pattern: ${args.urlPattern}`);
          }
          result = await frame.evaluate(args.script);
        } else if (args.iframeSelector) {
          // Use frameLocator with CSS selector
          const frameLocator = page.frameLocator(args.iframeSelector);
          // frameLocator doesn't have evaluate directly — find the frame via element handle
          const frameElement = await page.$(args.iframeSelector);
          if (!frameElement) {
            return createErrorResponse(`Iframe not found: ${args.iframeSelector}`);
          }
          const frame = await frameElement.contentFrame();
          if (!frame) {
            return createErrorResponse(`Could not access iframe content: ${args.iframeSelector}`);
          }
          result = await frame.evaluate(args.script);
        } else {
          return createErrorResponse('Either iframeSelector or urlPattern is required');
        }

        let resultStr: string;
        try {
          resultStr = JSON.stringify(result, null, 2);
        } catch {
          resultStr = String(result);
        }

        return createSuccessResponse([
          `Executed in iframe:`,
          `${args.script}`,
          `Result:`,
          `${resultStr}`,
        ]);
      } catch (error) {
        return createErrorResponse(`Iframe evaluate failed: ${(error as Error).message}`);
      }
    });
  }
}

/**
 * Tool for switching browser tabs
 */
/**
 * Tool for waiting for a selector or text to appear on the page
 */
export class WaitForTool extends BrowserToolBase {
  /**
   * Execute the wait for tool
   * @param args.selector CSS selector to wait for
   * @param args.text Text content to wait for on the page
   * @param args.state Element state to wait for (default: visible)
   * @param args.timeout Maximum wait time in milliseconds (default: 30000)
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      if (!args.selector && !args.text) {
        return createErrorResponse("Either 'selector' or 'text' must be provided");
      }

      const state = args.state || 'visible';
      const timeout = args.timeout || 30000;

      if (args.selector) {
        await page.waitForSelector(args.selector, { state, timeout });
        return createSuccessResponse(`Element matching selector "${args.selector}" is ${state}`);
      }

      await page.locator(`text=${args.text}`).waitFor({ state, timeout });
      return createSuccessResponse(`Text "${args.text}" is ${state} on the page`);
    });
  }
}

// export class SwitchTabTool extends BrowserToolBase {
//   /**
//    * Switch the tab to the specified index
//    */
//   async execute(args: any, context: ToolContext): Promise<ToolResponse> {
//     return this.safeExecute(context, async (page) => {
//       const tabs = await browser.page;      

//       // Validate the tab index
//       const tabIndex = Number(args.index);
//       if (isNaN(tabIndex)) {
//         return createErrorResponse(`Invalid tab index: ${args.index}. It must be a number.`);
//       }

//       if (tabIndex >= 0 && tabIndex < tabs.length) {
//         await tabs[tabIndex].bringToFront();
//         return createSuccessResponse(`Switched to tab with index ${tabIndex}`);
//       } else {
//         return createErrorResponse(
//           `Tab index out of range: ${tabIndex}. Available tabs: 0 to ${tabs.length - 1}.`
//         );
//       }
//     });
//   }
// }