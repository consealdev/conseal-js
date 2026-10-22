import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { CircleClient } from '../sync/circle-client.js';
import type { DeviceMeta } from '../sync/circle-transport.js';
import { WrongPassphraseError } from '../sync/errors.js';
import type { JoinSession, JoinState } from '../sync/join-session.js';
import { CircleElement } from './ceremony-element.js';
import { errorText } from './error-text.js';

/** What `join-done` carries: the id this device has in the circle. */
export interface JoinDoneDetail
{
    deviceId: string;
}

type Scene = 'starting' | 'waiting' | 'passphrase' | 'finishing' | 'done' | 'expired' | 'denied' | 'failed' | 'unsent';

/**
 * Adds this device to the circle from another one. It posts a join request and shows its verification code, which
 * the user compares on the approving device's `<conseal-approve-join>`, and asks for the passphrase once approved.
 * It asks the server for the answer every `poll-interval` milliseconds while it's on the page.
 *
 * @fires join-done - this device is in the circle and unlocked; `detail` is a `JoinDoneDetail`
 */
@customElement('conseal-join')
export class ConsealJoin extends CircleElement
{
    /** How often to ask whether the request was approved, in milliseconds. */
    @property({ type: Number, attribute: 'poll-interval' }) pollInterval = 3000;

    /** What this device calls itself in the request and the device list. */
    @property({ attribute: false }) deviceMeta: DeviceMeta = {};

    @state() private _scene: Scene = 'starting';
    @state() private _code = '';
    @state() private _passphrase = '';
    @state() private _error = '';
    @state() private _busy = false;

    private _session: JoinSession | undefined;
    private _unsubscribe: (() => void) | undefined;
    private _poll: ReturnType<typeof setInterval> | undefined;
    private _checking = false;

    override connectedCallback(): void
    {
        super.connectedCallback();
        if (this._scene === 'waiting') this._startPolling();
    }

    override disconnectedCallback(): void
    {
        super.disconnectedCallback();
        this._stopPolling();
    }

    protected override start(circle: CircleClient): Promise<void>
    {
        return this._startJoin(circle);
    }

    override render(): TemplateResult
    {
        switch (this._scene)
        {
            case 'starting':
                return html`<div class="card"><div class="status">Asking to join…</div></div>`;
            case 'waiting':
                return this._renderWaiting();
            case 'passphrase':
                return this._renderPassphrase();
            case 'finishing':
                return html`<div class="card"><div class="status">Adding this device…</div></div>`;
            case 'done':
                return this._renderEnd('Device added', 'This device is in your circle and unlocked.', false);
            case 'expired':
                return this._renderEnd('The request expired', 'It has to be approved within five minutes. Start again for a new code.', true);
            case 'denied':
                return this._renderEnd('The request was denied', 'Your other device turned it down.', true);
            case 'failed':
                return this._renderEnd(
                    'This device didn\'t join',
                    'The key this device received couldn\'t be shown to come from your other device, so it wasn\'t taken. '
                    + 'Someone may be interfering with the request. Start again, and check that the codes match.',
                    true);
            case 'unsent':
                return this._renderEnd('The request wasn\'t sent', this._error, true);
        }
    }

    private _renderWaiting(): TemplateResult
    {
        return html`
            <div class="card stack loose">
                <div class="stack tight">
                    <div class="heading">Approve this device</div>
                    <div class="sub">Open ${this.appName} on a device that's already in your circle, and approve this request there.</div>
                </div>
                <div class="stack tight codebox">
                    <div class="hint">Check that it shows the same code:</div>
                    <div class="code">${this._code}</div>
                </div>
                <div class="status">Waiting for approval…</div>
                ${this._renderError()}
                <button class="secondary" @click=${this._onCheckNow}>Check now</button>
            </div>
        `;
    }

    private _renderPassphrase(): TemplateResult
    {
        return html`
            <div class="card stack loose">
                <div class="stack tight">
                    <div class="heading">Approved</div>
                    <div class="sub">Enter the passphrase you use on your other devices.</div>
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
                    <button class="primary" ?disabled=${this._busy || this._passphrase.length === 0} @click=${this._onFinish}>
                        Finish
                    </button>
                </div>
            </div>
        `;
    }

    private _renderEnd(heading: string, text: string, again: boolean): TemplateResult
    {
        return html`
            <div class="card stack loose">
                <div class="stack tight">
                    <div class="heading">${heading}</div>
                    <div class="sub">${text}</div>
                </div>
                ${again
                    ? html`
                        <button class="primary" @click=${this._onStartAgain}>Start again</button>
                    `
                    : nothing
                }
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

    private async _startJoin(circle: CircleClient): Promise<void>
    {
        this._stopPolling();
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        this._session = undefined;
        this._scene = 'starting';
        this._error = '';
        try
        {
            const session = await circle.startJoin(this.deviceMeta);
            this._session = session;
            this._unsubscribe = session.subscribe(state => this._onState(state));
        }
        catch (error)
        {
            this._error = errorText(error, 'Something went wrong. Start again.');
            this._scene = 'unsent';
        }
    }

    private _onState(state: JoinState): void
    {
        switch (state.scene)
        {
            case 'waiting':
                this._code = state.verificationCode;
                this._scene = 'waiting';
                this._startPolling();
                break;
            case 'authorized':
                this._stopPolling();
                this._scene = 'passphrase';
                break;
            case 'finalizing':
                this._scene = 'finishing';
                break;
            case 'done':
                this._stopPolling();
                this._scene = 'done';
                this.fire<JoinDoneDetail>('join-done', { deviceId: state.deviceId });
                break;
            case 'expired':
            case 'denied':
            case 'failed':
                this._stopPolling();
                this._scene = state.scene;
                break;
        }
    }

    private _startPolling(): void
    {
        if (this._poll !== undefined || !this.isConnected) return;
        this._poll = setInterval(() => void this._check(), this.pollInterval);
    }

    private _stopPolling(): void
    {
        clearInterval(this._poll);
        this._poll = undefined;
    }

    private async _check(): Promise<void>
    {
        const session = this._session;
        if (session === undefined || this._checking) return;
        this._checking = true;
        try
        {
            await session.check();
            this._error = '';
        }
        catch (error)
        {
            this._error = errorText(error, 'The request couldn\'t be checked. Still trying.');
        }
        finally
        {
            this._checking = false;
        }
    }

    private _onCheckNow(): void
    {
        void this._check();
    }

    private _onPassphraseInput(event: InputEvent): void
    {
        this._passphrase = (event.target as HTMLInputElement).value;
    }

    private _onPassphraseKeydown(event: KeyboardEvent): void
    {
        if (event.key === 'Enter') void this._onFinish();
    }

    private async _onFinish(): Promise<void>
    {
        const session = this._session;
        if (session === undefined || this._busy || this._passphrase.length === 0) return;

        const passphrase = this._passphrase;
        this._passphrase = '';
        this._busy = true;
        this._error = '';
        try
        {
            await session.finish(passphrase);
        }
        catch (error)
        {
            // A join that can't go on reports itself through its state; one that can stays approved.
            if (error instanceof WrongPassphraseError)
            {
                this._error = 'That isn\'t the passphrase your other devices use. Try again.';
            }
            else if (session.state.scene === 'authorized')
            {
                this._error = errorText(error, 'This device couldn\'t be added. Try again.');
            }
        }
        finally
        {
            this._busy = false;
        }
    }

    private _onStartAgain(): void
    {
        if (this.circle !== undefined) void this._startJoin(this.circle);
    }
}

declare global
{
    interface HTMLElementTagNameMap
    {
        'conseal-join': ConsealJoin;
    }
}
