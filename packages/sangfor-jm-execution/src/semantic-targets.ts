import type { Locator, Page } from 'playwright';

const CLICK_TARGET_SELECTOR = [
  'button',
  'a',
  '[role="button"]',
  'input[type="button"]',
  'input[type="submit"]',
  '[data-action]',
  '[onclick]',
  '[class*="x-btn"]',
  '[class*="x-menu-item"]',
  '[class*="x-boundlist-item"]',
].join(', ');
const INPUT_TARGET_SELECTOR =
  'input:not([type="hidden"]):not([disabled]), textarea:not([disabled])';
const SELECT_TARGET_SELECTOR = 'select:not([disabled])';

function strictTargetError(action: string, target: string, count: number): Error {
  if (count === 0) {
    return new Error(`Could not ${action}: no unique target matched "${target}"`);
  }
  return new Error(
    `Could not ${action}: ambiguous target "${target}" matched ${count} elements`,
  );
}

async function uniqueSemanticTarget(
  page: Page,
  selector: string,
  action: string,
  target: string,
  attributes: readonly string[],
  includeText: boolean,
): Promise<Locator> {
  const locator = page.locator(selector);
  const matches = await locator.evaluateAll((elements, descriptor) => elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => {
      const style = window.getComputedStyle(element);
      const rect = (element as HTMLElement).getBoundingClientRect();
      if (
        style.visibility === 'hidden'
        || style.display === 'none'
        || rect.width <= 0
        || rect.height <= 0
      ) return false;
      const values = descriptor.attributes
        .map((attribute) => element.getAttribute(attribute)?.trim());
      if (descriptor.includeText) values.push(element.textContent?.trim());
      return values.includes(descriptor.target);
    })
    .map(({ index }) => index), {
      attributes: [...attributes],
      includeText,
      target,
    });
  const [index] = matches;
  if (matches.length !== 1 || index === undefined) {
    throw strictTargetError(action, target, matches.length);
  }
  return locator.nth(index);
}

export function findUniqueClickTarget(page: Page, target: string): Promise<Locator> {
  return uniqueSemanticTarget(
    page,
    CLICK_TARGET_SELECTOR,
    'click',
    target,
    ['aria-label', 'title', 'value'],
    true,
  );
}

export async function clickUniqueTextTarget(page: Page, target: string): Promise<void> {
  await (await findUniqueClickTarget(page, target)).click();
}

async function findUniqueInputTarget(page: Page, target: string): Promise<Locator> {
  return uniqueSemanticTarget(
    page,
    INPUT_TARGET_SELECTOR,
    'type',
    target,
    ['id', 'name', 'placeholder', 'aria-label', 'title'],
    false,
  );
}

export async function typeUniqueInputTarget(
  page: Page,
  target: string,
  value: string,
): Promise<void> {
  const locator = await findUniqueInputTarget(page, target);
  await locator.fill(value);
  await locator.dispatchEvent('input');
  await locator.dispatchEvent('change');
}

export async function selectUniqueTarget(
  page: Page,
  target: string,
  value: string,
): Promise<void> {
  const semanticTarget = target.startsWith('#') ? target.slice(1) : target;
  const locator = await uniqueSemanticTarget(
    page,
    SELECT_TARGET_SELECTOR,
    'select',
    semanticTarget,
    ['id', 'name', 'aria-label', 'title'],
    false,
  );
  await locator.selectOption(value);
}
