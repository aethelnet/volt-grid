// VOLTGRID // Cyber-Physical 3-Phase Fortescue & DIN VDE Studio Logic
let allDatabases = [];
let activeDbId = 'volt';
let phasorAnimId = 0;
let phasorAngle = 0;
let phasorState = {
    u1: 230, u2: 230, u3: 230,
    i1: 18.4, i2: 17.8, i3: 19.1,
    cosPhi: 0.94,
    label: 'REGIME: 01 // SYMMETRISCH'
};

let telemetrySamples = [];
let selectedSampleIdx = -1;
let hoverSampleIdx = -1;

document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    await Promise.all([
        loadDatabases(),
        loadInvariants(),
        loadTelemetryTimeseries()
    ]);
    updateFortescueReadout();
    initPhasorCanvas();
    initTimeseriesInteractions();

    window.addEventListener('resize', () => {
        resizePhasor();
        renderTimeseriesChart();
    });

    const editor = document.getElementById('sql-editor');
    if (editor) {
        editor.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                executeSqlQuery();
            }
        });
    }
});

// -----------------------------------------------------------------------------
// THEME SWITCHER (Swiss-Brutalist Dark/Light Toggle)
// -----------------------------------------------------------------------------
function initTheme() {
    const btn = document.getElementById('theme-toggle-btn');
    const text = document.getElementById('theme-text');
    const html = document.documentElement;

    const currentTheme = localStorage.getItem('aethelburg-theme') || 'light';
    if (currentTheme === 'dark') {
        html.classList.add('dark');
        if (text) text.textContent = '[LIGHT]';
    } else {
        html.classList.remove('dark');
        if (text) text.textContent = '[DARK]';
    }

    btn?.addEventListener('click', () => {
        const isDark = html.classList.toggle('dark');
        localStorage.setItem('aethelburg-theme', isDark ? 'dark' : 'light');
        if (text) text.textContent = isDark ? '[LIGHT]' : '[DARK]';
        renderTimeseriesChart();
    });
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    const target = document.getElementById(tabId);
    if (target) target.classList.remove('hidden');

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('border-[var(--text-primary)]', 'text-[var(--text-primary)]', 'font-bold');
        btn.classList.add('border-transparent', 'text-[var(--text-muted)]');
    });

    const activeBtn = document.getElementById(`btn-${tabId}`);
    if (activeBtn) {
        activeBtn.classList.remove('border-transparent', 'text-[var(--text-muted)]');
        activeBtn.classList.add('border-[var(--text-primary)]', 'text-[var(--text-primary)]', 'font-bold');
    }

    if (tabId === 'tab-phasor') {
        requestAnimationFrame(() => {
            resizePhasor();
            renderTimeseriesChart();
        });
    }
}

// -----------------------------------------------------------------------------
// DATABASE SWITCHER & SCHEMA EXPLORER
// -----------------------------------------------------------------------------
async function loadDatabases() {
    try {
        const res = await fetch('/api/dbs');
        allDatabases = await res.json();

        const selector = document.getElementById('db-selector');
        if (!selector) return;

        selector.innerHTML = allDatabases.map(db => `
            <option value="${escapeHtml(db.id)}">${escapeHtml(db.name)} (${db.size_kb} KB)</option>
        `).join('');

        if (allDatabases.length > 0) {
            const voltDb = allDatabases.find(d => d.id === 'volt');
            activeDbId = voltDb ? 'volt' : allDatabases[0].id;
            selector.value = activeDbId;
            await onDatabaseChange();
        }
    } catch (err) {
        console.error('Fehler beim Laden der Datenbanken:', err);
    }
}

async function onDatabaseChange() {
    const selector = document.getElementById('db-selector');
    activeDbId = selector.value;
    const dbInfo = allDatabases.find(d => d.id === activeDbId);

    const sizeBadge = document.getElementById('db-size-badge');
    if (sizeBadge && dbInfo) {
        sizeBadge.textContent = `${dbInfo.size_kb} KB | WAL: ${dbInfo.wal_size_kb} KB`;
    }

    const timeStatus = document.getElementById('query-time-status');
    const rowStatus = document.getElementById('query-row-status');
    const body = document.getElementById('result-body');
    if (timeStatus) timeStatus.innerHTML = `<span class="text-amber-500 font-bold">Lade DB [${escapeHtml(activeDbId)}]...</span>`;
    if (rowStatus) rowStatus.textContent = 'Initialisiere...';
    if (body) {
        body.innerHTML = `<tr><td colspan="100%" class="text-center py-12 font-mono-tech"><div class="inline-flex items-center space-x-2 text-[var(--text-primary)]"><span class="w-2 h-2 rounded-full bg-[var(--text-primary)] animate-ping"></span><span class="text-xs font-bold uppercase tracking-wider">Lade Relationen fuer [${escapeHtml(dbInfo?.name || activeDbId)}]...</span></div></td></tr>`;
    }

    await loadTablesForActiveDb();
    renderPresets(dbInfo?.presets || []);
}

