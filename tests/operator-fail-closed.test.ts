import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertNavigationWithinTarget,
  clickUniqueTextTarget,
  selectUniqueTarget,
  typeUniqueInputTarget,
} from '../packages/sangfor-operator/src/index.js';

class FakeElement {
  value = '';
  title = '';
  clicked = 0;
  selected = '';

  constructor(
    public textContent: string,
    private attrs: Record<string, string> = {},
    private visible = true,
  ) {
    this.value = attrs.value ?? '';
    this.title = attrs.title ?? '';
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: this.visible ? 10 : 0, height: this.visible ? 10 : 0 };
  }
}

class FakeInputElement extends FakeElement {}

class FakeLocator {
  constructor(private elements: FakeElement[]) {}

  async count(): Promise<number> {
    return this.elements.length;
  }

  async evaluateAll<T>(fn: (elements: FakeElement[], arg: T) => unknown, arg: T): Promise<any> {
    return fn(this.elements, arg);
  }

  nth(index: number): FakeLocator {
    return new FakeLocator([this.elements[index]]);
  }

  filter(): FakeLocator {
    return this;
  }

  async click(): Promise<void> {
    this.elements[0].clicked += 1;
  }

  async fill(value: string): Promise<void> {
    this.elements[0].value = value;
  }

  async dispatchEvent(): Promise<void> {
    return;
  }

  async selectOption(value: string): Promise<void> {
    this.elements[0].selected = value;
  }
}

class FakePage {
  clicks: FakeElement[] = [];
  inputs: FakeInputElement[] = [];
  selects: FakeElement[] = [];

  locator(selector: string): FakeLocator {
    if (selector === 'option') return new FakeLocator([]);
    if (selector === 'select' || selector === '#action') return new FakeLocator(this.selects);
    if (selector.includes('input:not') || selector.includes('textarea')) return new FakeLocator(this.inputs);
    if (selector.includes('button')) return new FakeLocator(this.clicks);
    return new FakeLocator([]);
  }
}

beforeEach(() => {
  (globalThis as any).HTMLInputElement = FakeInputElement;
  (globalThis as any).window = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
});

describe('live operator fail-closed locators', () => {
  it('clicks only when a visible actionable text target is unique', async () => {
    const page = new FakePage();
    page.clicks = [new FakeElement('Export'), new FakeElement('Export', {}, false)];

    await clickUniqueTextTarget(page, 'Export');

    expect(page.clicks[0].clicked).toBe(1);
    expect(page.clicks[1].clicked).toBe(0);
  });

  it('blocks ambiguous click targets instead of clicking the first match', async () => {
    const page = new FakePage();
    page.clicks = [new FakeElement('Apply'), new FakeElement('Apply')];

    await expect(clickUniqueTextTarget(page, 'Apply')).rejects.toThrow(/ambiguous target/i);
    expect(page.clicks.every((el) => el.clicked === 0)).toBe(true);
  });

  it('blocks type actions when the named target is missing instead of using the first visible input', async () => {
    const page = new FakePage();
    page.inputs = [
      new FakeInputElement('', { id: 'username', value: 'unchanged' }),
      new FakeInputElement('', { id: 'comment' }),
    ];

    await expect(typeUniqueInputTarget(page, 'password', 'secret')).rejects.toThrow(/no unique target/i);

    expect(page.inputs[0].value).toBe('unchanged');
    expect(page.inputs[1].value).toBe('');
  });

  it('blocks ambiguous type targets', async () => {
    const page = new FakePage();
    page.inputs = [
      new FakeInputElement('', { name: 'policyName' }),
      new FakeInputElement('', { name: 'policyName' }),
    ];

    await expect(typeUniqueInputTarget(page, 'policyName', 'new policy')).rejects.toThrow(/ambiguous target/i);
  });

  it('selects only one matching select target', async () => {
    const page = new FakePage();
    page.selects = [new FakeElement('', { id: 'action' })];

    await selectUniqueTarget(page, '#action', 'block');

    expect(page.selects[0].selected).toBe('block');
  });
});

describe('navigate origin guard', () => {
  it('allows same-origin and relative navigation', () => {
    const s = { targetUrl: 'https://10.80.1.9/console' };
    expect(() => assertNavigationWithinTarget(s, { type: 'navigate', target: 'https://10.80.1.9/vols' })).not.toThrow();
    expect(() => assertNavigationWithinTarget(s, { type: 'navigate', target: '/vols' })).not.toThrow();
    expect(() => assertNavigationWithinTarget(s, { type: 'click', target: 'Save' })).not.toThrow();
  });
  it('blocks cross-origin navigation even in dry-run', () => {
    const s = { targetUrl: 'https://10.80.1.9/console' };
    expect(() => assertNavigationWithinTarget(s, { type: 'navigate', target: 'https://evil.example/x' })).toThrow(/outside the session origin/);
  });
  it('blocks navigate without a session targetUrl', () => {
    expect(() => assertNavigationWithinTarget({}, { type: 'navigate', target: 'https://10.80.1.9/' })).toThrow(/targetUrl/);
  });
});
