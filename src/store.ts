import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Label } from './llm.ts';

// one serp row, unique by (date, region, keyword, position)
export interface PositionRow
{
    date: string;
    region: string;
    keyword: string;
    cluster: string;
    position: number;
    url: string;
    domain: string;
}

export interface PageRow extends Label
{
    url: string;
    domain: string;
    // every contact we found, best first. Where each one was found is in output/raw
    contacts_found: string[];
    // 'page' = we read the html, 'snippet' = site blocked us, label is from google title + snippet only
    source: 'page' | 'snippet';
    fetch_error: string | null;
    analyzed_at: string;
}

export interface RunRow
{
    date: string;
    started_at: string;
    finished_at: string;
    status: 'ok' | 'partial';
    searches: number;
    pages_labelled: number;
    pages_reused: number;
    llm: string;
    tokens_in: number;
    tokens_out: number;
    errors: string[];
}

export interface Db
{
    runs: RunRow[];
    positions: PositionRow[];
    // keyed by url, so a url is labelled once however many keywords show it
    pages: Record<string, PageRow>;
}

/*
 * There is no separate db: output/positions.json, pages.json and runs.json ARE the data.
 * The next run reads them back, so history and labels carry over. Empty folder = fresh start.
 */
export function loadDb(dir: string): Db
{
    const read = <T>(name: string): T[] =>
        existsSync(join(dir, `${name}.json`)) ? JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as T[] : [];

    return {
        runs: read<RunRow>('runs'),
        // positions.json also carries label columns for reading, only the serp fields are data
        positions: read<PositionRow>('positions').map(({ date, region, keyword, cluster, position, url, domain }) =>
            ({ date, region, keyword, cluster, position, url, domain })),
        pages: Object.fromEntries(read<PageRow>('pages').map((page) => [page.url, page])),
    };
}

// temp file + rename, so a crash in the middle of a write never leaves a broken file
function writeAtomic(file: string, content: string): void
{
    writeFileSync(`${file}.tmp`, content);
    renameSync(`${file}.tmp`, file);
}

// a rerun on the same day replaces that day's rows instead of adding, so there are never duplicates
export function replaceDay(db: Db, date: string, region: string, keyword: string, rows: PositionRow[]): void
{
    db.positions = db.positions
        .filter((row) => !(row.date === date && row.region === region && row.keyword === keyword))
        .concat(rows);
}

/*
 * output/raw/<site>_<path>.md is exactly what the llm read, .json next to it says where things were found:
 * each contact with the page it came from, every image with alt text (logos), and for each brand
 * whether it was in the text, in an image alt or only in the google snippet.
 */
export function writeRaw(dir: string, url: string, evidence: Record<string, unknown>, markdown: string): void
{
    const name = url.replace(/^https?:\/\/(www\.)?/, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 120);
    mkdirSync(join(dir, 'raw'), { recursive: true });
    writeFileSync(join(dir, 'raw', `${name}.json`), JSON.stringify(evidence, null, 2) + '\n');
    writeFileSync(join(dir, 'raw', `${name}.md`), markdown || '(page could not be downloaded, label is from the google snippet)\n');
}

// csv cell: lists as "a, b", true/false as yes/no, quotes when needed
function cell(value: unknown): string
{
    const text = Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// same rows twice: pretty json (also what the next run reads), csv for any sheets editor (BOM so excel reads utf-8)
function writeTable(dir: string, name: string, rows: Record<string, unknown>[]): void
{
    writeAtomic(join(dir, `${name}.json`), JSON.stringify(rows, null, 2) + '\n');
    const header = Object.keys(rows[0] ?? {});
    const lines = [header.join(','), ...rows.map((row) => header.map((key) => cell(row[key])).join(','))];
    writeAtomic(join(dir, `${name}.csv`), '﻿' + lines.join('\n') + '\n');
}

export function saveDb(dir: string, db: Db): void
{
    mkdirSync(dir, { recursive: true });
    const dates = [...new Set(db.positions.map((row) => row.date))].sort();

    // previous_position = same url, keyword and region on the run date before, empty = new in the top
    const positionOn = new Map(db.positions.map((row) => [`${row.date}|${row.region}|${row.keyword}|${row.url}`, row.position]));
    writeTable(dir, 'positions', [...db.positions]
        .sort((a, b) => b.date.localeCompare(a.date) || a.region.localeCompare(b.region) || a.keyword.localeCompare(b.keyword) || a.position - b.position)
        .map((row) =>
        {
            const before = dates[dates.indexOf(row.date) - 1];
            const page = db.pages[row.url];
            return {
                ...row,
                previous_position: before ? positionOn.get(`${before}|${row.region}|${row.keyword}|${row.url}`) ?? null : null,
                relevant: page?.relevant ?? null,
                site_type: page?.site_type ?? null,
                brands: page?.brands ?? [],
                contact: page?.contact ?? null,
            };
        }));

    writeTable(dir, 'pages', Object.values(db.pages)
        .sort((a, b) => Number(b.relevant) - Number(a.relevant) || b.profit - a.profit || a.domain.localeCompare(b.domain))
        .map((page) => ({ ...page })));

    writeTable(dir, 'runs', db.runs.map((run) => ({ ...run })));
}