async function loadTablesForActiveDb() {
    const listEl = document.getElementById('tables-list');
    const countEl = document.getElementById('tables-count');
    if (!listEl) return;

    listEl.innerHTML = `<div class="text-[var(--text-muted)] py-3 text-center">Lade Tabellen...</div>`;

    try {
        const res = await fetch(`/api/db/${activeDbId}/tables`);
        if (!res.ok) {
            const rawText = await res.text();
            throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 100)}`);
        }
        const data = await res.json();
        const entities = data.entities || [];

        if (countEl) countEl.textContent = entities.length;

        if (entities.length === 0) {
            listEl.innerHTML = `<div class="text-[var(--text-muted)] py-3 text-center">Keine Relationen gefunden.</div>`;
            return;
        }

        listEl.innerHTML = entities.map(e => `
            <div onclick="selectQuickTable('${escapeHtml(e.name)}')"
                 class="px-2 py-1.5 rounded border border-transparent hover:border-[var(--border-hairline)] hover:bg-[var(--bg-secondary)] cursor-pointer flex items-center justify-between group transition">
                <div class="flex items-center space-x-2">
                    <span class="text-[9px] text-[var(--text-muted)] font-mono">[${e.type === 'view' ? 'VIEW' : 'TBL'}]</span>
                    <span class="table-name text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] font-semibold text-xs">${escapeHtml(e.name)}</span>
                </div>
                <span class="text-[10px] bg-[var(--bg-primary)] border border-[var(--border-hairline)] px-1.5 py-0.2 rounded text-[var(--text-muted)]">${e.row_count}</span>
            </div>
        `).join('');

        if (entities.length > 0) {
            const preferredNames = ['v_geraete_uebersicht', 'telemetrie_messungen', 'lgnn_nodes'];
            const defaultTable = entities.find(e => preferredNames.includes(e.name) && e.row_count > 0)
                || entities.find(e => e.row_count > 0)
                || entities[0];
            selectQuickTable(defaultTable.name);
        }
    } catch (err) {
        listEl.innerHTML = `<div class="text-rose-500 py-3 text-center">${escapeHtml(err.message)}</div>`;
    }
}

function selectQuickTable(tableName) {
    const editor = document.getElementById('sql-editor');
    if (editor) {
        editor.value = `SELECT * FROM \`${tableName}\` LIMIT 25;`;
        executeSqlQuery();
    }

    document.querySelectorAll('#tables-list > div').forEach(el => {
        const nameSpan = el.querySelector('.table-name');
        if (nameSpan && nameSpan.textContent.trim() === tableName) {
            el.classList.add('bg-[var(--bg-secondary)]', 'border-[var(--text-primary)]', 'font-bold');
            el.classList.remove('border-transparent');
        } else {
            el.classList.remove('bg-[var(--bg-secondary)]', 'border-[var(--text-primary)]', 'font-bold');
            el.classList.add('border-transparent');
        }
    });

    document.querySelectorAll('#presets-container button').forEach(btn => {
        btn.classList.remove('bg-[var(--text-primary)]', 'text-[var(--bg-primary)]', 'border-[var(--text-primary)]', 'font-bold');
        btn.classList.add('bg-[var(--bg-secondary)]', 'text-[var(--text-primary)]', 'border-[var(--border-hairline)]');
    });
}

function renderPresets(presets) {
    const container = document.getElementById('presets-container');
    if (!container) return;

    if (presets.length === 0) {
        container.innerHTML = `<span class="text-[var(--text-muted)] text-[11px]">Keine Presets fuer diese DB hinterlegt.</span>`;
        return;
    }

    container.innerHTML = presets.map((p, idx) => `
        <button onclick="applyPreset(${idx})" title="${escapeHtml(p.description || '')}" class="px-2.5 py-1 rounded bg-[var(--bg-secondary)] hover:bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border-hairline)] hover:border-[var(--text-primary)] text-xs transition cursor-pointer font-mono-tech">
            ${escapeHtml(p.title)}
        </button>
    `).join('');
}

