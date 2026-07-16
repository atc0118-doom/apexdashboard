// api/apex.js
// Apex Legends Dashboard — data aggregation endpoint (Vercel serverless function)
//
// Sources (no API key required):
//   - Google News RSS (EN)  — general Apex Legends news
//   - Google News RSS (EN)  — ALGS / esports specific query
//   - Google News RSS (JA)  — 日本語ニュース（エーペックスレジェンズ）
//   - Reddit r/apexlegends RSS
//   - Reddit r/CompetitiveApex RSS
//
// Server status + map rotation use the Apex Legends Status API
// (apexlegendsapi.com, free registration). If APEX_STATUS_API_KEY is not
// set, that section is simply omitted (returned as null) instead of erroring.
//
// Response shape: { items, categoryCounts, serverStatus, mapRotation, report, generatedAt }

const GOOGLE_NEWS_APEX_URL =
  'https://news.google.com/rss/search?q=%22Apex%20Legends%22&hl=en-US&gl=US&ceid=US:en';
const GOOGLE_NEWS_ALGS_URL =
  'https://news.google.com/rss/search?q=ALGS%20%22Apex%20Legends%22%20esports&hl=en-US&gl=US&ceid=US:en';
const GOOGLE_NEWS_JP_URL =
  'https://news.google.com/rss/search?q=%22エーペックスレジェンズ%22&hl=ja&gl=JP&ceid=JP:ja';
const GOOGLE_NEWS_TIERLIST_URL =
  'https://news.google.com/rss/search?q=%22Apex%20Legends%22%20%22tier%20list%22&hl=en-US&gl=US&ceid=US:en';
const REDDIT_APEXLEGENDS_RSS = 'https://www.reddit.com/r/apexlegends/top/.rss?t=day'; // top-of-day, not raw newest — cuts down on low-signal chatter
const REDDIT_COMPETITIVEAPEX_RSS = 'https://www.reddit.com/r/CompetitiveApex/.rss';

// Reddit asks for a descriptive User-Agent (platform:app-id:version (by /u/username)).
// The username part is meant to identify a real account, so the default here
// doesn't invent one — it's still descriptive enough to avoid the generic-UA
// penalty, but if you have a Reddit account, set REDDIT_USER_AGENT in Vercel
// env vars to something like "web:apex-watch-dashboard:v1.2 (by /u/yourname)"
// for the best treatment from Reddit's side.
const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT || 'web:apex-watch-dashboard:v1.2 (personal non-commercial project)';

const APEX_STATUS_API_KEY = process.env.APEX_STATUS_API_KEY || '';
const APEX_STATUS_SERVERS_URL = 'https://api.apexlegendsstatus.com/servers';
const APEX_STATUS_MAPROTATION_URL = 'https://api.apexlegendsstatus.com/maprotation?version=2';
const APEX_STATUS_PREDATOR_URL = 'https://api.apexlegendsstatus.com/predator';

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = { data: null, ts: 0 };

// Category keyword rules. Keep entries specific — a bare substring like "lan"
// matches "landing" in almost every Apex article/post, which is exactly the
// false-positive bug from the earlier "strait" issue in ORACLE. Every keyword
// here was chosen to avoid matching ordinary English/Japanese words.
const CATEGORY_RULES = [
  {
    key: 'patch',
    label: 'パッチ / メタ',
    keywords: ['patch notes', 'nerf', 'buff', 'balance update', 'hotfix', 'rework', 'tier list'],
    keywordsJa: ['パッチノート', '弱体化', '強化調整', 'ナーフ', 'バフ', 'アップデート情報', '調整内容', 'ティア表']
  },
  {
    key: 'esports',
    label: 'eスポーツ / ALGS',
    keywords: ['algs', 'championship', 'esports tournament', 'playoffs', 'scrim', 'grand finals'],
    keywordsJa: ['algs', '大会優勝', '決勝', 'eスポーツ']
  },
  {
    key: 'outage',
    label: 'サーバー / 障害',
    keywords: ['servers down', 'server outage', 'server maintenance', 'ddos', 'connection issue'],
    keywordsJa: ['障害情報', 'メンテナンス', 'サーバーダウン', '接続エラー']
  },
  { key: 'general', label: '一般ニュース', keywords: [], keywordsJa: [] } // fallback bucket
];

