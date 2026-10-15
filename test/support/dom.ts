// What the components' tests need from a page: an element rendered into it, an event to wait for, and a condition
// to wait on. Each rendered element is removed after its test.
import { html, render, type TemplateResult } from 'lit';
import { afterEach, vi } from 'vitest';

export { html };

const containers: HTMLElement[] = [];

afterEach(() => {
    for (const container of containers.splice(0)) container.remove();
});

/** Renders `template` into the page and returns its element, once the element has rendered. */
export async function fixture<T extends Element>(template: TemplateResult): Promise<T>
{
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    render(template, container);
    const element = container.firstElementChild as T;
    await (element as { updateComplete?: Promise<unknown> }).updateComplete;
    return element;
}

/** The next `type` event `target` fires. */
export function oneEvent(target: EventTarget, type: string): Promise<Event>
{
    return new Promise(resolve => target.addEventListener(type, resolve, { once: true }));
}

/**
 * Waits until `condition` holds, and fails with `message` if it doesn't within 10 seconds. Unlocking and approving
 * run PBKDF2, which takes seconds when three browsers run the tests at once.
 */
export async function waitUntil(condition: () => unknown, message: string): Promise<void>
{
    try
    {
        await vi.waitUntil(condition, { timeout: 10_000, interval: 50 });
    }
    catch
    {
        throw new Error(message);
    }
}