function applyPreset(idx) {
    const dbInfo = allDatabases.find(d => d.id === activeDbId);
    if (!dbInfo || !dbInfo.presets[idx]) return;
    const p = dbInfo.presets[idx];

    document.querySelectorAll('#presets-container button').forEach((btn, i) => {
        if (i === idx) {
            btn.classList.remove('bg-[var(--bg-secondary)]', 'text-[var(--text-primary)]', 'border-[var(--border-hairline)]');
            btn.classList.add('bg-[var(--text-primary)]', 'text-[var(--bg-primary)]', 'border-[var(--text-primary)]', 'font-bold');
        } else {
            btn.classList.remove('bg-[var(--text-primary)]', 'text-[var(--bg-primary)]', 'border-[var(--text-primary)]', 'font-bold');
            btn.classList.add('bg-[var(--bg-secondary)]', 'text-[var(--text-primary)]', 'border-[var(--border-hairline)]');
        }
    });

    document.querySelectorAll('#tables-list > div').forEach(el => {
        el.classList.remove('bg-[var(--bg-secondary)]', 'border-[var(--text-primary)]', 'font-bold');
        el.classList.add('border-transparent');
    });

    const editor = document.getElementById('sql-editor');
    if (editor) {
        editor.value = p.sql;
        executeSqlQuery();
    }
}

