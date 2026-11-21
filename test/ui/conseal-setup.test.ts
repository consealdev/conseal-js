import { describe, expect, it } from 'vitest';
import { fixture, html, oneEvent, waitUntil } from '../support/dom.js';
import { CircleClient } from '../../src/sync/circle-client.js';
import { MemoryCircleStore } from '../../src/sync/circle-store.js';
import { SyncTransportError } from '../../src/sync/errors.js';
import { FakeCircleServer } from '../support/fake-circle-server.js';
import { button, press, textOf, type } from '../support/shadow.js';
import type { ConsealSetup, SetupDoneDetail } from '../../src/ui/conseal-setup.js';
import '../../src/ui/conseal-setup.js';

const PASSPHRASE = 'Correct horse 42 battery';

async function setup(circle: CircleClient): Promise<ConsealSetup>
{
    return fixture<ConsealSetup>(html`<conseal-setup app-name="Pinner" .circle=${circle}></conseal-setup>`);
}

describe('<conseal-setup>', () => {
    it('creates the circle, unlocks this device, and reports the recovery phrase', async () => {
        const server = new FakeCircleServer();
        const circle = new CircleClient({ transport: server.transport(), store: new MemoryCircleStore() });
        const element = await setup(circle);

        await type(element, '#new-passphrase', PASSPHRASE);
        await type(element, '#confirm-passphrase', PASSPHRASE);
        const done = oneEvent(element, 'setup-done');
        await press(element, 'Create passphrase');
        const { detail } = (await done) as CustomEvent<SetupDoneDetail>;

        const words = detail.mnemonic.split(' ');
        expect(words).to.have.length(24);
        expect(server.commitment).to.equal(detail.aekCommitment);
        expect(await circle.status()).to.equal('unlocked');
        // The phrase is shown by <conseal-phrase>, never here. A few of its words can still be words of this screen's own
        // text, such as "only", so a screen that shows the phrase is one that has most of its 24 words, not one that has any
        const screenWords = new Set(textOf(element).toLowerCase().split(/[^a-z]+/));
        expect(words.filter(word => screenWords.has(word)).length).to.be.below(words.length / 2);
    });

    for (const [why, passphrase, confirmation] of [
        ['shorter than 12 characters', 'Short 1', 'Short 1'],
        ['all one kind of character', 'onlylowercaseletters', 'onlylowercaseletters'],
        ['not the same twice', PASSPHRASE, `${PASSPHRASE}!`],
    ])
    {
        it(`refuses a passphrase ${why}`, async () => {
            const element = await setup(new CircleClient({ transport: new FakeCircleServer().transport(), store: new MemoryCircleStore() }));

            await type(element, '#new-passphrase', passphrase ?? '');
            await type(element, '#confirm-passphrase', confirmation ?? '');

            expect(button(element, 'Create passphrase').disabled).to.equal(true);
        });
    }

    it('rates the passphrase as it is typed', async () => {
        const element = await setup(new CircleClient({ transport: new FakeCircleServer().transport(), store: new MemoryCircleStore() }));

        await type(element, '#new-passphrase', 'Short 1');
        expect(textOf(element)).to.include('Too short: at least 12 characters');

        await type(element, '#new-passphrase', PASSPHRASE);
        expect(textOf(element)).to.include('Very strong');
    });

    it('says so when the account already has a circle', async () => {
        const transport = new FakeCircleServer().transport();
        transport.createCircle = () => Promise.reject(new SyncTransportError(409, { code: 'circle_exists' }));
        const element = await setup(new CircleClient({ transport, store: new MemoryCircleStore() }));

        await type(element, '#new-passphrase', PASSPHRASE);
        await type(element, '#confirm-passphrase', PASSPHRASE);
        await press(element, 'Create passphrase');
        await waitUntil(() => textOf(element).includes('This account already has a circle.'), 'No circle_exists message.');

        expect(button(element, 'Create passphrase').disabled).to.equal(false);
    });

    it('names the app in what it promises', async () => {
        const element = await setup(new CircleClient({ transport: new FakeCircleServer().transport(), store: new MemoryCircleStore() }));

        expect(textOf(element)).to.include('not even Pinner can read it');
    });
});
