import TurndownService from 'turndown';
import { fetch as proxyFetch, ProxyAgent } from 'undici';
import { HttpError, withRetry } from './config.ts';

/*
 * Optional PROXY_URL, same string as `curl -x`: http://user:pass@host:port
 * Only page downloads use it (SerpAPI and the llm go direct). A residential proxy in Canada
 * sees the sites like a Canadian player and gets past most ISP blocks of gambling sites.
 */
const proxyUrl = process.env['PROXY_URL']?.trim();
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

export interface Contact
{
    value: string;
    type: 'email' | 'telegram' | 'contact_page';
    // the page where we saw it, so a manager can check
    found_on: string;
}

export interface Image
{
    src: string;
    alt: string;
}

export interface Page
{
    // false = site blocked us or failed, the llm then only gets the google title and snippet
    ok: boolean;
    error: string | null;
    title: string;
    markdown: string;
    images: Image[];
    // best first, see rankContacts
    contacts: Contact[];
}

// we look at the mobile serp, so we ask for the mobile page
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const MAX_CHARS = 30000;
const BOT_WALL = /just a moment\.\.\.|cf-chl-|attention required|verify you are human/i;
const NOT_EMAIL = /\.(png|jpe?g|gif|webp|svg|avif)$|@(sentry|wixpress|example|domain)\.|^(noreply|no-reply|name|your|email)@/i;
const CONTACT_PAGE = /advertis|write-for-us|partner|affiliate|work-with-us|contact|about/i;
// tried when the site has no contact link in the html we got
const DEFAULT_CONTACT_PATHS = ['/contact', '/contact-us', '/advertise'];

const turndown = new TurndownService({ headingStyle: 'atx' });
turndown.remove(['script', 'style', 'noscript', 'iframe', 'form', 'head']);
// casino logos are images, often the alt text is the only place the brand is written
turndown.addRule('img', {
    filter: 'img',
    replacement: (_content, node) =>
    {
        const alt = (node as HTMLElement).getAttribute('alt')?.trim();
        return alt ? ` [img: ${alt}] ` : '';
    },
});
// keep link text only, urls eat tokens and tell the llm nothing
turndown.addRule('link', { filter: 'a', replacement: (content) => content });

export function htmlToMarkdown(html: string): string
{
    const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, '');
    return turndown.turndown(clean).replace(/\n\s*\n+/g, '\n\n').slice(0, MAX_CHARS);
}

