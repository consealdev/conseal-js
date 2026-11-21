// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { html, nothing, type TemplateResult } from 'lit';
import { classMap } from 'lit/directives/class-map.js';

const STRENGTH_LABELS = ['', 'Weak', 'Fair', 'Strong', 'Very strong'];

/** How strong a new passphrase is: 0 when it's shorter than the minimum, then 1 (weak) to 4 (very strong). */
export function passphraseStrength(passphrase: string, minLength: number): number
{
    if (passphrase.length < minLength) return 0;
    const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(kind => kind.test(passphrase)).length;
    if (passphrase.length >= 20 && kinds >= 3) return 4;
    if (kinds >= 3) return 3;
    return kinds >= 2 ? 2 : 1;
}

/** What stops a new passphrase from being used, or undefined when nothing does. */
export function newPassphraseProblem(passphrase: string, confirmation: string, minLength: number): string | undefined
{
    if (passphrase.length < minLength) return `Use at least ${minLength} characters.`;
    if (passphraseStrength(passphrase, minLength) < 2) return 'Too weak: mix upper and lower case letters, numbers or symbols.';
    if (passphrase !== confirmation) return 'The passphrases don\'t match.';
    return undefined;
}

export interface NewPassphraseFields
{
    passphrase: string;
    confirmation: string;
    minLength: number;
    onPassphrase: (event: InputEvent) => void;
    onConfirmation: (event: InputEvent) => void;
    onKeydown: (event: KeyboardEvent) => void;
}

/** The two fields that choose a new passphrase, with its strength under the first. The host keeps their values. */
export function newPassphraseFields(fields: NewPassphraseFields): TemplateResult
{
    const strength = passphraseStrength(fields.passphrase, fields.minLength);
    const tooShort = fields.passphrase.length > 0 && fields.passphrase.length < fields.minLength;
    const mismatch = fields.confirmation.length > 0 && fields.confirmation !== fields.passphrase;
    return html`
        <div>
            <label for="new-passphrase">Passphrase</label>
            <input
                id="new-passphrase"
                type="password"
                autocomplete="new-password"
                placeholder=${`At least ${fields.minLength} characters`}
                .value=${fields.passphrase}
                @input=${fields.onPassphrase}
                @keydown=${fields.onKeydown}
            />
            ${fields.passphrase.length > 0
                ? html`
                    <div class="strength">
                        ${[1, 2, 3, 4].map(level => html`
                            <span class=${classMap({ [`level-${strength}`]: strength >= level })}></span>
                        `)}
                    </div>
                    <div class="hint">${tooShort ? `Too short: at least ${fields.minLength} characters` : STRENGTH_LABELS[strength]}</div>
                `
                : nothing
            }
        </div>
        <div>
            <label for="confirm-passphrase">Confirm passphrase</label>
            <input
                id="confirm-passphrase"
                type="password"
                autocomplete="new-password"
                placeholder="The same passphrase again"
                .value=${fields.confirmation}
                @input=${fields.onConfirmation}
                @keydown=${fields.onKeydown}
            />
            ${mismatch
                ? html`
                    <div class="error">The passphrases don't match.</div>
                `
                : nothing
            }
        </div>
    `;
}
