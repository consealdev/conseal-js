import { LitElement, type CSSResultGroup, type PropertyValues } from 'lit';
import { property } from 'lit/decorators.js';
import type { CircleClient } from '../sync/circle-client.js';
import { ceremonyStyles } from './ceremony-styles.js';

/** A ceremony component: a card in its own shadow root, which names the app in its text and tells the app by events. */
export abstract class CeremonyElement extends LitElement
{
    static override styles: CSSResultGroup = ceremonyStyles;

    /** The app's name, as the text shows it, such as "Pinner". */
    @property({ attribute: 'app-name' }) appName = 'this app';

    /** Dispatches an event that crosses the shadow root, for the app to listen for on the element or above it. */
    protected fire<T>(type: string, detail?: T): void
    {
        this.dispatchEvent(new CustomEvent<T | undefined>(type, { detail, bubbles: true, composed: true }));
    }
}

/** A ceremony component that acts through the app's `CircleClient`. */
export abstract class CircleElement extends CeremonyElement
{
    /** The app's circle client. Set it as a property, before or after the element is added to the page. */
    @property({ attribute: false }) circle: CircleClient | undefined;

    private _started = false;

    override updated(changed: PropertyValues<this>): void
    {
        super.updated(changed);
        if (this._started || this.circle === undefined || !this.isConnected) return;
        this._started = true;
        void this.start(this.circle);
    }

    /** Called once, when the element first renders on the page with a circle client: load what it shows. */
    protected start(_circle: CircleClient): Promise<void>
    {
        return Promise.resolve();
    }
}
