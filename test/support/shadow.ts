import type { LitElement } from 'lit';

/** The element in a component's shadow root that matches `selector`; throws when there is none. */
export function find<T extends Element = HTMLElement>(host: LitElement, selector: string): T
{
    const found = host.shadowRoot?.querySelector<T>(selector);
    if (!found) throw new Error(`<${host.localName}> shows no ${selector}.`);
    return found;
}

/** Every element in a component's shadow root that matches `selector`. */
export function findAll<T extends Element = HTMLElement>(host: LitElement, selector: string): T[]
{
    return Array.from(host.shadowRoot?.querySelectorAll<T>(selector) ?? []);
}

/** The button in a component's shadow root whose text is `text`; throws when there is none. */
export function button(host: LitElement, text: string): HTMLButtonElement
{
    const buttons = Array.from(host.shadowRoot?.querySelectorAll('button') ?? []);
    const found = buttons.find(candidate => candidate.textContent?.trim() === text);
    if (!found) throw new Error(`<${host.localName}> shows no "${text}" button, only ${buttons.map(b => `"${b.textContent?.trim()}"`).join(', ')}.`);
    return found;
}

/** Everything a component shows, as one line of text. */
export function textOf(host: LitElement): string
{
    return (host.shadowRoot?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Types into a field the way a user does, and waits for the component to render. */
export async function type(host: LitElement, selector: string, value: string): Promise<void>
{
    const field = find<HTMLInputElement | HTMLTextAreaElement>(host, selector);
    field.value = value;
    field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    await host.updateComplete;
}

/** Ticks a checkbox the way a user does, and waits for the component to render. */
export async function tick(host: LitElement, selector: string): Promise<void>
{
    find<HTMLInputElement>(host, selector).click();
    await host.updateComplete;
}

/** Clicks a button by its text, and waits for the component to render. */
export async function press(host: LitElement, text: string): Promise<void>
{
    button(host, text).click();
    await host.updateComplete;
}
