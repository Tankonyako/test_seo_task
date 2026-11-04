import { HttpError, withRetry, type Region } from './config.ts';

export interface SerpItem
{
    position: number;
    url: string;
    domain: string;
    title: string;
    snippet: string;
}

export function domainOf(url: string): string
{
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

// top N organic results (no ads, no maps) for one keyword in one region
export async function searchGoogle(keyword: string, region: Region, topN: number, apiKey: string): Promise<SerpItem[]>
{
    const params = new URLSearchParams({
        engine: 'google',
        q: keyword,
        google_domain: region.googleDomain,
        gl: region.gl,
        hl: region.hl,
        location: region.location,
        device: region.device,
        api_key: apiKey,
    });

    const body = await withRetry(`serpapi "${keyword}"`, async () =>
    {
        const response = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(60000) });
        const json = await response.json() as { error?: string; organic_results?: { position: number; link: string; title?: string; snippet?: string }[] };
        if (!response.ok)
        {
            throw new HttpError(response.status, `SerpAPI ${response.status} ${json.error ?? ''}`);
        }

        return json;
    });

    // SerpAPI answers 200 + error when google has no results, anything else is a real error
    if (body.error && !/any results/i.test(body.error))
    {
        throw new Error(`SerpAPI: ${body.error}`);
    }

    return (body.organic_results ?? [])
        .sort((a, b) => a.position - b.position)
        .slice(0, topN)
        .map((row) => ({
            position: row.position,
            url: row.link.split('#')[0] ?? row.link,
            domain: domainOf(row.link),
            title: row.title ?? '',
            snippet: row.snippet ?? '',
        }));
}
