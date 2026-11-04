import OpenAI from 'openai';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Page } from './page.ts';
import type { SerpItem } from './serp.ts';

const SITE_TYPES = ['affiliate_review', 'news_media', 'casino_operator', 'wikipedia_reference',
    'regulator_government', 'forum_social', 'app_store', 'other'] as const;

// these can never sell us a placement, whatever the model says
const NEVER_RELEVANT = ['casino_operator', 'wikipedia_reference', 'regulator_government', 'forum_social', 'app_store'];

const LabelSchema = z.object({
    site_type: z.enum(SITE_TYPES),
    relevant: z.boolean(),
    profit: z.number().min(0).max(1),
    brands: z.array(z.string()),
    contact: z.string().nullable(),
    reason: z.string(),
});

export type Label = z.infer<typeof LabelSchema>;

const SYSTEM_PROMPT = `You label web pages for an online casino affiliate team in Canada. They want sites from Google
where they can buy a placement for their casino brands (a spot in a ranking, a review, a sponsored article).

site_type, pick one:
- affiliate_review: casino review, rating, comparison or bonus listing sites that send players to many casinos.
- news_media: newspapers, magazines, sports or gaming media. Relevant when the page is a casino ranking or a
  sponsored casino article, because those sell placements.
- casino_operator: the site IS a casino or sportsbook where people sign up and play.
- wikipedia_reference: Wikipedia, encyclopedias, dictionaries.
- regulator_government: regulators, government, lottery corporations (AGCO, iGaming Ontario, OLG, PlayNow).
- forum_social: Reddit, Quora, forums, YouTube, social networks.
- app_store: Google Play, App Store.
- other: anything else.

relevant: true only if the site could realistically sell us a placement. Casino operators, Wikipedia,
regulators, forums and app stores are always false.

brands: online casino brands mentioned on the page, as written on the site, like "Jackpot City", "Spin Casino",
"Richard Casino", "Betway". Keep "Casino" when it is part of the name. Not payment methods (Interac, PayPal),
game studios (NetEnt, Pragmatic Play), games, regulators, or the site itself. Only names written in the content
you got (text or [img: ...] alt texts). Empty list if none.

contact: ONE value copied from the candidates, they are sorted best first. Prefer partnership, advertising,
affiliate or marketing emails, then general emails, then telegram, then a contact page. null if there are no
candidates. Never invent a contact.

profit: 0 to 1, how good this site is as a placement partner for us. High for a Canadian casino ranking or bonus
site that lists many brands and shows ads or sponsored content or has an advertising contact. Low for small,
off topic or unclear sites. 0 when relevant is false.

reason: one short sentence.

Answer with one JSON object only, no markdown, exactly these keys:
{"site_type": "...", "relevant": true, "profit": 0.8, "brands": ["..."], "contact": null, "reason": "..."}`;

function userPrompt(serp: SerpItem, page: Page): string
{
    return [
        `URL: ${serp.url}`,
        `Google title: ${serp.title}`,
        `Google snippet: ${serp.snippet}`,
        `Page title: ${page.title}`,
        'Contact candidates (best first):',
        ...(page.contacts.length ? page.contacts.map((c) => `- ${c.value} (${c.type}, found on ${c.found_on})`) : ['- none']),
        page.ok
            ? `Page content as markdown:\n"""\n${page.markdown}\n"""`
            : `The page could not be downloaded (${page.error}). Decide from URL, title and snippet, keep profit low.`,
    ].join('\n');
}

const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/*
 * The model is not trusted blindly: brands must be written in the text it saw, the contact must be
 * one of our candidates (if it picks none or makes one up we take our best ranked one), and site
 * types that cant sell placements are forced to relevant = false and profit = 0.
 */ 
export function applyGuards(label: Label, serp: SerpItem, page: Page): Label
{
    const seen = squash(`${page.markdown} ${page.title} ${serp.title} ${serp.snippet}`);
    const candidates = page.contacts.map((c) => c.value);
    const picked = candidates.find((value) => value.toLowerCase() === label.contact?.trim().toLowerCase());
    const relevant = NEVER_RELEVANT.includes(label.site_type) ? false : label.relevant;
    return {
        ...label,
        relevant,
        profit: relevant ? label.profit : 0,
        brands: [...new Set(label.brands.map((brand) => brand.trim()))]
            .filter((brand) => squash(brand).length >= 3 && seen.includes(squash(brand))),
        contact: picked ?? candidates[0] ?? null,
    };
}

export function createLabeler(llm: Config['llm'])
{
    // the sdk itself retries 429, 5xx and network errors with backoff
    const client = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseUrl, maxRetries: 3, timeout: 120000 });

    return async function label(serp: SerpItem, page: Page): Promise<{ label: Label; tokensIn: number; tokensOut: number }>
    {
        // one more try when the answer is not valid json or misses a key
        for (let attempt = 1; ; attempt++)
        {
            const completion = await client.chat.completions.create({
                model: llm.model,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt(serp, page) },
                ],
                response_format: { type: 'json_object' },
                // deepseek v4 thinks by default, off = its fast mode, enough for labelling
                ...(llm.baseUrl.includes('deepseek.com') ? { thinking: { type: 'disabled' } } : {}),
            } as OpenAI.ChatCompletionCreateParamsNonStreaming);

            try
            {
                const text = (completion.choices[0]?.message.content ?? '').replace(/^```(json)?|```$/g, '').trim();
                return {
                    label: applyGuards(LabelSchema.parse(JSON.parse(text)), serp, page),
                    tokensIn: completion.usage?.prompt_tokens ?? 0,
                    tokensOut: completion.usage?.completion_tokens ?? 0,
                };
            }
            catch (error)
            {
                if (attempt >= 2)
                {
                    throw new Error(`bad llm answer: ${(error as Error).message.slice(0, 200)}`);
                }
            }
        }
    };
}
