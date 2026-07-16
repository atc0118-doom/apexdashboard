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
const REDDIT_APEXLEGENDS_RSS = 'https://www.reddit.com/r/apexlegends/.rss';
const REDDIT_COMPETITIVEAPEX_RSS = 'https://www.reddit.com/r/CompetitiveApex/.rss';

// Reddit asks for a descriptive User-Agent (platform:app-id:version (by /u/username)).
// A generic UA gets rate-limited/blocked much more often. Replace the placeholder
// with your own reddit username if you have one — it isn't required to work, but
// it's the format Reddit's own docs recommend and makes 429s less likely.
const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT || 'web:apex-watch-dashboard:v1.1 (by /u/apex_watch_dev)';

const APEX_STATUS_API_KEY = process.env.APEX_STATUS_API_KEY || '';
const APEX_STATUS_SERVERS_URL = `https://api.mozambiquehe.re/servers?auth=${APEX_STATUS_API_KEY}`;
const APEX_STATUS_MAPROTATION_URL = `https://api.mozambiquehe.re/maprotation?auth=${APEX_STATUS_API_KEY}&version=2`;

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
    keywords: ['patch notes', 'nerf', 'buff', 'balance update', 'hotfix', 'rework'],
    keywordsJa: ['パッチノート', '弱体化', '強化調整', 'ナーフ', 'バフ', 'アップデート情報', '調整内容']
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

async function fetchServerStatus() {
  if (!APEX_STATUS_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(APEX_STATUS_SERVERS_URL);
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
    const res = await fetchWithTimeout(APEX_STATUS_MAPROTATION_URL);
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

  const [serverStatus, mapRotation] = await Promise.all([fetchServerStatus(), fetchMapRotation()]);

  const categoryCounts = CATEGORY_RULES.reduce((acc, rule) => {
    acc[rule.key] = { label: rule.label, count: 0 };
    return acc;
  }, {});
  for (const item of items) categoryCounts[item.category].count++;

  return {
    items: items.slice(0, 60),
    categoryCounts,
    serverStatus,  // null = no API key configured; { error } = key configured but request failed; else real data
    mapRotation,
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
