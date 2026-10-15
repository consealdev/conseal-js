import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { SetupResult } from '../sync/circle-client.js';
import type { DeviceMeta } from '../sync/circle-transport.js';
import { CircleElement } from './ceremony-element.js';
import { errorText, isServerCode } from './error-text.js';
import { newPassphraseFields, newPassphraseProblem } from './new-passphrase.js';

/** What `setup-done` carries: pass `mnemonic` to `<conseal-phrase>`, and never store it. */
export type SetupDoneDetail = SetupResult;

/**
 * Creates the user's circle with this as its first device: the user chooses a passphrase, and the device unlocks.
 * Show `<conseal-phrase>` with the mnemonic next.
 *
 * @fires setup-done - the circle exists and this device is unlocked; `detail` is a `SetupDoneDetail`
 */
@customElement('conseal-setup')
export class ConsealSetup extends CircleElement
{
    /** The shortest passphrase the user may choose. */
    @property({ type: Number, attribute: 'min-passphrase-length' }) minPassphraseLength = 12;

    /** What this device calls itself in the device list. */
    @property({ attribute: false }) deviceMeta: DeviceMeta = {};

    @state() private _passphrase = '';
    @state() private _confirmation = '';
    @state() private _error = '';
    @state() private _busy = false;

    override render(): TemplateResult
    {
        const problem = newPassphraseProblem(this._passphrase, this._confirmation, this.minPassphraseLength);
        return html`
            <div class="card stack loose">
                <div class="stack tight">
                    <div class="heading">Create your passphrase</div>
                    <div class="sub">
                        This passphrase encrypts all your data, and not even ${this.appName} can read it. Choose
                        something strong you'll remember: without it, only your recovery phrase gets you back in.
                    </div>
                </div>

                <div class="stack">
                    ${newPassphraseFields({
                        passphrase: this._passphrase,
                        confirmation: this._confirmation,
                        minLength: this.minPassphraseLength,
                        onPassphrase: this._onPassphraseInput,
                        onConfirmation: this._onConfirmationInput,
                        onKeydown: this._onKeydown,
                    })}
                    ${this._error
                        ? html`
                            <div class="error">${this._error}</div>
                        `
                        : nothing
                    }
                    <button class="primary" ?disabled=${this._busy || problem !== undefined} @click=${this._onCreate}>
                        ${this._busy ? 'Creating…' : 'Create passphrase'}
                    </button>
                </div>
            </div>
        `;
    }

    private _onPassphraseInput(event: InputEvent): void
    {
        this._passphrase = (event.target as HTMLInputElement).value;
    }

    private _onConfirmationInput(event: InputEvent): void
    {
        this._confirmation = (event.target as HTMLInputElement).value;
    }

    private _onKeydown(event: KeyboardEvent): void
    {
        if (event.key === 'Enter') void this._onCreate();
    }

    private async _onCreate(): Promise<void>
    {
        const circle = this.circle;
        const problem = newPassphraseProblem(this._passphrase, this._confirmation, this.minPassphraseLength);
        if (circle === undefined || this._busy) return;
        if (problem !== undefined)
        {
            this._error = problem;
            return;
        }

        this._busy = true;
        this._error = '';
        try
        {
            const result = await circle.setup(this._passphrase, this.deviceMeta);
            this._passphrase = '';
            this._confirmation = '';
            this.fire<SetupDoneDetail>('setup-done', result);
        }
        catch (error)
        {
            this._error = isServerCode(error, 'circle_exists')
                ? 'This account already has a circle. Unlock this device, or add it from one that\'s in the circle.'
                : errorText(error, 'The circle couldn\'t be created. Try again.');
        }
        finally
        {
            this._busy = false;
        }
    }
}

declare global
{
    interface HTMLElementTagNameMap
    {
        'conseal-setup': ConsealSetup;
    }
}
