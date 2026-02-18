const state = {
  dishes: [],
  history: [],
  selectedHistory: null,
  editingId: null
};

const dishTable = document.getElementById('dishTable');
const dishForm = document.getElementById('dishForm');
const formStatus = document.getElementById('formStatus');
const csvInput = document.getElementById('csvInput');
const uploadCsvBtn = document.getElementById('uploadCsv');
const csvStatus = document.getElementById('csvStatus');
const benchmarkForm = document.getElementById('benchmarkForm');
const brandSelect = document.getElementById('brandSelect');
const benchmarkStatus = document.getElementById('benchmarkStatus');
const benchmarkResults = document.getElementById('benchmarkResults');
const historyList = document.getElementById('historyList');
const historyDetail = document.getElementById('historyDetail');

const fmtMoney = (n) => (n == null || Number.isNaN(n) ? '—' : `$${Number(n).toFixed(2)}`);
const escapeHTML = (v = '') => v.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  if (res.status === 204) return null;
  return res.json();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quote = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quote && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quote = !quote;
    } else if (c === ',' && !quote) {
      row.push(value.trim());
      value = '';
    } else if ((c === '\n' || c === '\r') && !quote) {
      if (value.length || row.length) {
        row.push(value.trim());
        rows.push(row);
        row = [];
        value = '';
      }
    } else {
      value += c;
    }
  }
  if (value.length || row.length) {
    row.push(value.trim());
    rows.push(row);
  }

  const [header, ...data] = rows;
  if (!header) return [];
  return data
    .filter((r) => r.some((c) => c !== ''))
    .map((r) => header.reduce((obj, key, idx) => ({ ...obj, [key.trim()]: r[idx] ?? '' }), {}));
}

function renderDishes() {
  dishTable.innerHTML = state.dishes.map((d) => `
    <tr>
      <td>${escapeHTML(d.brand)}</td>
      <td>${escapeHTML(d.id)}</td>
      <td>${escapeHTML(d.category)}</td>
      <td>${escapeHTML(d.name)}<br/><small>${escapeHTML(d.description || '')}</small></td>
      <td>${fmtMoney(d.fullPrice)} / ${fmtMoney(d.promoPrice)}<br/><small>Desc: ${d.discount ?? '—'}%</small></td>
      <td>
        <button class="btn" data-edit="${escapeHTML(d.id)}">Editar</button>
        <button class="btn" data-delete="${escapeHTML(d.id)}" style="background: #d35f7d; margin-left:.4rem;">Eliminar</button>
      </td>
    </tr>
  `).join('');

  document.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.onclick = () => {
      const dish = state.dishes.find((x) => x.id === btn.dataset.edit);
      if (!dish) return;
      state.editingId = dish.id;
      Object.entries(dish).forEach(([key, val]) => {
        const input = dishForm.elements[key];
        if (input) input.value = val ?? '';
      });
    };
  });

  document.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('¿Eliminar este plato?')) return;
      await api(`/api/dishes/${encodeURIComponent(btn.dataset.delete)}`, { method: 'DELETE' });
      await loadDishes();
    };
  });
}

function renderBrands() {
  const brands = [...new Set(state.dishes.map((d) => d.brand).filter(Boolean))];
  brandSelect.innerHTML = brands.length
    ? brands.map((b) => `<option value="${escapeHTML(b)}">${escapeHTML(b)}</option>`).join('')
    : '<option value="">No hay marcas disponibles</option>';
}

function renderResults(results, container) {
  container.innerHTML = results.length ? results.map((r) => `
    <div class="result-item">
      <div><strong>Competidor:</strong> ${escapeHTML(r.competitor.name)}</div>
      <div><strong>Nuestro match:</strong> ${escapeHTML(r.ours?.name || 'N/A')}</div>
      <div><strong>Nuestra categoría:</strong> ${escapeHTML(r.ours?.category || 'N/A')}</div>
      <div><strong>Diferencia de precio:</strong> ${fmtMoney(r.ours?.fullPrice)} vs ${fmtMoney(r.competitor.fullPrice)}</div>
      <div>
        <span class="badge ${r.status === 'Coincidencia' ? 'ok' : 'warn'}">${escapeHTML(r.status)}</span>
        <strong>${r.matchScore}%</strong>
      </div>
    </div>
  `).join('') : '<p>No se detectaron platos en la página objetivo.</p>';
}

function renderHistory() {
  historyList.innerHTML = state.history.length ? state.history.map((h) => `
    <div class="history-item" data-history="${h.id}">
      <strong>${escapeHTML(h.brand)}</strong> • ${new Date(h.date).toLocaleString()}<br/>
      <small>${escapeHTML(h.url)}</small><br/>
      <small>${h.totalResults} resultado(s)</small>
    </div>
  `).join('') : '<p>Aún no hay historial de benchmark.</p>';

  document.querySelectorAll('[data-history]').forEach((item) => {
    item.onclick = async () => {
      const detail = await api(`/api/benchmark/history/${item.dataset.history}`);
      state.selectedHistory = detail;
      historyDetail.innerHTML = `<p><strong>Marca:</strong> ${escapeHTML(detail.brand)} | <strong>Fecha:</strong> ${new Date(detail.date).toLocaleString()}</p>`;
      renderResults(detail.results, historyDetail);
    };
  });
}

async function loadDishes() {
  state.dishes = await api('/api/dishes');
  renderDishes();
  renderBrands();
}

async function loadHistory() {
  state.history = await api('/api/benchmark/history');
  renderHistory();
}

dishForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(dishForm).entries());
  try {
    if (state.editingId) await api(`/api/dishes/${encodeURIComponent(state.editingId)}`, { method: 'PUT', body: JSON.stringify(data) });
    else await api('/api/dishes', { method: 'POST', body: JSON.stringify(data) });
    formStatus.textContent = 'Plato guardado.';
    dishForm.reset();
    state.editingId = null;
    await loadDishes();
  } catch (err) {
    formStatus.textContent = err.message;
  }
});

uploadCsvBtn.addEventListener('click', async () => {
  const file = csvInput.files[0];
  if (!file) {
    csvStatus.textContent = 'Por favor, selecciona un archivo CSV.';
    return;
  }
  const text = await file.text();
  const rows = parseCsv(text);
  try {
    const result = await api('/api/dishes/bulk', { method: 'POST', body: JSON.stringify({ rows }) });
    csvStatus.textContent = `Creados ${result.created}, actualizados ${result.updated}.`;
    await loadDishes();
  } catch (err) {
    csvStatus.textContent = err.message;
  }
});

benchmarkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(benchmarkForm).entries());
  benchmarkStatus.textContent = 'Ejecutando análisis...';
  try {
    const result = await api('/api/benchmark', { method: 'POST', body: JSON.stringify(data) });
    benchmarkStatus.textContent = `Completado: ${result.results.length} resultado(s) encontrados.`;
    renderResults(result.results, benchmarkResults);
    await loadHistory();
  } catch (err) {
    benchmarkStatus.textContent = err.message;
  }
});

const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');
tabs.forEach((tab) => {
  tab.onclick = () => {
    tabs.forEach((t) => t.classList.remove('active'));
    panels.forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  };
});

const themeToggle = document.getElementById('themeToggle');
const savedTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
themeToggle.addEventListener('click', () => {
  const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
});

(async function init() {
  await loadDishes();
  await loadHistory();
})();
