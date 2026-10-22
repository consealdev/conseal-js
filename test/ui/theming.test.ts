import type { LitElement } from 'lit';
import { describe, expect, it } from 'vitest';
import { fixture, html, waitUntil } from '../support/dom.js';
import { CircleClient } from '../../src/sync/circle-client.js';
import { MemoryCircleStore } from '../../src/sync/circle-store.js';
import { FakeCircleServer } from '../support/fake-circle-server.js';
import { find, findAll, press, textOf } from '../support/shadow.js';
import type { ConsealDevices } from '../../src/ui/conseal-devices.js';
import type { ConsealUnlock } from '../../src/ui/conseal-unlock.js';
import '../../src/ui/conseal-devices.js';
import '../../src/ui/conseal-unlock.js';

const PASSPHRASE = 'Correct horse 42 battery';

/** A dark page whose brand fill is too light for a white label: the host sets each of the colors the contract offers. */
const DARK_THEME = {
    '--color-surface': 'rgb(24, 26, 20)',
    '--color-primary': 'rgb(163, 184, 108)',
    '--color-primary-text': 'rgb(16, 20, 10)',
    '--color-link': 'rgb(190, 208, 140)',
    '--color-danger': 'rgb(232, 118, 106)',
    '--color-danger-text': 'rgb(40, 10, 8)',
    '--color-warning': 'rgb(224, 150, 70)',
    '--color-warning-text': 'rgb(38, 20, 4)',
    '--color-notice-text': 'rgb(240, 214, 150)',
    '--color-notice-bg': 'rgb(52, 42, 18)',
    '--color-notice-border': 'rgb(120, 96, 40)',
    '--color-badge-text': 'rgb(190, 208, 140)',
    '--color-badge-bg': 'rgb(44, 52, 30)',
};

/** The colors the browser computes for the parts of the screens a theme reaches. */
interface Looks
{
    primaryLabel: string;
    dangerLabel: string;
    warnLabel: string;
    link: string;
    notice: { text: string; background: string; border: string };
    badge: { text: string; background: string };
}

interface Screens
{
    hosts: LitElement[];
    choice: ConsealUnlock;
    recovery: ConsealUnlock;
    devices: ConsealDevices;
}

/** The look of the components with no theme at all. */
const DEFAULT_LOOKS: Looks = {
    primaryLabel: 'rgb(255, 255, 255)',
    dangerLabel: 'rgb(255, 255, 255)',
    warnLabel: 'rgb(255, 255, 255)',
    link: 'rgb(99, 102, 241)',
    notice: { text: 'rgb(146, 64, 14)', background: 'rgb(254, 243, 199)', border: 'rgb(251, 191, 36)' },
    badge: { text: 'rgb(99, 102, 241)', background: 'rgb(238, 242, 255)' },
};

function device(server: FakeCircleServer): CircleClient
{
    return new CircleClient({ transport: server.transport(), store: new MemoryCircleStore() });
}

async function unlockOfNewDevice(server: FakeCircleServer): Promise<ConsealUnlock>
{
    const element = await fixture<ConsealUnlock>(html`<conseal-unlock .circle=${device(server)}></conseal-unlock>`);
    await waitUntil(() => !textOf(element).includes('Checking this device'), 'The unlock screen kept checking the device.');
    return element;
}

/** One of each part a theme reaches, on screen at once: the buttons and the notice of unlock, the badge, link and Remove of the device list. */
async function screens(): Promise<Screens>
{
    const server = new FakeCircleServer();
    const laptop = device(server);
    const { mnemonic } = await laptop.setup(PASSPHRASE, { name: 'Laptop', platform: 'macOS' });
    await device(server).recover(mnemonic, PASSPHRASE, { deviceMeta: { name: 'Tablet', platform: 'iPadOS' } });

    const choice = await unlockOfNewDevice(server);
    const recovery = await unlockOfNewDevice(server);
    await press(recovery, 'I\'ve lost all my devices: use my recovery phrase');

    const devices = await fixture<ConsealDevices>(html`<conseal-devices .circle=${laptop}></conseal-devices>`);
    await waitUntil(() => findAll(devices, '.device').length === 2, 'The list never showed both devices.');
    await press(devices, 'Remove');

    return { hosts: [choice, recovery, devices], choice, recovery, devices };
}

/** Sets the theme on the page's side of each component, as a host sets it on the page or an ancestor. */
function theme(shown: Screens, properties: Record<string, string>): void
{
    for (const host of shown.hosts)
    {
        for (const [name, value] of Object.entries(properties)) host.style.setProperty(name, value);
    }
}

function looks(shown: Screens): Looks
{
    const style = (host: LitElement, selector: string) => getComputedStyle(find(host, selector));
    const notice = style(shown.recovery, '.warning');
    const badge = style(shown.devices, '.badge');
    return {
        primaryLabel: style(shown.choice, '.primary').color,
        dangerLabel: style(shown.devices, '.danger').color,
        warnLabel: style(shown.choice, '.warn').color,
        link: style(shown.devices, '.link').color,
        notice: { text: notice.color, background: notice.backgroundColor, border: notice.borderTopColor },
        badge: { text: badge.color, background: badge.backgroundColor },
    };
}

describe('Theming the components', () => {
    it('keeps the look they have always had when the host sets no colors', async () => {
        expect(looks(await screens())).to.deep.equal(DEFAULT_LOOKS);
    });

    it('takes the button labels, links, notices and badge from a dark theme', async () => {
        const shown = await screens();
        theme(shown, DARK_THEME);

        expect(looks(shown)).to.deep.equal({
            primaryLabel: DARK_THEME['--color-primary-text'],
            dangerLabel: DARK_THEME['--color-danger-text'],
            warnLabel: DARK_THEME['--color-warning-text'],
            link: DARK_THEME['--color-link'],
            notice: {
                text: DARK_THEME['--color-notice-text'],
                background: DARK_THEME['--color-notice-bg'],
                border: DARK_THEME['--color-notice-border'],
            },
            badge: { text: DARK_THEME['--color-badge-text'], background: DARK_THEME['--color-badge-bg'] },
        });
    });

    it('follows the primary color for links and the badge until the host gives them a color of their own', async () => {
        const shown = await screens();
        theme(shown, { '--color-primary': DARK_THEME['--color-primary'] });

        expect(looks(shown)).to.deep.include({ link: DARK_THEME['--color-primary'], primaryLabel: DEFAULT_LOOKS.primaryLabel });
        expect(looks(shown).badge).to.deep.equal({ text: DARK_THEME['--color-primary'], background: DEFAULT_LOOKS.badge.background });
    });
});