// -----------------------------------------------------------------------------
// SQL QUERY EXECUTION
// -----------------------------------------------------------------------------
async function executeSqlQuery() {
    const editor = document.getElementById('sql-editor');
    const sql = editor.value.trim();
    if (!sql) return;

    const timeStatus = document.getElementById('query-time-status');
    const rowStatus = document.getElementById('query-row-status');
    const planText = document.getElementById('query-plan-text');
    const head = document.getElementById('result-head');
    const body = document.getElementById('result-body');

    timeStatus.innerHTML = `<span class="text-amber-500 font-bold">Lade Daten...</span>`;
    rowStatus.textContent = 'Warte auf SQLite-WAL...';
    body.innerHTML = `<tr><td class="text-center py-12 font-mono-tech"><div class="inline-flex items-center space-x-2 text-[var(--text-primary)]"><span class="w-2 h-2 rounded-full bg-[var(--text-primary)] animate-ping"></span><span class="text-xs font-bold uppercase tracking-wider">Lade Datensaetze aus SQLite-WAL...</span></div><div class="text-[10px] text-[var(--text-muted)] mt-1 font-mono-tech">Abfrage auf [${escapeHtml(activeDbId)}] laeuft</div></td></tr>`;

    try {
        const res = await fetch(`/api/db/${activeDbId}/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: sql, read_only: true })
        });

        let result;
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            result = await res.json();
        } else {
            const rawText = await res.text();
            result = {
                success: false,
                error: `HTTP ${res.status}: ${rawText.slice(0, 150)}`
            };
        }

        if (!result.success) {
            timeStatus.innerHTML = `<span class="text-rose-500 font-bold">SQL Fehler</span>`;
            rowStatus.textContent = 'Abgebrochen';
            planText.textContent = 'Kein Query Plan bei Fehler.';
            head.innerHTML = `<tr><th class="px-4 py-2 text-rose-500 font-bold">FEHLERSTATUS</th></tr>`;
            body.innerHTML = `<tr><td class="p-4 text-rose-500 font-mono bg-rose-500/10">${escapeHtml(result.error || result.detail)}</td></tr>`;
            return;
        }

        timeStatus.innerHTML = `Laufzeit: <strong class="text-[var(--text-primary)]">${result.execution_time_ms} ms</strong>`;
        rowStatus.textContent = `${result.total_rows} Zeilen`;

        if (result.query_plan && result.query_plan.length > 0) {
            planText.innerHTML = result.query_plan.map(p => `&bull; ${escapeHtml(p)}`).join(' | ');
        } else {
            planText.textContent = 'B-Tree Tabellenscan.';
        }

        head.innerHTML = `<tr>${result.columns.map(c => `<th class="px-4 py-2 font-bold">${escapeHtml(c)}</th>`).join('')}</tr>`;

        if (result.rows.length === 0) {
            body.innerHTML = `<tr><td colspan="${result.columns.length || 1}" class="text-center py-8 text-[var(--text-muted)] font-mono-tech">
                <div class="space-y-1">
                    <span class="block text-xs font-bold text-[var(--text-secondary)]">0 Datensaetze zurueckgegeben</span>
                    <span class="block text-[11px] text-[var(--text-muted)]">Die Abfrage war syntaktisch gueltig, lieferte jedoch keine Treffer.</span>
                </div>
            </td></tr>`;
        } else {
            body.innerHTML = result.rows.map(row => `
                <tr class="hover:bg-[var(--bg-secondary)] transition">
                    ${row.map(val => `<td class="px-4 py-2 text-[var(--text-secondary)] font-mono text-[11px]">${val === null ? '<span class="text-[var(--text-muted)]">NULL</span>' : escapeHtml(String(val))}</td>`).join('')}
                </tr>
            `).join('');
        }

    } catch (err) {
        timeStatus.innerHTML = `<span class="text-rose-500">Netzwerkfehler</span>`;
        body.innerHTML = `<tr><td class="p-4 text-rose-500">${escapeHtml(err.message)}</td></tr>`;
    }
}

// -----------------------------------------------------------------------------
// INVARIANTS GATES
// -----------------------------------------------------------------------------
async function loadInvariants() {
    try {
        const res = await fetch('/api/invariants');
        if (!res.ok) return;
        const gates = await res.json();

        const grid = document.getElementById('invariants-grid');
        if (!grid) return;

        grid.innerHTML = gates.map(g => {
            let badgeClass = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30';
            if (g.status === 'FAIL') badgeClass = 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/30 animate-pulse';
            if (g.status === 'WARN') badgeClass = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30';

            return `
                <div class="p-4 rounded bg-[var(--bg-secondary)] border border-[var(--border-hairline)] space-y-3 font-mono-tech shadow-sm">
                    <div class="flex items-start justify-between">
                        <div>
                            <span class="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">${escapeHtml(g.domain)}</span>
                            <h3 class="text-sm font-bold text-[var(--text-primary)] mt-0.5">${escapeHtml(g.title)}</h3>
                        </div>
                        <span class="px-2 py-0.5 rounded text-[10px] font-bold ${badgeClass}">[${escapeHtml(g.status)}]</span>
                    </div>

                    <div class="p-2 rounded bg-[var(--bg-card)] border border-[var(--border-hairline)] text-xs text-[var(--text-primary)]">
                        <code>${escapeHtml(g.formula)}</code>
                    </div>

                    ${g.detail ? `<div class="text-[11px] text-[var(--text-muted)]">${escapeHtml(g.detail)}</div>` : ''}

                    <div class="flex items-center justify-between text-xs pt-1 border-t border-[var(--border-hairline)] text-[var(--text-secondary)]">
                        <span>Messwert: <strong class="text-[var(--text-primary)]">${escapeHtml(g.metric_value)}</strong></span>
                        <span class="text-[11px] text-[var(--text-muted)]">${escapeHtml(g.target_bound)}</span>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Fehler beim Laden der Invarianten:', err);
    }
}

// -----------------------------------------------------------------------------
// FORTESCUE MATH, SLIDERS & PHASOR REGIMES
// -----------------------------------------------------------------------------
function computeFortescue(i1, i2, i3) {
    const iPos = (i1 + i2 + i3) / 3.0;
    const reNeg = i1 - 0.5 * (i2 + i3);
    const imNeg = (Math.sqrt(3) / 2.0) * (i2 - i3);
    const iNeg = Math.hypot(reNeg, imNeg) / 3.0;
    const iNeutral = 3.0 * iNeg;
    const u2Pct = iPos > 1e-6 ? (iNeg / iPos) * 100.0 : 0.0;
    const deltaI = Math.max(i1, i2, i3) - Math.min(i1, i2, i3);
    return { iPos, iNeg, iNeutral, u2Pct, deltaI };
}

function updateFortescueReadout() {
    const { iPos, iNeg, iNeutral, u2Pct, deltaI } = computeFortescue(
        phasorState.i1,
        phasorState.i2,
        phasorState.i3
    );

    const elI1 = document.getElementById('ph-i1');
    const elI2 = document.getElementById('ph-i2');
    const elIn = document.getElementById('ph-in');
    const elU2 = document.getElementById('ph-u2');
    const elL1 = document.getElementById('ph-l1');
    const elL2 = document.getElementById('ph-l2');
    const elL3 = document.getElementById('ph-l3');
    const elCos = document.getElementById('ph-cosphi');
    const elBadge = document.getElementById('phasor-source-badge');
    const elPill = document.getElementById('ph-status-pill');

    if (elI1) elI1.textContent = `${iPos.toFixed(1)} A`;
    if (elI2) elI2.textContent = `${iNeg.toFixed(1)} A`;
    if (elIn) elIn.textContent = `${iNeutral.toFixed(1)} A`;
    if (elU2) {
        elU2.textContent = `${u2Pct.toFixed(1)} %`;
        elU2.className = u2Pct <= 2.5
            ? 'text-emerald-600 dark:text-emerald-400'
            : (u2Pct <= 10.0 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400');
    }

    if (elPill) {
        if (u2Pct <= 2.5 && deltaI <= 15.0) {
            elPill.textContent = '[KONFORM]';
            elPill.className = 'px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30';
        } else if (u2Pct <= 10.0 && deltaI <= 20.0) {
            elPill.textContent = '[WARNUNG]';
            elPill.className = 'px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30';
        } else {
            elPill.textContent = '[GRENZWERTVERLETZUNG]';
            elPill.className = 'px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/30';
        }
    }

    if (elL1) elL1.textContent = `${phasorState.u1}V | ${phasorState.i1.toFixed(1)}A`;
    if (elL2) elL2.textContent = `${phasorState.u2}V | ${phasorState.i2.toFixed(1)}A`;
    if (elL3) elL3.textContent = `${phasorState.u3}V | ${phasorState.i3.toFixed(1)}A`;
    if (elCos) elCos.textContent = phasorState.cosPhi.toFixed(2);
    if (elBadge && phasorState.label) elBadge.textContent = phasorState.label;

    const s1 = document.getElementById('slider-i1');
    const s2 = document.getElementById('slider-i2');
    const s3 = document.getElementById('slider-i3');
    const sc = document.getElementById('slider-cosphi');
    if (s1) s1.value = phasorState.i1;
    if (s2) s2.value = phasorState.i2;
    if (s3) s3.value = phasorState.i3;
    if (sc) sc.value = phasorState.cosPhi;
}

function highlightRegimeButtons(activeRegime) {
    document.querySelectorAll('.phasor-regime-btn').forEach(btn => {
        const r = btn.getAttribute('data-regime');
        if (r === activeRegime) {
            btn.classList.remove('bg-[var(--bg-secondary)]', 'border-[var(--border-hairline)]', 'text-amber-600', 'text-rose-600', 'dark:text-amber-400', 'dark:text-rose-400', 'text-[var(--text-primary)]');
            btn.classList.add('bg-[var(--text-primary)]', 'text-[var(--bg-primary)]', 'border-[var(--text-primary)]', 'font-bold');
        } else {
            btn.classList.remove('bg-[var(--text-primary)]', 'text-[var(--bg-primary)]', 'border-[var(--text-primary)]', 'font-bold');
            btn.classList.add('bg-[var(--bg-secondary)]', 'border-[var(--border-hairline)]');
            if (r === 'inrush') btn.classList.add('text-amber-600', 'dark:text-amber-400');
            else if (r === 'asymmetry') btn.classList.add('text-rose-600', 'dark:text-rose-400');
            else btn.classList.add('text-[var(--text-primary)]');
        }
    });
}

function setPhasorRegime(regime) {
    highlightRegimeButtons(regime);

    if (regime === 'balanced') {
        selectedSampleIdx = -1;
        phasorState = { u1: 230, u2: 230, u3: 230, i1: 18.4, i2: 17.8, i3: 19.1, cosPhi: 0.94, label: 'REGIME: 01 // SYMMETRISCH' };
    } else if (regime === 'inrush') {
        selectedSampleIdx = -1;
        phasorState = { u1: 221, u2: 229, u3: 230, i1: 58.4, i2: 14.2, i3: 16.0, cosPhi: 0.65, label: 'REGIME: 02 // MOTOR-PEAK (58.4 A)' };
    } else if (regime === 'asymmetry') {
        selectedSampleIdx = -1;
        phasorState = { u1: 231, u2: 233, u3: 226, i1: 12.0, i2: 3.1, i3: 38.5, cosPhi: 0.91, label: 'REGIME: 03 // SCHIEFLAST (L3 UEBERLAST)' };
    } else if (regime === 'db_peak' && telemetrySamples.length > 0) {
        let bestIdx = 0;
        for (let i = 1; i < telemetrySamples.length; i++) {
            if (telemetrySamples[i].i_neutral > telemetrySamples[bestIdx].i_neutral) {
                bestIdx = i;
            }
        }
        loadSampleIntoPhasor(bestIdx, true);
        return;
    }

    updateFortescueReadout();
    renderTimeseriesChart();
}

function onManualSliderChange() {
    const s1 = parseFloat(document.getElementById('slider-i1')?.value || '18.4');
    const s2 = parseFloat(document.getElementById('slider-i2')?.value || '17.8');
    const s3 = parseFloat(document.getElementById('slider-i3')?.value || '19.1');
    const sc = parseFloat(document.getElementById('slider-cosphi')?.value || '0.94');

    selectedSampleIdx = -1;
    highlightRegimeButtons('');
    phasorState = {
        ...phasorState,
        i1: s1,
        i2: s2,
        i3: s3,
        cosPhi: sc,
        label: 'MANUELLER PRUEFSTAND // SLIDER-STEUERUNG'
    };
    updateFortescueReadout();
    renderTimeseriesChart();
}

// -----------------------------------------------------------------------------
// 3-PHASE PHASOR CANVAS (Gauss Complex Plane + Kirchhoff Neutral Vector I_N)
// -----------------------------------------------------------------------------
function initPhasorCanvas() {
    const canvas = document.getElementById('canvas-phasor');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    function render() {
        phasorAngle += 0.018;
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = rect.width;
        const h = rect.height;

        if (w > 4 && h > 4) {
            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
                canvas.width = Math.round(w * dpr);
                canvas.height = Math.round(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            const isDark = document.documentElement.classList.contains('dark');
            const cx = w / 2;
            const cy = h / 2;
            const rMax = Math.min(w, h) * 0.39;

            // Polar reference rings (15A, 30A, 45A, 60A)
            ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.09)' : 'rgba(18, 18, 18, 0.10)';
            ctx.lineWidth = 1;
            for (let f = 0.25; f <= 1.0; f += 0.25) {
                ctx.beginPath();
                ctx.arc(cx, cy, rMax * f, 0, Math.PI * 2);
                ctx.stroke();
            }

            // Crosshair axes
            ctx.beginPath();
            ctx.moveTo(cx - rMax * 1.12, cy); ctx.lineTo(cx + rMax * 1.12, cy);
            ctx.moveTo(cx, cy - rMax * 1.12); ctx.lineTo(cx, cy + rMax * 1.12);
            ctx.stroke();

            ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.45)' : 'rgba(18, 18, 18, 0.45)';
            ctx.font = '10px JetBrains Mono, monospace';
            ctx.fillText('Re (+)', cx + rMax * 1.02, cy - 6);
            ctx.fillText('Im (+j)', cx + 6, cy - rMax * 1.04);

            const a1 = phasorAngle;
            const a2 = phasorAngle - (2 * Math.PI / 3);
            const a3 = phasorAngle + (2 * Math.PI / 3);
            const phi = Math.acos(Math.max(-1, Math.min(1, phasorState.cosPhi)));

            function drawVec(theta, lenFrac, strokeColor, label, dashed = false, lineWidth = 2.4) {
                if (lenFrac < 0.015) return;
                const len = rMax * Math.min(1.08, lenFrac);
                const ex = cx + Math.cos(theta) * len;
                const ey = cy + Math.sin(theta) * len;

                ctx.strokeStyle = strokeColor;
                ctx.fillStyle = strokeColor;
                ctx.lineWidth = lineWidth;
                if (dashed) ctx.setLineDash([5, 4]);
                else ctx.setLineDash([]);

                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(ex, ey);
                ctx.stroke();
                ctx.setLineDash([]);

                const arrowAngle = Math.PI / 7;
                ctx.beginPath();
                ctx.moveTo(ex, ey);
                ctx.lineTo(ex - 8 * Math.cos(theta - arrowAngle), ey - 8 * Math.sin(theta - arrowAngle));
                ctx.lineTo(ex - 8 * Math.cos(theta + arrowAngle), ey - 8 * Math.sin(theta + arrowAngle));
                ctx.fill();

                ctx.font = 'bold 10px JetBrains Mono, monospace';
                ctx.fillText(label, ex + Math.cos(theta) * 14 - 10, ey + Math.sin(theta) * 14 + 3);
            }

            // Voltage vectors (U_L1, U_L2, U_L3 normalized to 260V)
            drawVec(a1, phasorState.u1 / 270.0, isDark ? 'rgba(251, 191, 36, 0.55)' : 'rgba(217, 119, 6, 0.50)', 'U_L1', false, 1.8);
            drawVec(a2, phasorState.u2 / 270.0, isDark ? 'rgba(52, 211, 153, 0.55)' : 'rgba(5, 150, 105, 0.50)', 'U_L2', false, 1.8);
            drawVec(a3, phasorState.u3 / 270.0, isDark ? 'rgba(34, 211, 238, 0.55)' : 'rgba(8, 145, 178, 0.50)', 'U_L3', false, 1.8);

            // Current vectors (I_L1, I_L2, I_L3 normalized to 60A full scale)
            const iScale = 1.0 / 60.0;
            drawVec(a1 - phi, phasorState.i1 * iScale, isDark ? '#fbbf24' : '#b45309', 'I_L1', true, 2.4);
            drawVec(a2 - phi, phasorState.i2 * iScale, isDark ? '#34d399' : '#047857', 'I_L2', true, 2.4);
            drawVec(a3 - phi, phasorState.i3 * iScale, isDark ? '#22d3ee' : '#0e7490', 'I_L3', true, 2.4);

            // Resultant Neutral-Conductor Vector: I_N = I_L1 + I_L2 + I_L3 = 3 * I_0
            const inX = phasorState.i1 * Math.cos(a1 - phi)
                      + phasorState.i2 * Math.cos(a2 - phi)
                      + phasorState.i3 * Math.cos(a3 - phi);
            const inY = phasorState.i1 * Math.sin(a1 - phi)
                      + phasorState.i2 * Math.sin(a2 - phi)
                      + phasorState.i3 * Math.sin(a3 - phi);
            const inMag = Math.hypot(inX, inY);
            const inTheta = Math.atan2(inY, inX);
            if (inMag >= 1.5) {
                drawVec(inTheta, inMag * iScale, isDark ? '#fb7185' : '#e11d48', `I_N (${inMag.toFixed(1)}A)`, false, 3.0);
            }
        }

        phasorAnimId = requestAnimationFrame(render);
    }
    render();
}

function resizePhasor() {
    const canvas = document.getElementById('canvas-phasor');
    if (canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(canvas.clientWidth * dpr);
        canvas.height = Math.round(canvas.clientHeight * dpr);
    }
}

// -----------------------------------------------------------------------------
// HISTORICAL TELEMETRY TIMESERIES CHART (#canvas-timeseries)
// -----------------------------------------------------------------------------
async function loadTelemetryTimeseries() {
    try {
        const res = await fetch('/api/telemetry/timeseries?limit=150');
        if (!res.ok) return;
        const data = await res.json();
        telemetrySamples = data.samples || [];

        const countEl = document.getElementById('ts-meta-count');
        const peakEl = document.getElementById('ts-meta-peak');
        if (countEl) countEl.textContent = `${data.count} Messpunkte (${data.violations} Schrankenverletzungen)`;
        if (peakEl) peakEl.textContent = `Peak I_N: ${data.peak_neutral_a} A (u_2: ${data.peak_u2_pct} %)`;

        renderTimeseriesChart();
    } catch (err) {
        console.error('Fehler beim Laden der Telemetrie-Zeitreihe:', err);
    }
}

function loadSampleIntoPhasor(idx, fromPeakBtn = false) {
    if (idx < 0 || idx >= telemetrySamples.length) return;
    selectedSampleIdx = idx;
    const s = telemetrySamples[idx];
    highlightRegimeButtons(fromPeakBtn ? 'db_peak' : '');

    phasorState = {
        u1: s.u1,
        u2: s.u2,
        u3: s.u3,
        i1: s.i1,
        i2: s.i2,
        i3: s.i3,
        cosPhi: s.cos_phi,
        label: `DB MESSPUNKT #${s.id} // ${s.ts}`
    };

    const readout = document.getElementById('ts-selected-readout');
    if (readout) {
        readout.textContent = `${s.ts} | L1:${s.i1}A L2:${s.i2}A L3:${s.i3}A | I_N:${s.i_neutral}A (u_2:${s.u2_pct}%)`;
    }

    updateFortescueReadout();
    renderTimeseriesChart();
}

function initTimeseriesInteractions() {
    const canvas = document.getElementById('canvas-timeseries');
    if (!canvas) return;

    function pickIndex(evt) {
        if (telemetrySamples.length < 2) return -1;
        const rect = canvas.getBoundingClientRect();
        const padLeft = 42;
        const padRight = 16;
        const plotW = Math.max(1, rect.width - padLeft - padRight);
        const relX = Math.max(0, Math.min(plotW, evt.clientX - rect.left - padLeft));
        return Math.round((relX / plotW) * (telemetrySamples.length - 1));
    }

    canvas.addEventListener('mousemove', (evt) => {
        const idx = pickIndex(evt);
        if (idx !== hoverSampleIdx) {
            hoverSampleIdx = idx;
            renderTimeseriesChart();
        }
    });

    canvas.addEventListener('mouseleave', () => {
        hoverSampleIdx = -1;
        renderTimeseriesChart();
    });

    canvas.addEventListener('click', (evt) => {
        const idx = pickIndex(evt);
        if (idx >= 0) {
            loadSampleIntoPhasor(idx, false);
        }
    });
}

function renderTimeseriesChart() {
    const canvas = document.getElementById('canvas-timeseries');
    if (!canvas || telemetrySamples.length < 2) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;

    const dpr = window.devicePixelRatio || 1;
    const w = rect.width;
    const h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const isDark = document.documentElement.classList.contains('dark');
    const padLeft = 42;
    const padRight = 16;
    const padTop = 16;
    const padBottom = 26;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    let maxY = 65.0;
    for (const s of telemetrySamples) {
        maxY = Math.max(maxY, s.i1, s.i2, s.i3, s.i_neutral);
    }
    maxY = Math.ceil(maxY / 10.0) * 10.0;

    const xOf = (i) => padLeft + (i / (telemetrySamples.length - 1)) * plotW;
    const yOf = (val) => padTop + plotH - (val / maxY) * plotH;

    // Horizontal gridlines & Y-axis labels
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    for (let a = 0; a <= maxY; a += 15) {
        const y = yOf(a);
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(18,18,18,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(w - padRight, y);
        ctx.stroke();

        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(18,18,18,0.5)';
        ctx.fillText(`${a}A`, padLeft - 6, y + 3);
    }

    // 15.0 A Schieflast Threshold Line
    const yLim = yOf(15.0);
    ctx.strokeStyle = isDark ? 'rgba(251, 113, 133, 0.65)' : 'rgba(225, 29, 72, 0.55)';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(padLeft, yLim);
    ctx.lineTo(w - padRight, yLim);
    ctx.stroke();
    ctx.setLineDash([]);

    function drawSeries(getter, color, width = 1.5) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        telemetrySamples.forEach((s, i) => {
            const x = xOf(i);
            const y = yOf(getter(s));
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    }

    drawSeries(s => s.i1, isDark ? 'rgba(251, 191, 36, 0.75)' : 'rgba(217, 119, 6, 0.75)', 1.3);
    drawSeries(s => s.i2, isDark ? 'rgba(52, 211, 153, 0.75)' : 'rgba(5, 150, 105, 0.75)', 1.3);
    drawSeries(s => s.i3, isDark ? 'rgba(34, 211, 238, 0.75)' : 'rgba(8, 145, 178, 0.75)', 1.3);
    drawSeries(s => s.i_neutral, isDark ? '#fb7185' : '#e11d48', 2.2);

    // X-axis first/middle/last timestamps
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(18,18,18,0.5)';
    ctx.textAlign = 'left';
    ctx.fillText(telemetrySamples[0].ts.slice(5, 16), padLeft, h - 7);
    ctx.textAlign = 'center';
    const mid = Math.floor(telemetrySamples.length / 2);
    ctx.fillText(telemetrySamples[mid].ts.slice(5, 16), xOf(mid), h - 7);
    ctx.textAlign = 'right';
    ctx.fillText(telemetrySamples[telemetrySamples.length - 1].ts.slice(5, 16), w - padRight, h - 7);

    // Selected or hovered cursor marker
    const activeIdx = hoverSampleIdx >= 0 ? hoverSampleIdx : selectedSampleIdx;
    if (activeIdx >= 0 && activeIdx < telemetrySamples.length) {
        const s = telemetrySamples[activeIdx];
        const cx = xOf(activeIdx);
        const cy = yOf(s.i_neutral);

        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(18,18,18,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, padTop);
        ctx.lineTo(cx, padTop + plotH);
        ctx.stroke();

        ctx.fillStyle = isDark ? '#fb7185' : '#e11d48';
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fill();

        const tooltip = `${s.ts.slice(11, 19)} | I_N=${s.i_neutral}A | u2=${s.u2_pct}%`;
        const tw = ctx.measureText(tooltip).width + 12;
        const tx = Math.min(w - padRight - tw, Math.max(padLeft, cx - tw / 2));
        const ty = padTop + 4;
        ctx.fillStyle = isDark ? 'rgba(18, 20, 24, 0.92)' : 'rgba(248, 248, 246, 0.94)';
        ctx.fillRect(tx, ty, tw, 18);
        ctx.strokeStyle = isDark ? '#374151' : '#d1d5db';
        ctx.strokeRect(tx, ty, tw, 18);
        ctx.fillStyle = isDark ? '#f3f4f6' : '#121212';
        ctx.textAlign = 'left';
        ctx.fillText(tooltip, tx + 6, ty + 12);
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
