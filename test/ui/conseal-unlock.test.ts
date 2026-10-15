import { generateMnemonic } from '../../src/core/index.js';
import { describe, expect, it } from 'vitest';
import { fixture, html, oneEvent, waitUntil } from '../support/dom.js';
import { CircleClient } from '../../src/sync/circle-client.js';
import { MemoryCircleStore } from '../../src/sync/circle-store.js';
import { FakeCircleServer } from '../support/fake-circle-server.js';
import { press, textOf, type } from '../support/shadow.js';
import type { ConsealUnlock, UnlockDoneDetail } from '../../src/ui/conseal-unlock.js';
import '../../src/ui/conseal-unlock.js';

const PASSPHRASE = 'Correct horse 42 battery';
const NEW_PASSPHRASE = 'Another horse 7 staple';

function device(server: FakeCircleServer): CircleClient
{
    return new CircleClient({ transport: server.transport(), store: new MemoryCircleStore() });
}

/** The unlock screen for a device, once it has asked the server where the device stands. */
async function unlock(circle: CircleClient): Promise<ConsealUnlock>
{
    const element = await fixture<ConsealUnlock>(html`<conseal-unlock app-name="Pinner" .circle=${circle}></conseal-unlock>`);
    await waitUntil(() => !textOf(element).includes('Checking this device'), 'The unlock screen kept checking the device.');
    return element;
}

async function recover(element: ConsealUnlock, mnemonic: string): Promise<void>
{
    await type(element, '#mnemonic', mnemonic);
    await type(element, '#new-passphrase', NEW_PASSPHRASE);
    await type(element, '#confirm-passphrase', NEW_PASSPHRASE);
    await press(element, 'Recover');
}

describe('<conseal-unlock>', () => {
    it('unlocks a locked device with its passphrase', async () => {
        const laptop = device(new FakeCircleServer());
        await laptop.setup(PASSPHRASE);
        await laptop.lock();
        const element = await unlock(laptop);

        await type(element, '#passphrase', PASSPHRASE);
        const done = oneEvent(element, 'unlock-done');
        await press(element, 'Unlock');

        expect(((await done) as CustomEvent<UnlockDoneDetail>).detail).to.deep.equal({ recovered: false });
        expect(await laptop.status()).to.equal('unlocked');
    });

    it('says so when the passphrase is wrong, and stays locked', async () => {
        const laptop = device(new FakeCircleServer());
        await laptop.setup(PASSPHRASE);
        await laptop.lock();
        const element = await unlock(laptop);

        await type(element, '#passphrase', 'Not the passphrase 1');
        await press(element, 'Unlock');
        await waitUntil(() => textOf(element).includes('Wrong passphrase'), 'No wrong-passphrase message.');

        expect(await laptop.status()).to.equal('locked');
    });

    it('offers a device with no keys the two ways in, and asks the app to show the join', async () => {
        const server = new FakeCircleServer();
        await device(server).setup(PASSPHRASE);
        const element = await unlock(device(server));

        expect(textOf(element)).to.include('This device isn\'t in your circle');
        const needsJoin = oneEvent(element, 'needs-join');
        await press(element, 'Add this device from another one');
        await needsJoin;
    });

    it('offers a revoked device the two ways in, though it still holds its keys', async () => {
        const server = new FakeCircleServer();
        const laptop = device(server);
        const { mnemonic } = await laptop.setup(PASSPHRASE);
        const tablet = device(server);
        await tablet.recover(mnemonic, PASSPHRASE);
        await laptop.revokeDevice(await tablet.deviceId() ?? '');
        await tablet.lock();

        expect(textOf(await unlock(tablet))).to.include('This device isn\'t in your circle');
    });

    it('recovers from the recovery phrase, and removes the other devices', async () => {
        const server = new FakeCircleServer();
        const laptop = device(server);
        const { mnemonic, deviceId: laptopId } = await laptop.setup(PASSPHRASE);
        const tablet = device(server);
        const element = await unlock(tablet);

        await press(element, 'I\'ve lost all my devices: use my recovery phrase');
        expect(textOf(element)).to.include('Recovering removes your other devices');
        const done = oneEvent(element, 'unlock-done');
        await recover(element, mnemonic);
        const { detail } = (await done) as CustomEvent<UnlockDoneDetail>;

        expect(detail).to.deep.include({ recovered: true, aekCommitment: server.commitment });
        expect(await tablet.status()).to.equal('unlocked');
        expect(server.devices.get(laptopId)?.revoked).to.equal(true);
    });

    it('refuses the recovery phrase of another circle', async () => {
        const server = new FakeCircleServer();
        await device(server).setup(PASSPHRASE);
        const element = await unlock(device(server));
        await press(element, 'I\'ve lost all my devices: use my recovery phrase');

        await recover(element, generateMnemonic());
        await waitUntil(() => textOf(element).includes('doesn\'t belong to your account'), 'No commitment mismatch message.');
    });

    it('refuses words that aren\'t a recovery phrase', async () => {
        const server = new FakeCircleServer();
        await device(server).setup(PASSPHRASE);
        const element = await unlock(device(server));
        await press(element, 'I\'ve lost all my devices: use my recovery phrase');

        await recover(element, 'these are not the words of any phrase at all');
        await waitUntil(() => textOf(element).includes('That isn\'t a valid recovery phrase'), 'No invalid phrase message.');
    });
});
