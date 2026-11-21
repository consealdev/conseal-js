// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { CircleClient, PendingJoin } from '../sync/circle-client.js';
import { JoinExpiredError, WrongPassphraseError } from '../sync/errors.js';
import { CircleElement } from './ceremony-element.js';
import { errorText, isServerCode } from './error-text.js';

/** What `approve-done` carries: the id of the device that can now finish joining. */
export interface ApproveDoneDetail
{
    deviceId: string;
}

/**
 * Approves or denies a new device's join request, on a device that's in the circle. It shows the request's
 * verification code, and approves only once the user confirms it matches the code on the new device: that comparison
 * is the ceremony's defence against someone posting a request of their own.
 *
 * @fires approve-done - the request is approved, and the new device can finish; `detail` is an `ApproveDoneDetail`
 * @fires deny-done - the request is denied
 */
@customElement('conseal-approve-join')
export class ConsealApproveJoin extends CircleElement
{
    @state() private _joins: PendingJoin[] = [];
    @state() private _loading = true;
    @state() private _codeConfirmed = false;
    @state() private _passphrase = '';
    @state() private _error = '';
    @state() private _busy = false;

    /** Asks the server again for the requests waiting. */
    public async reload(): Promise<void>
    {
        const circle = this.circle;
        if (circle === undefined) return;
        this._loading = true;
        this._error = '';
        try
        {
            this._joins = await circle.pendingJoins();
        }
        catch (error)
        {
            this._error = errorText(error, 'The requests couldn\'t be loaded. Try again.');
        }
        finally
        {
            this._loading = false;
        }
    }

    protected override start(_circle: CircleClient): Promise<void>
    {
        return this.reload();
    }

    override render(): TemplateResult
    {
        const join = this._joins[0];
        if (this._loading) return html`<div class="card"><div class="status">Looking for requests…</div></div>`;
        if (join === undefined) return this._renderNone();

        const name = join.request.deviceMeta?.name ?? 'Unknown device';
        const platform = join.request.deviceMeta?.platform ?? 'Unknown';
        return html`
            <div class="card stack loose">
                <div class="stack tight">
                    <div class="heading">A new device wants to join</div>
                    <div class="sub">
                        Check this request carefully before you approve it.
                        ${this._joins.length > 1 ? `${this._joins.length} requests are waiting.` : nothing}
                    </div>
                </div>
                <div class="sub">
                    <strong>Device:</strong> ${name}<br />
                    <strong>Platform:</strong> ${platform}<br />
                    <strong>Asked at:</strong> ${new Date(join.receivedAt).toLocaleTimeString()}
                </div>
                <div class="stack tight codebox">
                    <div class="hint">The new device should show this code:</div>
                    <div class="code">${join.verificationCode}</div>
                </div>
                <div class="warning">
                    Only approve a device you recognise, and only if its code matches exactly. A different code means
                    someone may be intercepting the request.
                </div>
                <div class="stack">
                    <label class="check">
                        <input type="checkbox" .checked=${this._codeConfirmed} @change=${this._onCodeConfirmedChange} />
                        The code matches the one on the new device
                    </label>
                    <div>
                        <label for="passphrase">Your passphrase</label>
                        <input
                            id="passphrase"
                            type="password"
                            autocomplete="current-password"
                            .value=${this._passphrase}
                            @input=${this._onPassphraseInput}
                        />
                    </div>
                    ${this._renderError()}
                    <button
                        class="primary"
                        ?disabled=${this._busy || !this._codeConfirmed || this._passphrase.length === 0}
                        @click=${this._onApprove}
                    >
                        ${this._busy ? 'Approving…' : 'Approve'}
                    </button>
                    <button class="danger" ?disabled=${this._busy} @click=${this._onDeny}>Deny</button>
                </div>
            </div>
        `;
    }

    private _renderNone(): TemplateResult
    {
        return html`
            <div class="card stack loose">
                <div class="stack tight">
                    <div class="heading">No requests waiting</div>
                    <div class="sub">When a new device asks to join your circle, its request shows here.</div>
                </div>
                ${this._renderError()}
                <button class="secondary" @click=${this._onCheckAgain}>Check again</button>
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

    private _onCodeConfirmedChange(event: Event): void
    {
        this._codeConfirmed = (event.target as HTMLInputElement).checked;
    }

    private _onPassphraseInput(event: InputEvent): void
    {
        this._passphrase = (event.target as HTMLInputElement).value;
    }

    private _onCheckAgain(): void
    {
        void this.reload();
    }

    private async _onApprove(): Promise<void>
    {
        const circle = this.circle;
        const join = this._joins[0];
        if (circle === undefined || join === undefined || this._busy || !this._codeConfirmed) return;

        const passphrase = this._passphrase;
        this._passphrase = '';
        this._busy = true;
        this._error = '';
        try
        {
            // The user ticked that the codes match: only then does the AEK leave this device, sealed to the request.
            await circle.approveJoin(join, passphrase, true);
            this._dropFirst();
            this.fire<ApproveDoneDetail>('approve-done', { deviceId: join.request.deviceId });
        }
        catch (error)
        {
            if (error instanceof WrongPassphraseError)
            {
                this._error = 'Wrong passphrase. Try again.';
            }
            else if (error instanceof JoinExpiredError || isServerCode(error, 'join_expired'))
            {
                this._dropFirst();
                this._error = 'That request expired. Ask the new device to start again.';
            }
            else if (isServerCode(error, 'join_not_pending'))
            {
                this._dropFirst();
                this._error = 'That request was already approved or denied.';
            }
            else
            {
                this._error = errorText(error, 'The request couldn\'t be approved. Try again.');
            }
        }
        finally
        {
            this._busy = false;
        }
    }

    private async _onDeny(): Promise<void>
    {
        const circle = this.circle;
        const join = this._joins[0];
        if (circle === undefined || join === undefined || this._busy) return;

        this._busy = true;
        this._error = '';
        try
        {
            await circle.denyJoin(join.challengeId);
            this._dropFirst();
            this.fire('deny-done');
        }
        catch (error)
        {
            this._error = errorText(error, 'The request couldn\'t be denied. It expires on its own within five minutes.');
        }
        finally
        {
            this._busy = false;
        }
    }

    /** Moves on to the next request, with nothing carried over from this one. */
    private _dropFirst(): void
    {
        this._joins = this._joins.slice(1);
        this._codeConfirmed = false;
        this._passphrase = '';
    }
}

declare global
{
    interface HTMLElementTagNameMap
    {
        'conseal-approve-join': ConsealApproveJoin;
    }
}
