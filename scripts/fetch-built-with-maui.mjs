import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const SOURCE_URL =
  'https://raw.githubusercontent.com/jfversluis/built-with-maui/refs/heads/main/README.md';
const OUTPUT_PATH = resolve(process.cwd(), 'src/content/built-with-maui/apps.md');
const DATA_OUTPUT_PATH = resolve(process.cwd(), 'src/data/built-with-maui-apps.generated.ts');
const SECTION_HEADING = '## Apps built with .NET MAUI';

function extractAppsSection(markdown) {
  const start = markdown.indexOf(SECTION_HEADING);
  if (start === -1) {
    throw new Error(`Could not find section heading "${SECTION_HEADING}".`);
  }

  const rest = markdown.slice(start);
  const nextHeadingMatch = rest.slice(SECTION_HEADING.length).match(/\n##\s+/);
  const end =
    nextHeadingMatch === null
      ? markdown.length
      : start + SECTION_HEADING.length + nextHeadingMatch.index + 1;

  return markdown.slice(start, end).trim();
}

function normalizeNestedLinks(markdown) {
  // Upstream occasionally contains nested markdown links in a cell:
  // [label]([https://foo](https://bar)) -> [label](https://bar)
  return markdown.replace(/\]\(\[[^\]]+\]\((https?:\/\/[^)\s]+)\)\)/g, ']($1)');
}

function replaceIconLinks(markdown) {
  const iconLabelMap = {
    android: 'Android',
    ios: 'iOS',
    windows: 'Windows',
    website: 'Website',
    github: 'GitHub',
  };

  return markdown.replace(
    /\[\s*<img[^>]*src="assets\/([^"./]+)\.png"[^>]*>\s*\]\((https?:\/\/[^)\s]+)\)/gi,
    (_match, iconName, url) => {
      const key = String(iconName).toLowerCase();
      const label = iconLabelMap[key] ?? 'Link';
      return `[${label}](${url})`;
    }
  );
}

/**
 * Parse the markdown table rows into structured app objects.
 */
function parseAppsTable(markdown) {
  const lines = markdown.split('\n');
  const apps = [];

  for (const line of lines) {
    // Match table data rows (skip header and separator)
    if (!line.startsWith('|') || line.includes('----') || line.includes('App Name')) continue;

    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;

    const name = cells[0].replace(/\*\*/g, '').trim();
    const description = cells[1].trim();
    const downloads = cells[2].replace(/<br\s*\/?>/gi, ', ').trim();
    const linksCell = cells[3] ?? '';

    // Extract links from markdown link syntax
    const links = {};
    const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
    let match;
    while ((match = linkRegex.exec(linksCell)) !== null) {
      const label = match[1].trim().toLowerCase();
      const url = match[2];
      if (label === 'android') links.android = url;
      else if (label === 'ios') links.ios = url;
      else if (label === 'windows') links.windows = url;
      else if (label === 'website') links.website = url;
      else if (label === 'github') links.github = url;
      else links[label] = url;
    }

    apps.push({ name, description, downloads, links });
  }

  return apps;
}

/**
 * Extract the Apple App Store ID from an App Store URL.
 */
function extractAppStoreId(url) {
  const match = url.match(/\/id(\d+)/);
  return match ? match[1] : null;
}

/**
 * Fetch app icon URLs from the iTunes Lookup API for apps with iOS links.
 */
async function fetchAppIcons(apps) {
  const idsToFetch = [];

  for (const app of apps) {
    if (app.links.ios) {
      const appId = extractAppStoreId(app.links.ios);
      if (appId) idsToFetch.push(appId);
    }
  }

  if (idsToFetch.length === 0) return {};

  const iconMap = {};

  // Batch fetch in groups of 20 to avoid overwhelming the API
  const batchSize = 20;
  for (let i = 0; i < idsToFetch.length; i += batchSize) {
    const batch = idsToFetch.slice(i, i + batchSize);
    const lookupUrl = `https://itunes.apple.com/lookup?id=${batch.join(',')}&entity=software`;

    try {
      const response = await fetch(lookupUrl);
      if (response.ok) {
        const data = await response.json();
        for (const result of data.results ?? []) {
          if (result.artworkUrl512) {
            iconMap[String(result.trackId)] = result.artworkUrl512;
          } else if (result.artworkUrl100) {
            iconMap[String(result.trackId)] = result.artworkUrl100;
          }
        }
      }
    } catch {
      // Silently continue — icons are best-effort
    }
  }

  return iconMap;
}

async function run() {
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch markdown: ${response.status} ${response.statusText}`);
  }

  const markdown = await response.text();
  const appsSection = replaceIconLinks(normalizeNestedLinks(extractAppsSection(markdown)));
  const fetchedAt = new Date().toISOString();

  // Write the markdown content file (existing behavior)
  const output = `---
title: Apps built with .NET MAUI
source: ${SOURCE_URL}
fetchedAt: ${fetchedAt}
---

${appsSection}
`;

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, output, 'utf8');
  console.log(`Wrote ${OUTPUT_PATH}`);

  // Parse structured data from the table
  const apps = parseAppsTable(appsSection);
  console.log(`Parsed ${apps.length} apps from table`);

  // Fetch app icons from App Store
  console.log('Fetching app icons from App Store...');
  const iconMap = await fetchAppIcons(apps);
  console.log(`Fetched ${Object.keys(iconMap).length} app icons`);

  // Enrich apps with icon URLs
  for (const app of apps) {
    if (app.links.ios) {
      const appId = extractAppStoreId(app.links.ios);
      if (appId && iconMap[appId]) {
        app.iconUrl = iconMap[appId];
      }
    }
  }

  // Write structured data file
  const dataOutput = `// This file is generated by scripts/fetch-built-with-maui.mjs.
// Do not edit manually.

export interface AppLink {
  android?: string;
  ios?: string;
  windows?: string;
  website?: string;
  github?: string;
  [key: string]: string | undefined;
}

export interface MauiApp {
  name: string;
  description: string;
  downloads: string;
  links: AppLink;
  iconUrl?: string;
}

export const apps: MauiApp[] = ${JSON.stringify(apps, null, 2)};

export const fetchedAt = ${JSON.stringify(fetchedAt)};
`;

  await mkdir(dirname(DATA_OUTPUT_PATH), { recursive: true });
  await writeFile(DATA_OUTPUT_PATH, dataOutput, 'utf8');
  console.log(`Wrote ${DATA_OUTPUT_PATH}`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
