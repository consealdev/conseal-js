import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { CircleClient } from '../sync/circle-client.js';
import type { DeviceMeta } from '../sync/circle-transport.js';
import { CommitmentMismatchError, DeviceNotRegisteredError, SyncTransportError, WrongPassphraseError } from '../sync/errors.js';
import { CircleElement } from './ceremony-element.js';
import { errorText } from './error-text.js';
import { newPassphraseFields, newPassphraseProblem } from './new-passphrase.js';

/** What `unlock-done` carries: whether the device unlocked with its passphrase or was recovered from the phrase. */
export type UnlockDoneDetail =
    | { recovered: false }
    | { recovered: true; deviceId: string; aekCommitment: string };

type Mode = 'checking' | 'passphrase' | 'recovery' | 'choice';

/**
 * Unlocks this device with its passphrase. A device the circle doesn't know is offered the two ways in: joining from
 * another device, which the app shows with `<conseal-join>`, or recovering from the recovery phrase, here. A
 * recovery removes the circle's other devices, since they may be lost.
 *
 * @fires unlock-done - this device is unlocked; `detail` is an `UnlockDoneDetail`
 * @fires needs-join - the user chose to add this device from another one: show `<conseal-join>`
 */
@customElement('conseal-unlock')
export class ConsealUnlock extends CircleElement
{
    /** The shortest new passphrase a recovery may choose. */
    @property({ type: Number, attribute: 'min-passphrase-length' }) minPassphraseLength = 12;

    /** What this device calls itself in the device list, after a recovery. */
    @property({ attribute: false }) deviceMeta: DeviceMeta = {};

    @state() private _mode: Mode = 'checking';
    @state() private _passphrase = '';
    @state() private _mnemonic = '';
    @state() private _newPassphrase = '';
    @state() private _confirmation = '';
    @state() private _error = '';
    @state() private _busy = false;

    protected override async start(circle: CircleClient): Promise<void>
    {
        try
        {
            // A device with no keys, or one the server no longer knows, has to join or recover.
            const registered = await circle.status() !== 'unregistered' && await circle.isRegistered();
            this._mode = registered ? 'passphrase' : 'choice';
        }
        catch (error)
        {
            // Offline, or the server failed: let the user try the passphrase, which reports the problem.
            if (!(error instanceof SyncTransportError) && !(error instanceof TypeError)) throw error;
            this._mode = 'passphrase';
        }
    }

    override render(): TemplateResult
    {
        switch (this._mode)
        {
            case 'checking':
                return html`<div class="card"><div class="status">Checking this device…</div></div>`;
            case 'choice':
                return this._renderChoice();
            case 'recovery':
                return this._renderRecovery();
            case 'passphrase':
                return this._renderPassphrase();
        }
    }

    private _renderChoice(): TemplateResult
    {
        return html`
            <div class="card stack loose">
                <div class="stack tight">
                    <div class="heading">This device isn't in your circle</div>
                    <div class="sub">
                        Add it from a device that is, or use your recovery phrase if you've lost all your devices.
                    </div>
                </div>
                <div class="stack">
                    <button class="primary" @click=${this._onChooseJoin}>Add this device from another one</button>
                    <button class="warn" @click=${this._onChooseRecovery}>I've lost all my devices: use my recovery phrase</button>
                </div>
            </div>
        `;
    }

    private _renderPassphrase(): TemplateResult
    {
        return html`
            <div class="card stack loose">
                <div class="stack tight">
                    <div class="heading">Welcome back</div>
                    <div class="sub">Enter your passphrase to unlock ${this.appName} on this device.</div>
                </div>
                <div class="stack">
                    <div>
                        <label for="passphrase">Passphrase</label>
                        <input
                            id="passphrase"
                            type="password"
                            autocomplete="current-password"
                            .value=${this._passphrase}
                            @input=${this._onPassphraseInput}
                            @keydown=${this._onPassphraseKeydown}
                        />
                    </div>
                    ${this._renderError()}
                    <button class="primary" ?disabled=${this._busy || this._passphrase.length === 0} @click=${this._onUnlock}>
                        ${this._busy ? 'Unlocking…' : 'Unlock'}
                    </button>
                    <button class="link" @click=${this._onChooseRecovery}>Forgot your passphrase? Use your recovery phrase</button>
                </div>
            </div>
        `;
    }

