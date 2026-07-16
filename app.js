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

  if (!serverStatus && !mapRotation) {
    strip.innerHTML = `
      <div class="status-chip">
        <span class="status-dot is-unknown"></span>
        サーバー状況: APIキー未設定（apexlegendsapi.comで無料登録後、env APEX_STATUS_API_KEYを設定）
      </div>`;
    return;
  }

  if (serverStatus && !serverStatus.error) {
    const isUp = !!serverStatus.Origin_login?.status?.toLowerCase?.().includes('up') ||
                 !!serverStatus.All?.toLowerCase?.().includes('up');
    strip.innerHTML += `
      <div class="status-chip">
        <span class="status-dot ${isUp ? '' : 'is-down'}"></span>
        サーバー状況: ${isUp ? '稼働中' : '要確認'}
      </div>`;
  }

  if (mapRotation && !mapRotation.error) {
    const current = mapRotation.battle_royale?.current?.map || '--';
    strip.innerHTML += `
      <div class="status-chip">現在のマップ (BR): ${escapeHtml(current)}</div>`;
  }
}

function renderCategoryNav(categoryCounts) {
  const nav = document.getElementById('category-nav');
  nav.querySelectorAll('.ring-tab:not([data-category="all"])').forEach(el => el.remove());

  if (!categoryCounts) return;

  Object.entries(categoryCounts).forEach(([key, { label, count }]) => {
    const btn = document.createElement('button');
    btn.className = 'ring-tab';
    btn.dataset.category = key;
    btn.textContent = `${label} (${count})`;
    btn.addEventListener('click', () => setActiveCategory(key));
    nav.appendChild(btn);
  });

  nav.querySelector('[data-category="all"]').addEventListener('click', () => setActiveCategory('all'));
}

function setActiveCategory(key) {
  state.activeCategory = key;
  document.querySelectorAll('.ring-tab').forEach(el => {
    el.classList.toggle('is-active', el.dataset.category === key);
  });
  renderFeed();
}

function renderFeed() {
  const feedEl = document.getElementById('feed');
  const items = state.activeCategory === 'all'
    ? state.items
    : state.items.filter(i => i.category === state.activeCategory);

  if (!items.length) {
    feedEl.innerHTML = '<p class="feed-empty">該当する記事がありません。</p>';
    return;
  }

  feedEl.innerHTML = items.map(item => `
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
  `).join('');
}

function escapeHtml(str = '') {
  return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str = '') { return escapeHtml(str); }

document.getElementById('refresh-btn').addEventListener('click', loadDashboard);
loadDashboard();
