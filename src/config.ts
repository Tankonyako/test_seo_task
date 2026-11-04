import { readFileSync } from 'node:fs';

export interface Region
{
    id: string;
    googleDomain: string;
    gl: string;
    hl: string;
    location: string;
    device: string;
}

export interface Keyword
{
    keyword: string;
    cluster: string;
}

function need(name: string): string
{
    const value = process.env[name]?.trim();
    if (!value)
    {
        throw new Error(`${name} is missing in .env (copy .example.env to .env and fill it)`);
    }

    return value;
}

function num(name: string, fallback: number): number
{
    const value = Number(process.env[name] || fallback);
    if (!Number.isFinite(value) || value < 0)
    {
        throw new Error(`${name} in .env must be a number`);
    }

    return value;
}

export function loadConfig()
{
    const file = JSON.parse(readFileSync('config.json', 'utf8')) as { topN: number; regions: Region[]; keywords: Keyword[] };
    if (!file.regions?.length || !file.keywords?.length)
    {
        throw new Error('config.json needs at least one region and one keyword');
    }

    return {
        ...file,
        serpApiKey: need('SERPAPI_KEY'),
        // any api that speaks the openai chat format: openai itself, deepseek, openrouter, a local ollama
        llm: {
            baseUrl: process.env['LLM_BASE_URL']?.trim() || 'https://api.openai.com/v1',
            model: need('LLM_MODEL'),
            apiKey: need('LLM_API_KEY'),
        },
        // pages labelled at once, each one waits on the site and then the llm, so more workers = faster run
        concurrency: Math.max(1, num('LLM_CONCURRENCY', 12)),
        ttlDays: num('ANALYSIS_TTL_DAYS', 30),
        outputDir: 'output',
    };
}

export type Config = ReturnType<typeof loadConfig>;

// small retry for our own fetch calls: network errors, 429 and 5xx are tried again with backoff
export async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T>
{
    for (let attempt = 1; ; attempt++)
    {
        try
        {
            return await fn();
        }
        catch (error)
        {
            const status = (error as { status?: number }).status;
            const retryable = status === undefined || status === 429 || status >= 500;
            if (attempt >= attempts || !retryable)
            {
                throw error;
            }

            console.log(`  ${label}: ${(error as Error).message}, retry ${attempt}`);
            await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** (attempt - 1)));
        }
    }
}

export class HttpError extends Error
{
    status: number;

    constructor(status: number, message: string)
    {
        super(message);
        this.status = status;
    }
}
