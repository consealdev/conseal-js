import { seal, unseal } from '../../src/core/index.js';
import { expect, fixture, html, oneEvent, waitUntil } from '@open-wc/testing';
import { CircleClient } from '../../src/sync/circle-client.js';
import { MemoryCircleStore } from '../../src/sync/circle-store.js';
import { FakeCircleServer } from '../support/fake-circle-server.js';
import { button, find, press, textOf, tick, type } from '../support/shadow.js';
import type { ConsealApproveJoin } from '../../src/ui/conseal-approve-join.js';
import type { ConsealJoin, JoinDoneDetail } from '../../src/ui/conseal-join.js';
import '../../src/ui/conseal-approve-join.js';
import '../../src/ui/conseal-join.js';

const PASSPHRASE = 'Correct horse 42 battery';
const FIVE_MINUTES = 5 * 60 * 1000;

function device(server: FakeCircleServer): CircleClient
{
    return new CircleClient({ transport: server.transport(), store: new MemoryCircleStore() });
}

/** A circle with a laptop in it, and a phone asking to join on its `<conseal-join>`, showing its code. */
async function phoneAsking(): Promise<{ server: FakeCircleServer; laptop: CircleClient; phone: CircleClient; join: ConsealJoin }>
{
    const server = new FakeCircleServer();
    const laptop = device(server);
    await laptop.setup(PASSPHRASE);
    const phone = device(server);
    const join = await fixture<ConsealJoin>(html`
        <conseal-join app-name="Pinner" poll-interval="20" .circle=${phone} .deviceMeta=${{ name: 'Phone' }}></conseal-join>
    `);
    await waitUntil(() => textOf(join).includes('Approve this device'), 'The phone never showed its code.');
    return { server, laptop, phone, join };
}

/** The laptop's `<conseal-approve-join>`, once it has the phone's request. */
async function approver(laptop: CircleClient): Promise<ConsealApproveJoin>
{
    const element = await fixture<ConsealApproveJoin>(html`<conseal-approve-join .circle=${laptop}></conseal-approve-join>`);
    await waitUntil(() => textOf(element).includes('A new device wants to join'), 'The laptop never showed the request.');
    return element;
}

async function approve(element: ConsealApproveJoin, passphrase: string): Promise<void>
{
    await tick(element, 'input[type=checkbox]');
    await type(element, '#passphrase', passphrase);
    await press(element, 'Approve');
}

/** Whether two AES keys are the same key: what one seals, the other opens. */
async function sameKey(a: CryptoKey, b: CryptoKey): Promise<boolean>
{
    const { ciphertext, iv } = await seal(a, new TextEncoder().encode('the same circle').buffer as ArrayBuffer);
    const opened = await unseal(b, ciphertext, iv).catch(() => undefined);
    return opened !== undefined && new TextDecoder().decode(opened) === 'the same circle';
}

describe('<conseal-join> with <conseal-approve-join>', () => {
    it('shows the same code on both devices', async () => {
        const { laptop, join } = await phoneAsking();
        const element = await approver(laptop);

        expect(find(join, '.code').textContent).to.match(/\S/);
        expect(find(element, '.code').textContent).to.equal(find(join, '.code').textContent);
        expect(textOf(element)).to.include('Phone');
    });

    it('adds the phone once the laptop approves and the phone enters the passphrase', async () => {
        const { laptop, phone, join } = await phoneAsking();
        const element = await approver(laptop);

        const approved = oneEvent(element, 'approve-done');
        await approve(element, PASSPHRASE);
        await approved;
        await waitUntil(() => textOf(join).includes('Approved'), 'The phone never saw the approval.');
        await type(join, '#passphrase', PASSPHRASE);
        const done = oneEvent(join, 'join-done');
        await press(join, 'Finish');
        const { detail } = (await done) as CustomEvent<JoinDoneDetail>;

        expect(detail.deviceId).to.equal(await phone.deviceId());
        expect(await phone.status()).to.equal('unlocked');
        expect(await sameKey(await laptop.aek(), await phone.aek())).to.equal(true);
        expect(textOf(join)).to.include('Device added');
    });

    it('lets the laptop approve only once the user says the codes match', async () => {
        const { laptop } = await phoneAsking();
        const element = await approver(laptop);

        await type(element, '#passphrase', PASSPHRASE);
        expect(button(element, 'Approve').disabled).to.equal(true);

        await tick(element, 'input[type=checkbox]');
        expect(button(element, 'Approve').disabled).to.equal(false);
    });

    it('refuses the laptop a wrong passphrase, and keeps the request', async () => {
        const { laptop } = await phoneAsking();
        const element = await approver(laptop);

        await approve(element, 'Not the passphrase 1');
        await waitUntil(() => textOf(element).includes('Wrong passphrase'), 'No wrong-passphrase message.');

        expect(textOf(element)).to.include('A new device wants to join');
    });

    it('asks the phone again for a passphrase that isn\'t the one the laptop uses', async () => {
        const { laptop, join } = await phoneAsking();
        await approve(await approver(laptop), PASSPHRASE);
        await waitUntil(() => textOf(join).includes('Approved'), 'The phone never saw the approval.');

        await type(join, '#passphrase', 'Not the passphrase 1');
        await press(join, 'Finish');
        await waitUntil(() => textOf(join).includes('That isn\'t the passphrase your other devices use'), 'No mismatch message.');

        expect(textOf(join)).to.include('Approved');
    });

    it('ends the phone\'s join when the laptop denies it, and starts a new one when asked', async () => {
        const { server, laptop, join } = await phoneAsking();
        const element = await approver(laptop);
        const firstCode = find(join, '.code').textContent;

        await press(element, 'Deny');
        await waitUntil(() => textOf(join).includes('The request was denied'), 'The phone never saw the denial.');
        expect(textOf(element)).to.include('No requests waiting');

        await press(join, 'Start again');
        await waitUntil(() => textOf(join).includes('Approve this device'), 'The phone never asked again.');
        expect(find(join, '.code').textContent).not.to.equal(firstCode);
        expect([...server.challenges.values()].filter(challenge => challenge.status === 'pending')).to.have.length(1);
    });

    it('ends the phone\'s join when the request expires', async () => {
        const { server, join } = await phoneAsking();

        const now = Date.now();
        server.now = () => now + FIVE_MINUTES + 1000;
        await waitUntil(() => textOf(join).includes('The request expired'), 'The phone never saw the expiry.');
    });

    it('tells the laptop a request has expired rather than approving it', async () => {
        const server = new FakeCircleServer();
        const laptop = device(server);
        await laptop.setup(PASSPHRASE);
        // The server received the request more than five minutes ago, by its clock.
        const asked = Date.now() - FIVE_MINUTES - 1000;
        server.now = () => asked;
        await device(server).startJoin();
        const element = await approver(laptop);

        await approve(element, PASSPHRASE);
        await waitUntil(() => textOf(element).includes('That request expired'), 'No expiry message.');
    });

    it('finds a request that arrives later when the laptop checks again', async () => {
        const server = new FakeCircleServer();
        const laptop = device(server);
        await laptop.setup(PASSPHRASE);
        const element = await fixture<ConsealApproveJoin>(html`<conseal-approve-join .circle=${laptop}></conseal-approve-join>`);
        await waitUntil(() => textOf(element).includes('No requests waiting'), 'The laptop kept looking.');

        await device(server).startJoin({ name: 'Tablet' });
        await press(element, 'Check again');
        await waitUntil(() => textOf(element).includes('Tablet'), 'The laptop never found the request.');
    });
});