function categorize(title) {
  const lower = title.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.key === 'general') continue;
    const hitEn = rule.keywords.some(k => lower.includes(k));
    const hitJa = rule.keywordsJa.some(k => title.includes(k));
    if (hitEn || hitJa) return rule.key;
  }
  return 'general';
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// Minimal, dependency-free RSS/Atom parser.
function parseRss(xml, sourceName) {
  const isAtom = xml.includes('<feed');
  const entryTag = isAtom ? 'entry' : 'item';
  const blocks = [...xml.matchAll(new RegExp(`<${entryTag}>([\\s\\S]*?)</${entryTag}>`, 'g'))];

  return blocks.map(([, block]) => {
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    let title = titleMatch ? titleMatch[1] : '';
    title = title.replace('<![CDATA[', '').replace(']]>', '').trim();

    let link = '';
    if (isAtom) {
      const linkMatch = block.match(/<link[^>]*href="([^"]+)"/);
      link = linkMatch ? linkMatch[1] : '';
    } else {
      const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
      link = linkMatch ? linkMatch[1].trim() : '';
    }

    const dateMatch = block.match(/<(?:pubDate|published|updated)>([\s\S]*?)<\/(?:pubDate|published|updated)>/);
    const published = dateMatch ? dateMatch[1].trim() : null;

    return {
      title,
      link,
      published,
      source: sourceName,
      category: categorize(title)
    };
  }).filter(item => item.title);
}

async function fetchRss(url, sourceName, headers = {}) {
  const res = await fetchWithTimeout(url, { headers: { 'user-agent': 'ApexDash/1.1', ...headers } });
  if (!res.ok) throw new Error(`${sourceName} ${res.status}`);
  const xml = await res.text();
  return parseRss(xml, sourceName);
}

// Dedupe by a normalized title "stem". Uses \p{L}/\p{N} (Unicode letter/number
// classes) instead of [a-z0-9] so Japanese titles aren't collapsed to an empty
// string and silently dropped as "duplicates" of each other.
function dedupeByTitleStem(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const stem = item.title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .slice(0, 60);
    if (stem && seen.has(stem)) continue;
    if (stem) seen.add(stem);
    out.push(item);
  }
  return out;
}

