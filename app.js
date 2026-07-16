// app.js
const CATEGORY_LABELS = {
  patch: 'パッチ / メタ',
  esports: 'eスポーツ / ALGS',
  outage: 'サーバー / 障害',
  general: '一般ニュース'
};

let state = { items: [], activeCategory: 'all' };

async function loadDashboard() {
  const feedEl = document.getElementById('feed');
  feedEl.innerHTML = '<p class="feed-loading">読み込み中…</p>';

  try {
    const res = await fetch('/api/apex');
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();

    state.items = data.items || [];
    renderGeneratedAt(data.generatedAt);
    renderStatusStrip(data.serverStatus, data.mapRotation);
    renderCategoryNav(data.categoryCounts);
    renderFeed();
  } catch (e) {
    feedEl.innerHTML = `<p class="feed-empty">取得に失敗しました: ${escapeHtml(e.message)}</p>`;
  }
}

function renderGeneratedAt(iso) {
  const el = document.getElementById('generated-at');
  if (!iso) { el.textContent = '--'; return; }
  const d = new Date(iso);
  el.textContent = `LAST SYNC ${d.toLocaleString('ja-JP', { hour12: false })}`;
}

function renderStatusStrip(serverStatus, mapRotation) {
  const strip = document.getElementById('status-strip');
  strip.innerHTML = '';

  // Neither key configured at all.
  if (serverStatus === null && mapRotation === null) {
    strip.innerHTML = `
      <div class="status-chip">
        <span class="status-dot is-unknown"></span>
        サーバー状況: APIキー未設定（apexlegendsapi.comで無料登録後、env APEX_STATUS_API_KEYを設定）
      </div>`;
    return;
  }

  // Key configured but the request itself failed — say so, don't go silent.
  if (serverStatus?.error) {
    strip.innerHTML += `
      <div class="status-chip">
        <span class="status-dot is-unknown"></span>
        サーバー状況: 取得エラー（${escapeHtml(serverStatus.error)}）
      </div>`;
  } else if (serverStatus?.regions?.length) {
    const downRegions = serverStatus.regions.filter(r => !/up/i.test(r.status));
    strip.innerHTML += `
      <div class="status-chip">
        <span class="status-dot ${serverStatus.allUp ? '' : 'is-down'}"></span>
        サーバー状況: ${serverStatus.allUp ? '全リージョン稼働中' : `${downRegions.length}リージョンで異常`}
      </div>`;
  }

  if (mapRotation?.error) {
    strip.innerHTML += `
      <div class="status-chip">
        <span class="status-dot is-unknown"></span>
        マップ情報: 取得エラー
      </div>`;
  } else if (mapRotation?.battle_royale?.current?.map) {
    strip.innerHTML += `
      <div class="status-chip">現在のマップ (BR): ${escapeHtml(mapRotation.battle_royale.current.map)}</div>`;
  }
}

function renderCategoryNav(categoryCounts) {
  const nav = document.getElementById('category-nav');
  nav.querySelectorAll('.ring-tab:not([data-category="all"])').forEach(el => el.remove());
  nav.querySelector('[data-category="all"]').textContent = 'ALL';

  if (!categoryCounts) return;

  Object.entries(categoryCounts).forEach(([key, { label, count }]) => {
    const btn = document.createElement('button');
    btn.className = 'ring-tab';
    btn.dataset.category = key;
    btn.textContent = `${label} (${count})`;
    nav.appendChild(btn);
  });
}

// Single delegated listener on the nav container instead of attaching a new
// listener to every tab on every render (the old code re-added a listener to
// the "ALL" button each refresh, so clicks fired once per prior refresh too).
document.getElementById('category-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.ring-tab');
  if (!btn) return;
  setActiveCategory(btn.dataset.category);
});

function setActiveCategory(key) {
  state.activeCategory = key;
  document.querySelectorAll('.ring-tab').forEach(el => {
    el.classList.toggle('is-active', el.dataset.category === key);
  });
  renderFeed();
}

function renderFeed() {
  const feedEl = document.getElementById('feed');

  if (state.activeCategory !== 'all') {
    const items = state.items.filter(i => i.category === state.activeCategory);
    feedEl.innerHTML = renderCardGrid(items);
    return;
  }

  // "ALL" view: group by category so the grid isn't one giant undifferentiated wall.
  const order = ['patch', 'esports', 'outage', 'general'];
  const groups = order
    .map(key => ({ key, items: state.items.filter(i => i.category === key) }))
    .filter(g => g.items.length);

  if (!groups.length) {
    feedEl.innerHTML = '<p class="feed-empty">該当する記事がありません。</p>';
    return;
  }

  feedEl.innerHTML = groups.map(g => `
    <section class="feed-section">
      <h2 class="feed-section-title">
        ${escapeHtml(CATEGORY_LABELS[g.key] || g.key)}
        <span class="feed-section-count">${g.items.length}</span>
      </h2>
      ${renderCardGrid(g.items)}
    </section>
  `).join('');
}

function renderCardGrid(items) {
  if (!items.length) return '<p class="feed-empty">該当する記事がありません。</p>';
  return `<div class="card-grid">${items.map(item => `
    <article class="feed-card cat-${item.category}">
      <div class="feed-card-top">
        <span class="feed-card-tag">${escapeHtml(CATEGORY_LABELS[item.category] || item.category)}</span>
        <span class="feed-card-tag">${escapeHtml(item.source)}</span>
      </div>
      <div class="feed-card-title">
        <a href="${escapeAttr(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>
      </div>
      <div class="feed-card-meta">${item.published ? new Date(item.published).toLocaleString('ja-JP', { hour12: false }) : ''}</div>
    </article>
  `).join('')}</div>`;
}

function escapeHtml(str = '') {
  return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str = '') { return escapeHtml(str); }

document.getElementById('refresh-btn').addEventListener('click', loadDashboard);
loadDashboard();
