import { describe, expect, it, vi } from 'vitest';
import {
  prepareConsoleAction,
  shouldDispatchConsoleAction,
} from '../packages/sangfor-jm-execution/src/playwright-driver.js';

describe('JM Playwright action policy', () => {
  it.each(['click', 'type', 'select'] as const)(
    'does not dispatch dry-run %s actions',
    (type) => {
      expect(shouldDispatchConsoleAction({ type, target: 'target', dryRun: true })).toBe(false);
    },
  );

  it.each(['navigate', 'scroll', 'screenshot', 'wait'] as const)(
    'allows read-only dry-run %s actions',
    (type) => {
      expect(shouldDispatchConsoleAction({ type, target: 'target', dryRun: true })).toBe(true);
    },
  );

  it.each(['click', 'type', 'select'] as const)(
    'dispatches approved real %s actions',
    (type) => {
      expect(shouldDispatchConsoleAction({ type, target: 'target', dryRun: false })).toBe(true);
    },
  );

  it('executes menuPath and formFields before an approved action', async () => {
    const click = vi.fn();
    const fill = vi.fn();
    const selectOption = vi.fn();
    const locator = {
      evaluateAll: vi.fn().mockResolvedValue([0]),
      nth: vi.fn().mockReturnValue({ click, fill, selectOption }),
    };
    const page = { locator: vi.fn().mockReturnValue(locator) };

    await prepareConsoleAction(page as never, {
      kind: 'perform_console_action',
      action: { type: 'click', target: 'Apply', dryRun: false },
      menuPath: [{ menu: 'Policy', submenu: 'Access Control' }],
      formFields: [
        { type: 'text', label: 'Policy name', value: 'JM QA' },
        { type: 'select', name: 'mode', value: 'strict' },
      ],
    });

    expect(click).toHaveBeenCalledTimes(2);
    expect(fill).toHaveBeenCalledWith('JM QA');
    expect(selectOption).toHaveBeenCalledWith('strict');
  });
});