    private _renderRecovery(): TemplateResult
    {
        const problem = newPassphraseProblem(this._newPassphrase, this._confirmation, this.minPassphraseLength);
        return html`
            <div class="card stack loose">
                <div class="stack tight">
                    <div class="heading">Recover your account</div>
                    <div class="sub">Enter your 24-word recovery phrase, and choose a new passphrase for this device.</div>
                </div>
                <div class="warning">
                    Recovering removes your other devices from your circle, in case they're lost. Add them again
                    afterwards.
                </div>
                <div class="stack">
                    <div>
                        <label for="mnemonic">Recovery phrase</label>
                        <textarea
                            id="mnemonic"
                            autocomplete="off"
                            spellcheck="false"
                            .value=${this._mnemonic}
                            @input=${this._onMnemonicInput}
                        ></textarea>
                    </div>
                    ${newPassphraseFields({
                        passphrase: this._newPassphrase,
                        confirmation: this._confirmation,
                        minLength: this.minPassphraseLength,
                        onPassphrase: this._onNewPassphraseInput,
                        onConfirmation: this._onConfirmationInput,
                        onKeydown: this._onRecoveryKeydown,
                    })}
                    ${this._renderError()}
                    <button
                        class="primary"
                        ?disabled=${this._busy || this._mnemonic.trim().length === 0 || problem !== undefined}
                        @click=${this._onRecover}
                    >
                        ${this._busy ? 'Recovering…' : 'Recover'}
                    </button>
                    <button class="link" @click=${this._onBackToPassphrase}>Back to the passphrase</button>
                </div>
            </div>
        `;
    }

    private _renderError(): TemplateResult | typeof nothing
    {
        return this._error
            ? html`
                <div class="error">${this._error}</div>
            `
            : nothing;
    }

    private _onPassphraseInput(event: InputEvent): void
    {
        this._passphrase = (event.target as HTMLInputElement).value;
    }

    private _onMnemonicInput(event: InputEvent): void
    {
        this._mnemonic = (event.target as HTMLTextAreaElement).value;
    }

    private _onNewPassphraseInput(event: InputEvent): void
    {
        this._newPassphrase = (event.target as HTMLInputElement).value;
    }

    private _onConfirmationInput(event: InputEvent): void
    {
        this._confirmation = (event.target as HTMLInputElement).value;
    }

    private _onPassphraseKeydown(event: KeyboardEvent): void
    {
        if (event.key === 'Enter') void this._onUnlock();
    }

    private _onRecoveryKeydown(event: KeyboardEvent): void
    {
        if (event.key === 'Enter') void this._onRecover();
    }

    private _onChooseJoin(): void
    {
        this.fire('needs-join');
    }

    private _onChooseRecovery(): void
    {
        this._error = '';
        this._mode = 'recovery';
    }

    private _onBackToPassphrase(): void
    {
        this._error = '';
        this._mode = 'passphrase';
    }

    private async _onUnlock(): Promise<void>
    {
        const circle = this.circle;
        if (circle === undefined || this._busy || this._passphrase.length === 0) return;

        this._busy = true;
        this._error = '';
        try
        {
            // Fetches this device's wrapped AEK from the server when the local copy is gone.
            await circle.unlock(this._passphrase);
            this._passphrase = '';
            this.fire<UnlockDoneDetail>('unlock-done', { recovered: false });
        }
        catch (error)
        {
            this._passphrase = '';
            if (error instanceof DeviceNotRegisteredError) this._mode = 'choice';
            else if (error instanceof WrongPassphraseError) this._error = 'Wrong passphrase. Check it and try again.';
            else this._error = errorText(error, 'This device couldn\'t be unlocked. Try again.');
        }
        finally
        {
            this._busy = false;
        }
    }

    private async _onRecover(): Promise<void>
    {
        const circle = this.circle;
        const problem = newPassphraseProblem(this._newPassphrase, this._confirmation, this.minPassphraseLength);
        if (circle === undefined || this._busy || this._mnemonic.trim().length === 0) return;
        if (problem !== undefined)
        {
            this._error = problem;
            return;
        }

        this._busy = true;
        this._error = '';
        try
        {
            // Checks the phrase against the account's commitment before this device is registered.
            const { deviceId, aekCommitment } = await circle.recover(this._mnemonic.trim(), this._newPassphrase, {
                deviceMeta: this.deviceMeta,
                revokeOtherDevices: true,
            });
            this._mnemonic = '';
            this._newPassphrase = '';
            this._confirmation = '';
            this.fire<UnlockDoneDetail>('unlock-done', { recovered: true, deviceId, aekCommitment });
        }
        catch (error)
        {
            if (error instanceof CommitmentMismatchError)
            {
                this._error = 'This recovery phrase doesn\'t belong to your account. Check the words and try again.';
            }
            else if (error instanceof SyncTransportError || error instanceof TypeError)
            {
                this._error = errorText(error, 'Recovery failed. Try again.');
            }
            else
            {
                // conseal refuses a phrase with a word that isn't on its list, or one that fails the BIP-39 checksum.
                this._error = 'That isn\'t a valid recovery phrase. Check the words and try again.';
            }
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
        'conseal-unlock': ConsealUnlock;
    }
}
