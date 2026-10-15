import { expect, fixture, html, oneEvent, waitUntil } from '@open-wc/testing';
import { CircleClient } from '../../src/sync/circle-client.js';
import { MemoryCircleStore } from '../../src/sync/circle-store.js';
import { SyncTransportError } from '../../src/sync/errors.js';
import { FakeCircleServer } from '../support/fake-circle-server.js';
import { findAll, press, textOf } from '../support/shadow.js';
import type { ConsealDevices, DeviceRevokedDetail } from '../../src/ui/conseal-devices.js';
import '../../src/ui/conseal-devices.js';

const PASSPHRASE = 'Correct horse 42 battery';

/** A laptop and a tablet in one circle, and the laptop's device list. */
async function laptopAndTablet(): Promise<{ server: FakeCircleServer; laptop: CircleClient; tabletId: string; list: ConsealDevices }>
{
    const server = new FakeCircleServer();
    const laptop = new CircleClient({ transport: server.transport(), store: new MemoryCircleStore() });
    const { mnemonic } = await laptop.setup(PASSPHRASE, { name: 'Laptop', platform: 'macOS' });
    const tablet = new CircleClient({ transport: server.transport(), store: new MemoryCircleStore() });
    const { deviceId: tabletId } = await tablet.recover(mnemonic, PASSPHRASE, { deviceMeta: { name: 'Tablet', platform: 'iPadOS' } });
    const list = await fixture<ConsealDevices>(html`<conseal-devices .circle=${laptop}></conseal-devices>`);
    await waitUntil(() => findAll(list, '.device').length === 2, 'The list never showed both devices.');
    return { server, laptop, tabletId, list };
}

describe('<conseal-devices>', () => {
    it('lists the circle\'s devices, this one marked', async () => {
        const { list } = await laptopAndTablet();

        const rows = findAll(list, '.device').map(row => row.textContent?.replace(/\s+/g, ' ').trim());

        expect(rows[0]).to.include('Laptop This device').and.to.include('macOS');
        expect(rows[1]).to.include('Tablet').and.to.include('iPadOS').and.not.to.include('This device');
    });

    it('removes another device once the user confirms', async () => {
        const { server, tabletId, list } = await laptopAndTablet();

        await press(list, 'Remove');
        expect(textOf(list)).to.include('It stops syncing, but keeps what it already has.');
        const revoked = oneEvent(list, 'device-revoked');
        await press(list, 'Remove it');

        expect(((await revoked) as CustomEvent<DeviceRevokedDetail>).detail).to.deep.equal({ deviceId: tabletId });
        expect(server.devices.get(tabletId)?.revoked).to.equal(true);
        expect(findAll(list, '.device')).to.have.length(1);
    });

    it('keeps the device when the user cancels', async () => {
        const { server, tabletId, list } = await laptopAndTablet();

        await press(list, 'Remove');
        await press(list, 'Cancel');

        expect(server.devices.get(tabletId)?.revoked).to.equal(false);
        expect(findAll(list, '.device')).to.have.length(2);
    });

    it('offers no way to remove this device', async () => {
        const { list } = await laptopAndTablet();

        expect(findAll(list, '.device')[0]?.querySelectorAll('button').length).to.equal(0);
    });

    it('says so when the server refuses to remove the last device', async () => {
        const { laptop, list } = await laptopAndTablet();
        laptop.revokeDevice = () => Promise.reject(new SyncTransportError(409, { code: 'last_device' }));

        await press(list, 'Remove');
        await press(list, 'Remove it');
        await waitUntil(() => textOf(list).includes('You can\'t remove the only device in your circle.'), 'No last-device message.');

        expect(findAll(list, '.device')).to.have.length(2);
    });
});
