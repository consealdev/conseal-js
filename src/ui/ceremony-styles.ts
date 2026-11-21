// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { css } from 'lit';

/**
 * The look the ceremony components share. Colors, radii and the card's padding come from the custom properties of
 * the theming contract (see the README), each with a fallback, so a component is fully styled with no setup. Layout is
 * the component's own: it sits in a shadow root, where a page's layout classes don't reach.
 */
export const ceremonyStyles = css`
    :host {
        display: block;
        color: var(--color-text, #1e293b);
        font-size: 0.9rem;
        line-height: 1.4;
    }

    .card {
        box-sizing: border-box;
        width: 100%;
        max-width: 440px;
        margin: 0 auto;
        padding: var(--space-8, 32px);
        background: var(--color-surface, #fff);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: var(--radius-lg, 12px);
    }

    .stack { display: flex; flex-direction: column; gap: 12px; }
    .stack.tight { gap: 4px; }
    /* Holds a verification code, which sizes itself to this box's width (see .code). */
    .codebox { container-type: inline-size; }
    .stack.loose { gap: 20px; }

    .heading { font-size: 1.25rem; font-weight: 700; }
    .sub { font-size: 0.85rem; color: var(--color-muted, #64748b); }
    .hint { font-size: 0.78rem; color: var(--color-muted, #64748b); }
    .status { font-size: 0.9rem; text-align: center; color: var(--color-muted, #64748b); }
    .error { font-size: 0.8rem; color: var(--color-danger, #ef4444); }

    .warning {
        padding: 10px 12px;
        font-size: 0.82rem;
        color: var(--color-notice-text, #92400e);
        background: var(--color-notice-bg, #fef3c7);
        border: 1px solid var(--color-notice-border, #fbbf24);
        border-radius: var(--radius-sm, 6px);
    }

    label { display: block; margin-bottom: 4px; font-size: 0.75rem; font-weight: 600; color: var(--color-muted, #64748b); }
    label.check { display: flex; align-items: flex-start; gap: 8px; margin: 0; font-size: 0.85rem; font-weight: 400; color: inherit; cursor: pointer; }
    label.check input { width: auto; margin-top: 2px; flex-shrink: 0; }

    input, textarea {
        box-sizing: border-box;
        width: 100%;
        padding: 9px 10px;
        font: inherit;
        font-size: 0.875rem;
        color: inherit;
        background: var(--color-surface, #fff);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: var(--radius-sm, 6px);
    }
    textarea { min-height: 96px; font-family: monospace; font-size: 0.8rem; resize: vertical; }
    input:focus, textarea:focus, button:focus-visible { outline: 2px solid var(--color-focus, #6366f1); outline-offset: 1px; }

    button {
        box-sizing: border-box;
        padding: 10px 16px;
        font: inherit;
        font-size: 0.9rem;
        font-weight: 500;
        border: 1px solid transparent;
        border-radius: var(--radius-sm, 6px);
        cursor: pointer;
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .primary { width: 100%; color: var(--color-primary-text, #fff); background: var(--color-primary, #6366f1); }
    .secondary { width: 100%; color: inherit; background: var(--color-border, #e2e8f0); border-color: var(--color-border, #e2e8f0); }
    .secondary:hover:not(:disabled) { background: var(--color-border-hover, #cbd5e1); }
    .danger { width: 100%; color: var(--color-danger-text, #fff); background: var(--color-danger, #ef4444); }
    .warn { width: 100%; color: var(--color-warning-text, #fff); background: var(--color-warning, #ea580c); }
    .link { padding: 0; font-size: 0.82rem; color: var(--color-link, var(--color-primary, #6366f1)); background: none; }
    .small { width: auto; padding: 5px 10px; font-size: 0.8rem; }

    /*
     * The verification code: the one line the user must compare, so nothing about it is configurable. It stays on one
     * line, because a code that wraps in the middle is harder to read out. It is 19 characters, about 13.3em wide at this
     * letter spacing, so its size is the width of its box (.codebox) less its own padding and border, over 13.5, up to 1.5rem.
     */
    .code {
        padding: 12px;
        font-family: monospace;
        font-size: min(1.5rem, calc((100cqw - 28px) / 13.5));
        white-space: nowrap;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-align: center;
        background: var(--color-bg, #f8fafc);
        border: 2px solid var(--color-primary, #6366f1);
        border-radius: var(--radius-sm, 6px);
    }

    .strength { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 6px; }
    .strength span { height: 4px; border-radius: 2px; background: var(--color-border, #e2e8f0); }
    .strength .level-1 { background: #ef4444; }
    .strength .level-2 { background: #f97316; }
    .strength .level-3 { background: #eab308; }
    .strength .level-4 { background: #22c55e; }
`;
