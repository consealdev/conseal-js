import { css, html, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { CeremonyElement } from './ceremony-element.js';
import { ceremonyStyles } from './ceremony-styles.js';

const COPY_LABELS = { idle: 'Copy phrase', copied: 'Copied', failed: 'Copying failed: write the words down instead' };

/**
 * Shows the recovery phrase `<conseal-setup>` reported, once, and asks the user to confirm they wrote it down. When
 * they do, it forgets the phrase and fires `phrase-confirmed`.
 *
 * @fires phrase-confirmed - the user wrote the phrase down
 */
@customElement('conseal-phrase')
export class ConsealPhrase extends CeremonyElement
{
    static override styles = [ceremonyStyles, css`
        .card { max-width: 500px; }
        .words { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 0; padding: 0; list-style: none; }
        .words li {
            display: flex;
            gap: 6px;
            padding: 6px 8px;
            font-size: 0.8rem;
            border: 1px solid var(--color-border, #e2e8f0);
            border-radius: var(--radius-sm, 6px);
        }
        .number { min-width: 18px; font-size: 0.7rem; color: var(--color-muted, #94a3b8); }
        .word { font-family: monospace; font-weight: 500; }
    `];

    /** The 24 words. A property only, never an attribute, so the phrase stays out of the page's markup. */
    @property({ attribute: false }) mnemonic = '';

    @state() private _confirmed = false;
    @state() private _copy: keyof typeof COPY_LABELS = 'idle';

    private _copyReset: ReturnType<typeof setTimeout> | undefined;

    override disconnectedCallback(): void
    {
        super.disconnectedCallback();
        clearTimeout(this._copyReset);
    }

    override render(): TemplateResult
    {
        const words = this.mnemonic.split(/\s+/).filter(Boolean);
        return html`
            <div class="card stack loose">
                <div class="stack tight">
                    <div class="heading">Your recovery phrase</div>
                    <div class="sub">It's the only way back into your account if you forget your passphrase.</div>
                </div>

                <div class="warning">
                    Write these words down and keep them somewhere safe: ${this.appName} will never show them again.
                </div>

                <ol class="words">
                    ${words.map((word, index) => html`
                        <li><span class="number">${index + 1}.</span><span class="word">${word}</span></li>
                    `)}
                </ol>

                <button class="secondary" @click=${this._onCopy}>${COPY_LABELS[this._copy]}</button>

                <label class="check">
                    <input type="checkbox" .checked=${this._confirmed} @change=${this._onConfirmedChange} />
                    I've written down my recovery phrase and stored it safely.
                </label>

                <button class="primary" ?disabled=${!this._confirmed} @click=${this._onContinue}>Continue</button>
            </div>
        `;
    }

    private async _onCopy(): Promise<void>
    {
        clearTimeout(this._copyReset);
        try
        {
            await navigator.clipboard.writeText(this.mnemonic);
            this._copy = 'copied';
        }
        catch (error)
        {
            // The clipboard can refuse, outside a secure context or without permission: the words are on screen.
            if (!(error instanceof DOMException) && !(error instanceof TypeError)) throw error;
            this._copy = 'failed';
        }
        this._copyReset = setTimeout(() => {
            this._copy = 'idle';
        }, 2000);
    }

    private _onConfirmedChange(event: Event): void
    {
        this._confirmed = (event.target as HTMLInputElement).checked;
    }

    private _onContinue(): void
    {
        this.mnemonic = '';
        this.fire('phrase-confirmed');
    }
}

declare global
{
    interface HTMLElementTagNameMap
    {
        'conseal-phrase': ConsealPhrase;
    }
}
