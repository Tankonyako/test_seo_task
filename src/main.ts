/*
 * Run: Google top N for every region x keyword, then every url of the day
 * without a fresh label is fetched and labelled by the llm. All goes to output/ as json + csv.
 * A failed keyword or page is logged and skipped, it never stops the rest. Exit 0 ok, 1 crash, 2 had errors.
 */
import { loadConfig } from './config.ts';
import { createLabeler } from './llm.ts';
import { fetchPage } from './page.ts';
import { searchGoogle, type SerpItem } from './serp.ts';
import { loadDb, replaceDay, saveDb, writeRaw, type RunRow } from './store.ts';

// a missing key or broken config.json is one readable line, not a stack trace
function loadConfigOrStop(): ReturnType<typeof loadConfig>
{
    try
    {
        return loadConfig();
    }
    catch (error)
    {
        console.error(`stopped: ${(error as Error).message}`);
        process.exit(1);
    }
}

const config = loadConfigOrStop();
const db = loadDb(config.outputDir);
const label = createLabeler(config.llm);
const llmName = `${new URL(config.llm.baseUrl).hostname}/${config.llm.model}`;
const reanalyze = process.argv.includes('--reanalyze');

// date in canada, so a run late at night utc still files results under the right canadian day
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
const run: RunRow = {
    date, started_at: new Date().toISOString(), finished_at: '', status: 'ok', searches: 0,
    pages_labelled: 0, pages_reused: 0, llm: llmName, tokens_in: 0, tokens_out: 0, errors: [],
};
console.log(`run ${date}, ${config.regions.length} region(s) x ${config.keywords.length} keywords, llm ${llmName}`);

const startedAt = Date.now();

// a few workers at once, each takes the next item from a shared queue. Most time is waiting on network
async function inParallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>
{
    const queue = [...items];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () =>
    {
        for (let item = queue.shift(); item !== undefined; item = queue.shift())
        {
            await fn(item);
        }
    }));
}

// 1. serp, all region x keyword searches at once. url -> first serp item seen, its title and snippet help when the page is blocked
const todayUrls = new Map<string, SerpItem>();
const searches = config.regions.flatMap((region) => config.keywords.map((keyword) => ({ region, ...keyword })));
await inParallel(searches, 10, async ({ region, keyword, cluster }) =>
{
    run.searches++;
    try
    {
        const items = await searchGoogle(keyword, region, config.topN, config.serpApiKey);
        replaceDay(db, date, region.id, keyword, items.map((item) => ({ date, region: region.id, keyword, cluster, position: item.position, url: item.url, domain: item.domain })));
        saveDb(config.outputDir, db);
        items.forEach((item) => todayUrls.has(item.url) || todayUrls.set(item.url, item));
        console.log(`serp [${region.id}] "${keyword}": ${items.length} results`);
    }
    catch (error)
    {
        run.errors.push(`serp [${region.id}] "${keyword}": ${(error as Error).message}`);
        console.log(`serp [${region.id}] "${keyword}" FAILED: ${(error as Error).message}`);
    }
});

// 2. label urls with no label yet, an old one, or one made from the snippet only (site was blocked, try again)
const freshAfter = Date.now() - config.ttlDays * 86400000;
const todo = [...todayUrls.values()].filter((item) =>
{
    const known = db.pages[item.url];
    return reanalyze || !known || known.source === 'snippet' || Date.parse(known.analyzed_at) < freshAfter;
});
run.pages_reused = todayUrls.size - todo.length;
console.log(`${todo.length} urls to label, ${run.pages_reused} already labelled`);

async function labelOne(serp: SerpItem): Promise<void>
{
    try
    {
        const page = await fetchPage(serp.url);
        const result = await label(serp, page);
        db.pages[serp.url] = {
            url: serp.url, domain: serp.domain, ...result.label, contacts_found: page.contacts.map((c) => c.value),
            source: page.ok ? 'page' : 'snippet', fetch_error: page.error, analyzed_at: new Date().toISOString(),
        };
        saveDb(config.outputDir, db);

        // where each brand was seen, so a manager can check the label
        const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
        const alts = squash(page.images.map((image) => image.alt).join(' '));
        writeRaw(config.outputDir, serp.url, {
            url: serp.url, google: serp, label: result.label, source: page.ok ? 'page' : 'snippet', fetch_error: page.error,
            brands: result.label.brands.map((brand) => ({
                brand,
                found_in: alts.includes(squash(brand)) ? 'image alt' : squash(page.markdown).includes(squash(brand)) ? 'text' : 'google snippet',
            })),
            contacts: page.contacts,
            images: page.images,
        }, page.markdown);
        run.tokens_in += result.tokensIn;
        run.tokens_out += result.tokensOut;
        run.pages_labelled++;
        console.log(`[${run.pages_labelled}/${todo.length}] ${result.label.relevant ? 'YES' : 'no '} ${result.label.site_type.padEnd(20)} ${serp.url}`);
    }
    catch (error)
    {
        // not saved, so the next run tries this url again
        run.errors.push(`page ${serp.url}: ${(error as Error).message}`);
        console.log(`page ${serp.url} FAILED: ${(error as Error).message}`);
    }
}

await inParallel(todo, config.concurrency, labelOne);

// 3. save the run
run.status = run.errors.length ? 'partial' : 'ok';
run.finished_at = new Date().toISOString();
db.runs.push(run);
saveDb(config.outputDir, db);

console.log(`done: ${run.status}, ${run.searches} searches, ${run.pages_labelled} labelled, ${run.pages_reused} reused, `
    + `tokens ${run.tokens_in} in / ${run.tokens_out} out, took ${Math.round((Date.now() - startedAt) / 1000)}s`);
run.errors.forEach((error) => console.log(`  error: ${error}`));
process.exitCode = run.errors.length ? 2 : 0;
