import type { Page } from 'playwright';
import type { BrowserExecutionRequest } from '../../sangfor-browser-contracts/src/index.js';
import {
  findUniqueClickTarget,
  selectUniqueTarget,
  typeUniqueInputTarget,
} from './semantic-targets.js';

type ConsoleAction = Extract<
  BrowserExecutionRequest['operation'],
  { kind: 'perform_console_action' }
>['action'];
type PerformConsoleOperation = Extract<
  BrowserExecutionRequest['operation'],
  { kind: 'perform_console_action' }
>;

const NAVIGATION_TARGET_SELECTOR = [
  'a',
  '[role="menuitem"]',
  '[role="tab"]',
  '[class*="x-menu-item"]',
  '[class*="x-tree-node"]',
].join(', ');
const FORM_TARGET_SELECTOR = [
  'input:not([type="hidden"]):not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[role="combobox"]',
].join(', ');

export function shouldDispatchConsoleAction(action: ConsoleAction): boolean {
  return action.dryRun === false || !['click', 'type', 'select'].includes(action.type);
}

export async function loginWithSessionCredentials(
  page: Page,
  credentials: { username: string; password: string },
  origin: string,
): Promise<void> {
  const password = page.locator(
    'input[name="password"]:visible, input[type="password"]:visible',
  );
  const passwordCount = await password.count();
  if (passwordCount === 0) return;
  if (passwordCount !== 1) {
    throw new Error(`Login refused: expected one password field, found ${passwordCount}.`);
  }
  const captcha = page.locator(
    'input[name="captcha"]:visible, input[name="verify_code"]:visible, input[name="code"]:visible',
  );
  if (await captcha.count() > 0) {
    throw new Error('AUTH_REQUIRED: CAPTCHA requires manual completion.');
  }
  const username = page.locator([
    'input[name="user"]:visible',
    'input[name="username"]:visible',
    'input[name="account"]:visible',
    'input[name="name"]:visible',
  ].join(', '));
  const usernameCount = await username.count();
  if (usernameCount !== 1) {
    throw new Error(`Login refused: expected one username field, found ${usernameCount}.`);
  }
  await username.fill(credentials.username);
  await password.fill(credentials.password);

  const submit = page.locator([
    'button:has-text("Log In"):visible',
    'button[type="submit"]:visible',
    'input[type="submit"]:visible',
    'input[id="button"]:visible',
  ].join(', '));
  const submitCount = await submit.count();
  if (submitCount > 1) {
    throw new Error(`Login refused: expected at most one submit control, found ${submitCount}.`);
  }
  const completed = password.waitFor({ state: 'hidden', timeout: 15_000 });
  if (submitCount === 1) await submit.click();
  else await password.press('Enter');
  await completed;
  if (new URL(page.url()).origin !== origin) {
    throw new Error('Login changed the page origin.');
  }
}

function targetCountError(action: string, target: string, count: number): Error {
  return new Error(count === 0
    ? `Could not ${action}: no unique target matched "${target}".`
    : `Could not ${action}: ambiguous target "${target}" matched ${count} elements.`);
}

export async function uniqueNavigationTarget(page: Page, target: string) {
  const locator = page.locator(NAVIGATION_TARGET_SELECTOR);
  const matches = await locator.evaluateAll((elements, wanted) => elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && [
          element.textContent?.trim(),
          element.getAttribute('aria-label')?.trim(),
          element.getAttribute('title')?.trim(),
        ].includes(wanted);
    })
    .map(({ index }) => index), target);
  const [index] = matches;
  if (matches.length !== 1 || index === undefined) {
    throw targetCountError('navigate', target, matches.length);
  }
  return locator.nth(index);
}

async function uniqueFormTarget(
  page: Page,
  field: NonNullable<PerformConsoleOperation['formFields']>[number],
) {
  const locator = page.locator(FORM_TARGET_SELECTOR);
  const matches = await locator.evaluateAll((elements, descriptor) => elements
    .map((element, index) => ({ element, index }))
    .filter(({ element, index }) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (
        rect.width <= 0
        || rect.height <= 0
        || style.display === 'none'
        || style.visibility === 'hidden'
      ) return false;
      if (descriptor.index !== undefined) return index === descriptor.index;
      return (descriptor.name !== undefined
          && element.getAttribute('name')?.trim() === descriptor.name)
        || (descriptor.id !== undefined
          && element.getAttribute('id')?.trim() === descriptor.id)
        || (descriptor.placeholder !== undefined
          && element.getAttribute('placeholder')?.trim() === descriptor.placeholder)
        || (descriptor.label !== undefined
          && element.getAttribute('aria-label')?.trim() === descriptor.label);
    })
    .map(({ index }) => index), field);
  const target = field.label ?? field.name ?? field.id ?? field.placeholder ?? String(field.index);
  const [index] = matches;
  if (matches.length !== 1 || index === undefined) {
    throw targetCountError('fill', target, matches.length);
  }
  return locator.nth(index);
}

export async function prepareConsoleAction(
  page: Page,
  operation: PerformConsoleOperation,
): Promise<void> {
  if (operation.action.dryRun !== false) return;
  for (const step of operation.menuPath ?? []) {
    await (await uniqueNavigationTarget(page, step.menu)).click();
    if (step.submenu) await (await uniqueNavigationTarget(page, step.submenu)).click();
  }
  for (const field of operation.formFields ?? []) {
    const target = await uniqueFormTarget(page, field);
    if (field.type === 'select') {
      await target.selectOption(field.value ?? '');
    } else if (field.type === 'checkbox' || field.type === 'radio') {
      if (['true', '1', 'yes', 'on'].includes((field.value ?? '').toLowerCase())) {
        await target.check();
      } else {
        await target.uncheck();
      }
    } else {
      await target.fill(field.value ?? '');
    }
  }
}

export async function performConsoleAction(
  page: Page,
  request: BrowserExecutionRequest,
): Promise<void> {
  if (request.operation.kind !== 'perform_console_action') {
    throw new Error('Invalid action operation.');
  }
  const action = request.operation.action;
  if (!shouldDispatchConsoleAction(action)) return;
  await prepareConsoleAction(page, request.operation);
  switch (action.type) {
    case 'navigate':
      await page.goto(new URL(action.target ?? '/', request.origin).toString(), {
        waitUntil: 'domcontentloaded',
      });
      break;
    case 'click':
      await (await findUniqueClickTarget(page, action.target ?? '')).click();
      break;
    case 'type':
      await typeUniqueInputTarget(page, action.target ?? '', action.value ?? '');
      break;
    case 'select':
      await selectUniqueTarget(page, action.target ?? '', action.value ?? '');
      break;
    case 'scroll':
      await page.evaluate(
        (value) => window.scrollBy(0, Number(value) || window.innerHeight),
        action.value,
      );
      break;
    case 'screenshot':
      break;
    case 'wait':
      await page.waitForLoadState('domcontentloaded');
      break;
  }
}

export async function verifyConsole(
  page: Page,
  request: BrowserExecutionRequest,
): Promise<boolean> {
  if (request.operation.kind !== 'verify_console') {
    throw new Error('Invalid verify operation.');
  }
  for (const check of request.operation.checks) {
    if (
      check.kind === 'text_contains'
      && !(await page.locator('body').innerText()).includes(check.expected)
    ) return false;
    if (
      check.kind === 'field_equals'
      && await page.getByLabel(check.id, { exact: true }).inputValue() !== check.expected
    ) return false;
    if (
      check.kind === 'element_present'
      && await page.getByText(check.expected, { exact: true }).count() !== 1
    ) return false;
  }
  return true;
}