async function fetchAlsJson(url) {
  const res = await fetchWithTimeout(url, { headers: { Authorization: APEX_STATUS_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const json = await res.json();
  // This API sometimes returns HTTP 200 with an inline {"Error": "..."} body
  // instead of a real error status code (seen on some endpoints: "Unauthorized.
  // You must be..."). Treat that the same as a thrown HTTP error so it
  // surfaces as a proper error message instead of falling into the
  // "unrecognized shape" fallback.
  if (json && typeof json === 'object' && json.Error) {
    throw new Error(json.Error);
  }
  return json;
}

async function fetchPredator() {
  if (!APEX_STATUS_API_KEY) return null;
  try {
    return await fetchAlsJson(APEX_STATUS_PREDATOR_URL);
    // Unverified shape — expected roughly { RP: { PC: {val, ...}, PS4: {...}, X1: {...}, SWITCH: {...} }, Masters: {...} }
    // The frontend renders defensively and won't crash if this guess is off.
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchServerStatus() {
  if (!APEX_STATUS_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(APEX_STATUS_SERVERS_URL, {
      headers: { Authorization: APEX_STATUS_API_KEY }
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const raw = await res.json();
    // Real shape: { Origin_login: { "US-West": { Status, ResponseTime }, "US-East": {...}, ... }, ... }
    const regions = raw.Origin_login || {};
    const entries = Object.entries(regions).map(([region, info]) => ({
      region,
      status: info?.Status || 'UNKNOWN',
      responseTime: info?.ResponseTime ?? null
    }));
    const allUp = entries.length > 0 && entries.every(r => /up/i.test(r.status));
    return { regions: entries, allUp };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchMapRotation() {
  if (!APEX_STATUS_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(APEX_STATUS_MAPROTATION_URL, {
      headers: { Authorization: APEX_STATUS_API_KEY }
    });
    if (!res.ok) throw new Error(`maprotation ${res.status}`);
    return await res.json(); // { battle_royale: { current: { map, remainingTimer }, next: {...} }, ranked: {...}, ... }
  } catch (e) {
    return { error: e.message };
  }
}

async function buildDashboard() {
  const collectors = [
    ['Google News', () => fetchRss(GOOGLE_NEWS_APEX_URL, 'Google News')],
    ['Google News (ALGS)', () => fetchRss(GOOGLE_NEWS_ALGS_URL, 'Google News')],
    ['Google News (Tier List)', () => fetchRss(GOOGLE_NEWS_TIERLIST_URL, 'Google News')],
    ['Google News (JP)', () => fetchRss(GOOGLE_NEWS_JP_URL, 'Google News JP')],
    ['r/apexlegends', () => fetchRss(REDDIT_APEXLEGENDS_RSS, 'r/apexlegends', { 'user-agent': REDDIT_USER_AGENT })],
    ['r/CompetitiveApex', () => fetchRss(REDDIT_COMPETITIVEAPEX_RSS, 'r/CompetitiveApex', { 'user-agent': REDDIT_USER_AGENT })]
  ];

  const settled = await Promise.allSettled(collectors.map(([, fn]) => fn()));

  const report = settled.map((r, i) => {
    const name = collectors[i][0];
    if (r.status === 'fulfilled') return { name, ok: true, count: r.value.length };
    return { name, ok: false, count: 0, error: r.reason?.message || 'error' };
  });

  let items = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') items.push(...r.value);
  }
  items = dedupeByTitleStem(items).sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));

  // Hard recency cutoff — without this, the item-count cap alone lets weeks-old
  // articles linger during slow news periods (they just never get pushed out).
  // Items with no parseable date are kept rather than dropped, since we can't
  // confirm they're stale.
  const RECENCY_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - RECENCY_CUTOFF_MS;
  items = items.filter(item => !item.published || new Date(item.published).getTime() >= cutoff);

  // Cap AFTER computing counts from the SAME list we return — otherwise the
  // category counts (computed over everything fetched) don't match what's
  // actually shown (only the top N by recency), which is exactly the
  // confusing "83 esports items but I don't see them" symptom.
  const CAP = 150;
  items = items.slice(0, CAP);

  let serverStatus = null, mapRotation = null, predator = null;

  if (APEX_STATUS_API_KEY) {
    // A freshly created ALS API key is rate-limited (1 req/2s by default, more
    // once Discord-linked). Call everything sequentially with small gaps, and
    // stop firing further ALS requests this cycle as soon as one comes back
    // 429 — the next 10-minute cache cycle will retry cleanly instead of
    // digging the rate-limit hole deeper.
    let rateLimited = false;
    serverStatus = await fetchServerStatus();
    if (serverStatus?.error?.includes('429')) rateLimited = true;

    mapRotation = { error: 'skipped (rate limited)' };
    if (!rateLimited) {
      await new Promise(r => setTimeout(r, 700));
      mapRotation = await fetchMapRotation();
      if (mapRotation?.error?.includes('429')) rateLimited = true;
    }

    predator = { error: 'skipped (rate limited)' };
    if (!rateLimited) {
      await new Promise(r => setTimeout(r, 700));
      predator = await fetchPredator();
    }
  }

  const categoryCounts = CATEGORY_RULES.reduce((acc, rule) => {
    acc[rule.key] = { label: rule.label, count: 0 };
    return acc;
  }, {});
  for (const item of items) categoryCounts[item.category].count++;

  return {
    items,
    categoryCounts,
    serverStatus,  // null = no API key configured; { error } = key configured but request failed; else real data
    mapRotation,
    predator,
    report,
    generatedAt: new Date().toISOString()
  };
}

module.exports = async function handler(req, res) {
  try {
    const now = Date.now();
    if (cache.data && now - cache.ts < CACHE_TTL_MS) {
      res.setHeader('x-cache', 'HIT');
      return res.status(200).json(cache.data);
    }
    const data = await buildDashboard();
    cache = { data, ts: now };
    res.setHeader('x-cache', 'MISS');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'internal error' });
  }
};
