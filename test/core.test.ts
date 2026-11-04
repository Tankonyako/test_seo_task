import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyGuards, type Label } from '../src/llm.ts';
import { extractEmails, findContacts, htmlToMarkdown, rankContacts, type Page } from '../src/page.ts';
import type { SerpItem } from '../src/serp.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDb, replaceDay, saveDb, type Db, type PositionRow } from '../src/store.ts';

const serp: SerpItem = { position: 1, url: 'https://reviews.test/best', domain: 'reviews.test', title: 'Best casinos', snippet: '' };
const page: Page = {
    ok: true, error: null, title: 'Top 10', markdown: 'We rate Jackpot City and Spin Casino.', images: [],
    contacts: [
        { value: 'ads@reviews.test', type: 'email', found_on: 'https://reviews.test/advertise' },
        { value: 'https://reviews.test/contact', type: 'contact_page', found_on: 'https://reviews.test/best' },
    ],
};
const label: Label = {
    site_type: 'affiliate_review', relevant: true, profit: 0.9,
    brands: ['Jackpot City', 'Spin Casino', 'Made Up Casino'], contact: 'https://reviews.test/contact', reason: 'ranking',
};

function row(date: string, position: number, url: string): PositionRow
{
    return { date, region: 'ca', keyword: 'interac casino', cluster: 'payments', position, url, domain: 'x.test' };
}

test('guards drop brands that are not in the page text', () =>
{
    assert.deepEqual(applyGuards(label, serp, page).brands, ['Jackpot City', 'Spin Casino']);
});

test('contact: model pick is kept, made up or empty falls back to our best ranked one', () =>
{
    assert.equal(applyGuards(label, serp, page).contact, 'https://reviews.test/contact');
    assert.equal(applyGuards({ ...label, contact: 'invented@mail.test' }, serp, page).contact, 'ads@reviews.test');
    assert.equal(applyGuards({ ...label, contact: null }, serp, page).contact, 'ads@reviews.test');
    assert.equal(applyGuards(label, serp, { ...page, contacts: [] }).contact, null);
});

test('casino operator is never relevant and has no profit even if the model says so', () =>
{
    const guarded = applyGuards({ ...label, site_type: 'casino_operator' }, serp, page);
    assert.equal(guarded.relevant, false);
    assert.equal(guarded.profit, 0);
});

test('contacts: telegram and same site contact pages found, partner email ranked first', () =>
{
    const html = `<a href="/contact-us">Contact</a> <a href="https://other.test/contact">x</a>
        support@reviews.test partners@reviews.test <a href="https://t.me/reviews_ads">tg</a>`;
    const ranked = rankContacts(findContacts(html, 'https://reviews.test/page'), 'reviews.test').map((c) => c.value);
    assert.deepEqual(ranked, ['partners@reviews.test', 'https://t.me/reviews_ads', 'https://reviews.test/contact-us', 'support@reviews.test']);
});

test('emails: plain, url encoded mailto, cloudflare protected, image names skipped', () =>
{
    // "a@b.co" xor 0x42, key byte first
    const hex = '42' + [...'a@b.co'].map((c) => (c.charCodeAt(0) ^ 0x42).toString(16).padStart(2, '0')).join('');
    const html = `info@site.test <a href="mailto:ads%40site.test">x</a> <span data-cfemail="${hex}"></span> logo@2x.png`;
    assert.deepEqual(extractEmails(html).sort(), ['a@b.co', 'ads@site.test', 'info@site.test']);
});

test('markdown keeps image alt (brand logos) and drops scripts', () =>
{
    const markdown = htmlToMarkdown('<h1>Top</h1><script>var a=1</script><img alt="Jackpot City logo" src="x.png">');
    assert.match(markdown, /Jackpot City logo/);
    assert.doesNotMatch(markdown, /var a/);
});

test('rerun on the same day replaces rows, another day adds history', () =>
{
    const db: Db = { runs: [], positions: [], pages: {} };
    replaceDay(db, '2026-11-04', 'ca', 'interac casino', [row('2026-11-04', 1, 'https://a.test'), row('2026-11-04', 2, 'https://b.test')]);
    replaceDay(db, '2026-11-04', 'ca', 'interac casino', [row('2026-11-04', 1, 'https://b.test'), row('2026-11-04', 2, 'https://a.test')]);
    assert.equal(db.positions.length, 2);

    replaceDay(db, '2026-11-05', 'ca', 'interac casino', [row('2026-11-05', 1, 'https://a.test')]);
    assert.equal(db.positions.length, 3);
    assert.equal(db.positions.filter((r) => r.url === 'https://a.test').length, 2);
});

test('output folder is the db: save then load gives the same data back', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'serp-'));
    const db: Db = {
        runs: [],
        positions: [row('2026-11-04', 1, serp.url)],
        pages: { [serp.url]: { url: serp.url, domain: serp.domain, ...label, contacts_found: [], source: 'page', fetch_error: null, analyzed_at: '2026-11-04T00:00:00Z' } },
    };
    saveDb(dir, db);
    assert.deepEqual(loadDb(dir), db);
    assert.deepEqual(loadDb(join(dir, 'missing')), { runs: [], positions: [], pages: {} });
});
