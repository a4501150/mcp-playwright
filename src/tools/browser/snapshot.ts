/**
 * SnapshotTool: Page snapshot for LLM interaction.
 *
 * Returns a structured text representation of the page's DOM tree
 * with semantic information (roles, labels, states) for LLM consumption.
 * Includes iframe subtrees.
 */

import { BrowserToolBase } from './base.js';
import { ToolContext, ToolResponse, createSuccessResponse, createErrorResponse } from '../common/types.js';

export class SnapshotTool extends BrowserToolBase {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      try {
        const lines: string[] = ['Page: ' + page.url(), ''];

        // Get structured DOM snapshot via evaluate
        const snapshot = await page.evaluate(() => {
          const elements: string[] = [];
          let uid = 0;

          const walk = (el: Element, depth: number) => {
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role') || '';
            const ariaLabel = el.getAttribute('aria-label') || '';
            const ariaExpanded = el.getAttribute('aria-expanded');
            const ariaChecked = el.getAttribute('aria-checked');
            const ariaDisabled = el.getAttribute('aria-disabled');
            const ariaSelected = el.getAttribute('aria-selected');
            const name = el.getAttribute('name') || '';
            const type = el.getAttribute('type') || '';
            const placeholder = el.getAttribute('placeholder') || '';
            const href = el.getAttribute('href') || '';
            const id = el.id ? `#${el.id}` : '';
            const classes = el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
              : '';
            const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
              ? (el.textContent?.trim().substring(0, 80) || '')
              : '';

            const indent = '  '.repeat(depth);
            const currentUid = uid++;
            let desc = `${indent}[${currentUid}] ${tag}${id}${classes}`;
            if (role) desc += ` role="${role}"`;
            if (ariaLabel) desc += ` aria-label="${ariaLabel}"`;
            if (name) desc += ` name="${name}"`;
            if (type) desc += ` type="${type}"`;
            if (placeholder) desc += ` placeholder="${placeholder}"`;
            if (href) desc += ` href="${href.substring(0, 80)}"`;
            if (ariaExpanded) desc += ` expanded=${ariaExpanded}`;
            if (ariaChecked) desc += ` checked=${ariaChecked}`;
            if (ariaDisabled === 'true') desc += ' disabled';
            if (ariaSelected === 'true') desc += ' selected';
            if ((el as HTMLInputElement).disabled) desc += ' disabled';
            if ((el as HTMLInputElement).checked) desc += ' checked';
            if (text) desc += ` "${text}"`;

            // Skip invisible elements
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return;

            elements.push(desc);

            for (const child of el.children) {
              walk(child, depth + 1);
            }
          };

          if (document.body) walk(document.body, 0);
          return elements;
        });

        lines.push(...snapshot);

        // Include iframe subtrees if requested
        if (args.includeIframes !== false) {
          const frames = page.frames();
          for (const frame of frames) {
            if (frame === page.mainFrame()) continue;
            try {
              const frameUrl = frame.url();
              if (!frameUrl || frameUrl === 'about:blank') continue;

              lines.push('', `--- iframe: ${frameUrl} ---`);
              const frameSnapshot = await frame.evaluate(() => {
                const elements: string[] = [];
                let uid = 0;
                const walk = (el: Element, depth: number) => {
                  const tag = el.tagName.toLowerCase();
                  const role = el.getAttribute('role') || '';
                  const ariaLabel = el.getAttribute('aria-label') || '';
                  const name = el.getAttribute('name') || '';
                  const type = el.getAttribute('type') || '';
                  const id = el.id ? `#${el.id}` : '';
                  const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
                    ? (el.textContent?.trim().substring(0, 80) || '')
                    : '';

                  const indent = '  '.repeat(depth);
                  const currentUid = uid++;
                  let desc = `${indent}[${currentUid}] ${tag}${id}`;
                  if (role) desc += ` role="${role}"`;
                  if (ariaLabel) desc += ` aria-label="${ariaLabel}"`;
                  if (name) desc += ` name="${name}"`;
                  if (type) desc += ` type="${type}"`;
                  if (text) desc += ` "${text}"`;

                  const style = window.getComputedStyle(el);
                  if (style.display === 'none' || style.visibility === 'hidden') return;

                  elements.push(desc);
                  for (const child of el.children) {
                    walk(child, depth + 1);
                  }
                };
                if (document.body) walk(document.body, 0);
                return elements;
              });

              lines.push(...(frameSnapshot as string[]));
            } catch {
              // Skip iframes we can't access
            }
          }
        }

        return createSuccessResponse(lines);
      } catch (error) {
        return createErrorResponse(`Snapshot failed: ${(error as Error).message}`);
      }
    });
  }
}
