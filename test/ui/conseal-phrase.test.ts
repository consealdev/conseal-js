import { generateMnemonic } from '../../src/core/index.js';
import { describe, expect, it } from 'vitest';
import { fixture, html, oneEvent } from '../support/dom.js';
import { button, findAll, press, textOf, tick } from '../support/shadow.js';
import type { ConsealPhrase } from '../../src/ui/conseal-phrase.js';
import '../../src/ui/conseal-phrase.js';

describe('<conseal-phrase>', () => {
    const mnemonic = generateMnemonic();

    function phrase(): Promise<ConsealPhrase>
    {
        return fixture<ConsealPhrase>(html`<conseal-phrase app-name="Pinner" .mnemonic=${mnemonic}></conseal-phrase>`);
    }

    it('shows the 24 words in order', async () => {
        const element = await phrase();

        expect(findAll(element, '.word').map(word => word.textContent)).to.deep.equal(mnemonic.split(' '));
        expect(findAll(element, '.number').map(number => number.textContent)).to.include.members(['1.', '24.']);
    });

    it('keeps the phrase out of the page\'s markup', async () => {
        const element = await phrase();
        const words = new Set(mnemonic.split(' '));

        // What the page can read: the light DOM and the attribute values. The tag and attribute names are left out,
        // since they can't carry the phrase and hold words that may be in it, such as "phrase".
        expect(element.childNodes.length).to.equal(0);
        const values = [...element.attributes].flatMap(attribute => attribute.value.split(/[^a-z]+/i));
        expect(values.filter(value => words.has(value))).to.deep.equal([]);
        expect(element.hasAttribute('mnemonic')).to.equal(false);
    });

    it('names the app in its warning that the phrase is shown once', async () => {
        expect(textOf(await phrase())).to.include('Pinner will never show them again');
    });

    it('lets the user continue only once they say they wrote it down', async () => {
        const element = await phrase();
        expect(button(element, 'Continue').disabled).to.equal(true);

        await tick(element, 'input[type=checkbox]');

        expect(button(element, 'Continue').disabled).to.equal(false);
    });

    it('forgets the phrase as the user continues', async () => {
        const element = await phrase();
        await tick(element, 'input[type=checkbox]');

        const confirmed = oneEvent(element, 'phrase-confirmed');
        await press(element, 'Continue');
        await confirmed;

        expect(element.mnemonic).to.equal('');
        expect(findAll(element, '.word')).to.have.length(0);
    });
});
