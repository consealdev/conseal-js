import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { CircleClient, CircleDevice } from '../sync/circle-client.js';
import { CircleElement } from './ceremony-element.js';
import { ceremonyStyles } from './ceremony-styles.js';
import { errorText, isServerCode } from './error-text.js';

/** What `device-revoked` carries: the device that left the circle. */
export interface DeviceRevokedDetail
{
    deviceId: string;
}

/**
 * The devices in the user's circle, with a way to remove any but this one. A removed device stops syncing, but keeps
 * what it already holds. It's a convenience: no key material passes through it.
 *
 * @fires device-revoked - a device left the circle; `detail` is a `DeviceRevokedDetail`
 */
@customElement('conseal-devices')
export class ConsealDevices extends CircleElement
{
    static override styles = [ceremonyStyles, css`
        .device { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; }
        .device + .device { border-top: 1px solid var(--color-border, #e2e8f0); }
        .name { font-size: 0.875rem; font-weight: 600; }
        .badge {
            margin-left: 6px;
            padding: 2px 6px;
            font-size: 0.7rem;
            font-weight: 600;
            color: var(--color-badge-text, var(--color-primary, #6366f1));
            background: var(--color-badge-bg, #eef2ff);
            border-radius: 4px;
        }
        .actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    `];

    @state() private _devices: CircleDevice[] = [];
    @state() private _loading = true;
    @state() private _error = '';
    @state() private _confirming: string | undefined;
    @state() private _revoking: string | undefined;

    /** Asks the server again for the circle's devices. */
    public async reload(): Promise<void>
    {
        const circle = this.circle;
        if (circle === undefined) return;
        this._loading = true;
        this._error = '';
        try
        {
            this._devices = await circle.devices();
        }
        catch (error)
        {
            this._error = errorText(error, 'The devices couldn\'t be loaded. Try again.');
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
        return html`
            <div class="card stack loose">
                <div class="heading">Your devices</div>
                ${this._loading
                    ? html`
                        <div class="status">Loading devices…</div>
                    `
                    : html`
                        <div>
                            ${repeat(this._devices, device => device.deviceId, device => this._renderDevice(device))}
                        </div>
                    `
                }
                ${this._error
                    ? html`
                        <div class="error">${this._error}</div>
                    `
                    : nothing
                }
            </div>
        `;
    }

    private _renderDevice(device: CircleDevice): TemplateResult
    {
        const added = device.registeredAt ? ` · added ${new Date(device.registeredAt).toLocaleDateString()}` : '';
        return html`
            <div class="device">
                <div>
                    <div class="name">
                        ${device.name ?? 'Unknown device'}
                        ${device.current
                            ? html`
                                <span class="badge">This device</span>
                            `
                            : nothing
                        }
                    </div>
                    <div class="hint">${device.platform ?? 'Unknown platform'}${added}</div>
                    ${this._confirming === device.deviceId
                        ? html`
                            <div class="hint">It stops syncing, but keeps what it already has.</div>
                        `
                        : nothing
                    }
                </div>
                ${device.current ? nothing : this._renderActions(device)}
            </div>
        `;
    }

    private _renderActions(device: CircleDevice): TemplateResult
    {
        if (this._confirming !== device.deviceId)
        {
            return html`
                <div class="actions">
                    <button class="secondary small" data-device-id=${device.deviceId} @click=${this._onRemove}>Remove</button>
                </div>
            `;
        }
        const revoking = this._revoking === device.deviceId;
        return html`
            <div class="actions">
                <button class="link" ?disabled=${revoking} @click=${this._onCancel}>Cancel</button>
                <button class="danger small" ?disabled=${revoking} data-device-id=${device.deviceId} @click=${this._onConfirmRemove}>
                    ${revoking ? 'Removing…' : 'Remove it'}
                </button>
            </div>
        `;
    }

    private _onRemove(event: Event): void
    {
        this._error = '';
        this._confirming = deviceIdOf(event);
    }

    private _onCancel(): void
    {
        this._confirming = undefined;
    }

    private async _onConfirmRemove(event: Event): Promise<void>
    {
        const circle = this.circle;
        const deviceId = deviceIdOf(event);
        if (circle === undefined || deviceId === undefined || this._revoking !== undefined) return;

        this._revoking = deviceId;
        this._error = '';
        try
        {
            await circle.revokeDevice(deviceId);
            this._devices = this._devices.filter(device => device.deviceId !== deviceId);
            this.fire<DeviceRevokedDetail>('device-revoked', { deviceId });
        }
        catch (error)
        {
            this._error = isServerCode(error, 'last_device')
                ? 'You can\'t remove the only device in your circle.'
                : errorText(error, 'The device couldn\'t be removed. Try again.');
        }
        finally
        {
            this._revoking = undefined;
            this._confirming = undefined;
        }
    }
}

/** The device a row's button acts on. */
function deviceIdOf(event: Event): string | undefined
{
    return (event.currentTarget as HTMLElement).dataset['deviceId'];
}

declare global
{
    interface HTMLElementTagNameMap
    {
        'conseal-devices': ConsealDevices;
    }
}