// plain emails, mailto links and cloudflare protected ones (data-cfemail = hex, first byte is the xor key)
export function extractEmails(html: string): string[]
{
    const found = [...html.replace(/%40/g, '@').matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map((m) => m[0]);
    for (const [, hex = ''] of html.matchAll(/data-cfemail="([0-9a-f]+)"/gi))
    {
        const key = parseInt(hex.slice(0, 2), 16);
        found.push(hex.slice(2).replace(/../g, (pair) => String.fromCharCode(parseInt(pair, 16) ^ key)));
    }

    return [...new Set(found.map((email) => email.toLowerCase()))].filter((email) => !NOT_EMAIL.test(email)).slice(0, 20);
}

const hostOf = (url: string): string => new URL(url).hostname.replace(/^www\./, '');

function absolute(href: string, base: string): string | null
{
    try
    {
        const url = new URL(href, base);
        url.hash = '';
        return url.protocol.startsWith('http') ? url.href : null;
    }
    catch
    {
        return null;
    }
}

// emails, telegram links and same site contact pages on one html page
export function findContacts(html: string, pageUrl: string): Contact[]
{
    const contacts: Contact[] = extractEmails(html).map((value) => ({ value, type: 'email', found_on: pageUrl }));
    for (const [, user = ''] of html.matchAll(/https?:\/\/(?:t\.me|telegram\.me)\/([a-z0-9_]{4,})/gi))
    {
        contacts.push({ value: `https://t.me/${user}`, type: 'telegram', found_on: pageUrl });
    }

    for (const [, href = ''] of html.matchAll(/<a\b[^>]*href="([^"]+)"/gi))
    {
        const url = absolute(href, pageUrl);
        if (url && CONTACT_PAGE.test(new URL(url).pathname) && hostOf(url) === hostOf(pageUrl))
        {
            contacts.push({ value: url, type: 'contact_page', found_on: pageUrl });
        }
    }

    return contacts;
}

/*
 * Lower = better for outreach. Partnership and ads mailboxes first, then general ones,
 * then telegram, then pages where we can write (advertise first, about last).
 * An email on the site's own domain beats a gmail or an agency address.
 */
function contactScore(contact: Contact, site: string): number
{
    if (contact.type === 'email')
    {
        const [local = '', domain = ''] = contact.value.split('@');
        const own = domain.endsWith(site) || site.endsWith(domain) ? 0 : 0.5;
        if (/partner|affiliat|advert|ads|marketing|business|media|sales|collab|pr$|commercial/.test(local))
        {
            return 0 + own;
        }

        if (/support|help|privacy|legal|abuse|dmca|career|job|complaint/.test(local))
        {
            return 3.5 + own;
        }

        return 1 + own;
    }

    if (contact.type === 'telegram')
    {
        return 2;
    }

    const path = new URL(contact.value).pathname;
    return /advertis|write-for-us|partner|affiliate|work-with-us/i.test(path) ? 2.5 : /contact/i.test(path) ? 3 : 4;
}

export function rankContacts(contacts: Contact[], site: string): Contact[]
{
    const unique = new Map<string, Contact>();
    for (const contact of contacts)
    {
        if (!unique.has(contact.value.toLowerCase()))
        {
            unique.set(contact.value.toLowerCase(), contact);
        }
    }

    return [...unique.values()].sort((a, b) => contactScore(a, site) - contactScore(b, site)).slice(0, 15);
}

async function download(url: string, attempts: number): Promise<string>
{
    return withRetry(`fetch ${url}`, async () =>
    {
        const response = await proxyFetch(url, {
            signal: AbortSignal.timeout(30000),
            headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-CA,en;q=0.9' },
            dispatcher,
        });
        if (!response.ok)
        {
            throw new HttpError(response.status, `HTTP ${response.status}`);
        }

        const html = await response.text();
        if (BOT_WALL.test(html.slice(0, 20000)))
        {
            throw new HttpError(403, 'bot protection page');
        }

        return html;
    }, attempts);
}

/*
 * Many urls share a domain (casinocanada.com shows up 5 times), so contact pages are
 * looked at once per domain. We open at most 2 of them: the best contact links the page
 * has, or the usual paths when it has none (or we couldnt read the page at all).
 */
const domainContacts = new Map<string, Promise<Contact[]>>();

function contactsOfSite(pageUrl: string, onPage: Contact[]): Promise<Contact[]>
{
    const site = hostOf(pageUrl);
    let cached = domainContacts.get(site);
    if (!cached)
    {
        const links = rankContacts(onPage, site).filter((c) => c.type === 'contact_page').map((c) => c.value);
        const targets = (links.length ? links : DEFAULT_CONTACT_PATHS.map((path) => new URL(path, pageUrl).href)).slice(0, 2);
        cached = Promise.all(targets.map(async (url) =>
        {
            try
            {
                return findContacts(await download(url, 1), url).filter((c) => c.type !== 'contact_page')
                    // the page opened, so it is a real place to write even without an email
                    .concat({ value: url, type: 'contact_page', found_on: url });
            }
            catch
            {
                return [];
            }
        })).then((lists) => lists.flat());
        domainContacts.set(site, cached);
    }

    return cached;
}

function images(html: string, pageUrl: string): Image[]
{
    const found: Image[] = [];
    for (const [tag] of html.matchAll(/<img\b[^>]*>/gi))
    {
        const alt = /\balt="([^"]*)"/i.exec(tag)?.[1]?.trim() ?? '';
        const src = absolute(/\b(?:data-src|src)="([^"]+)"/i.exec(tag)?.[1] ?? '', pageUrl);
        if (alt && src)
        {
            found.push({ src, alt });
        }
    } 

    return found.slice(0, 100);
}

export async function fetchPage(url: string): Promise<Page>
{
    let html = '';
    let error: string | null = null;
    try
    {
        html = await download(url, 2);
    }
    catch (failure)
    {
        error = (failure as Error).message;
    }

    // contact pages are tried even when the page itself was blocked, they are often not behind the wall
    const onPage = html ? findContacts(html, url) : [];
    const contacts = rankContacts([...onPage, ...await contactsOfSite(url, onPage)], hostOf(url));
    return {
        ok: html !== '',
        error,
        title: /<title[^>]*>([^<]*)/i.exec(html)?.[1]?.trim() ?? '',
        markdown: html ? htmlToMarkdown(html) : '',
        images: html ? images(html, url) : [],
        contacts,
    };
}
