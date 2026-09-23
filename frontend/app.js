// VOLTGRID // Cyber-Physical SRE Studio Application Logic
let allDatabases = [];
let activeDbId = 'volt';
let phasorAnimId = 0;
let phasorAngle = 0;
let phasorState = {
    u1: 230, u2: 230, u3: 230,
    i1: 18.4, i2: 17.8, i3: 19.1,
    cosPhi: 0.94
};

document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    await loadDatabases();
    await loadInvariants();
    initPhasorCanvas();

    // Ctrl+Enter in SQL Editor
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
// THEME SWITCHER (1:1 mit Aethelburg Portfolio CI)
// -----------------------------------------------------------------------------
function initTheme() {
    const btn = document.getElementById('theme-toggle-btn');
    const icon = document.getElementById('theme-icon');
    const text = document.getElementById('theme-text');
    const html = document.documentElement;

    const currentTheme = localStorage.getItem('aethelburg-theme') || 'light';
    if (currentTheme === 'dark') {
        html.classList.add('dark');
        if (icon) icon.textContent = '☀';
        if (text) text.textContent = 'LIGHT';
    } else {
        html.classList.remove('dark');
        if (icon) icon.textContent = '☾';
        if (text) text.textContent = 'DARK';
    }

    btn?.addEventListener('click', () => {
        const isDark = html.classList.toggle('dark');
        localStorage.setItem('aethelburg-theme', isDark ? 'dark' : 'light');
        if (icon) icon.textContent = isDark ? '☀' : '☾';
        if (text) text.textContent = isDark ? 'LIGHT' : 'DARK';
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
        resizePhasor();
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
            <option value="${db.id}">${db.name} (${db.size_kb} KB)</option>
        `).join('');

        if (allDatabases.length > 0) {
            // Bevorzuge 'volt' wenn vorhanden, sonst die erste DB
            const voltDb = allDatabases.find(d => d.id === 'volt');
            activeDbId = voltDb ? 'volt' : allDatabases[0].id;
            selector.value = activeDbId;
            onDatabaseChange();
        }
    } catch (err) {
        console.error("Fehler beim Laden der Datenbanken:", err);
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

    // Load tables
    await loadTablesForActiveDb();

    // Load presets
    renderPresets(dbInfo?.presets || []);
}

async function loadTablesForActiveDb() {
    const listEl = document.getElementById('tables-list');
    const countEl = document.getElementById('tables-count');
    if (!listEl) return;

    listEl.innerHTML = `<div class="text-[var(--text-muted)] py-3 text-center">Lade Tabellen...</div>`;

    try {
        const res = await fetch(`/api/db/${activeDbId}/tables`);
        const data = await res.json();
        const entities = data.entities || [];

        if (countEl) countEl.textContent = entities.length;

        if (entities.length === 0) {
            listEl.innerHTML = `<div class="text-[var(--text-muted)] py-3 text-center">Keine Tabellen gefunden.</div>`;
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

        // Intelligente Standard-Tabelle wählen: Bevorzuge Haupttabellen mit Daten, sonst erste Tabelle mit row_count > 0, sonst entities[0]
        if (entities.length > 0) {
            const preferredNames = ['lgnn_nodes', 'telemetrie_messungen', 'v_geraete_uebersicht', 'trades', 'tournaments', 'open_positions'];
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

    // Aktive Tabelle in der Seitenleiste hervorheben
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

    // Preset-Highlights zurücksetzen, da nun manuelle Tabelle aktiv ist
    document.querySelectorAll('#presets-container button').forEach(btn => {
        btn.classList.remove('bg-[var(--text-primary)]', 'text-[var(--bg-primary)]', 'border-[var(--text-primary)]', 'font-bold');
        btn.classList.add('bg-[var(--bg-secondary)]', 'text-[var(--text-primary)]', 'border-[var(--border-hairline)]');
    });
}

function renderPresets(presets) {
    const container = document.getElementById('presets-container');
    if (!container) return;

    if (presets.length === 0) {
        container.innerHTML = `<span class="text-[var(--text-muted)] text-[11px]">Keine Presets für diese DB hinterlegt.</span>`;
        return;
    }

    container.innerHTML = presets.map((p, idx) => `
        <button onclick="applyPreset(${idx})" class="px-2.5 py-1 rounded bg-[var(--bg-secondary)] hover:bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border-hairline)] hover:border-[var(--text-primary)] text-xs transition cursor-pointer font-mono-tech">
            ${escapeHtml(p.title)}
        </button>
    `).join('');
}

function applyPreset(idx) {
    const dbInfo = allDatabases.find(d => d.id === activeDbId);
    if (!dbInfo || !dbInfo.presets[idx]) return;
    const p = dbInfo.presets[idx];

    // Aktiven Preset-Button sauber hervorheben (100% Kontrast, kein Text-Verstecken)
    document.querySelectorAll('#presets-container button').forEach((btn, i) => {
        if (i === idx) {
            btn.classList.remove('bg-[var(--bg-secondary)]', 'text-[var(--text-primary)]', 'border-[var(--border-hairline)]');
            btn.classList.add('bg-[var(--text-primary)]', 'text-[var(--bg-primary)]', 'border-[var(--text-primary)]', 'font-bold');
        } else {
            btn.classList.remove('bg-[var(--text-primary)]', 'text-[var(--bg-primary)]', 'border-[var(--text-primary)]', 'font-bold');
            btn.classList.add('bg-[var(--bg-secondary)]', 'text-[var(--text-primary)]', 'border-[var(--border-hairline)]');
        }
    });

    // Tabellen-Highlights zurücksetzen
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

    timeStatus.textContent = "Führe Query aus...";
    rowStatus.textContent = "";

    try {
        const res = await fetch(`/api/db/${activeDbId}/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: sql, read_only: true })
        });
        const result = await res.json();

        if (!result.success) {
            timeStatus.innerHTML = `<span class="text-rose-500 font-bold">SQL Fehler</span>`;
            planText.textContent = "Kein Query Plan bei Fehler.";
            head.innerHTML = `<tr><th class="px-4 py-2 text-rose-500 font-bold">FEHLERSTATUS</th></tr>`;
            body.innerHTML = `<tr><td class="p-4 text-rose-500 font-mono bg-rose-500/10">${escapeHtml(result.error || result.detail)}</td></tr>`;
            return;
        }

        timeStatus.innerHTML = `Laufzeit: <strong class="text-[var(--text-primary)]">${result.execution_time_ms} ms</strong>`;
        rowStatus.textContent = `${result.total_rows} Zeilen`;

        // Render Query Plan
        if (result.query_plan && result.query_plan.length > 0) {
            planText.innerHTML = result.query_plan.map(p => `&bull; ${escapeHtml(p)}`).join(' | ');
        } else {
            planText.textContent = "B-Tree Tabellenscan.";
        }

        // Render Columns
        head.innerHTML = `<tr>${result.columns.map(c => `<th class="px-4 py-2 font-bold">${escapeHtml(c)}</th>`).join('')}</tr>`;

        // Render Rows
        if (result.rows.length === 0) {
            body.innerHTML = `<tr><td colspan="${result.columns.length}" class="text-center py-6 text-[var(--text-muted)]">0 Datensätze zurückgegeben.</td></tr>`;
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
                        <span class="px-2 py-0.5 rounded text-[10px] font-bold ${badgeClass}">[${g.status}]</span>
                    </div>

                    <div class="p-2 rounded bg-[var(--bg-card)] border border-[var(--border-hairline)] text-xs text-[var(--text-primary)]">
                        <code>${escapeHtml(g.formula)}</code>
                    </div>

                    <div class="flex items-center justify-between text-xs pt-1 border-t border-[var(--border-hairline)] text-[var(--text-secondary)]">
                        <span>Messwert: <strong class="text-[var(--text-primary)]">${escapeHtml(g.metric_value)}</strong></span>
                        <span class="text-[11px] text-[var(--text-muted)]">${escapeHtml(g.target_bound)}</span>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error("Fehler beim Laden der Invarianten:", err);
    }
}

// -----------------------------------------------------------------------------
// 3-PHASE PHASOR CANVAS (Architectural Blueprint Ink)
// -----------------------------------------------------------------------------
function initPhasorCanvas() {
    const canvas = document.getElementById('canvas-phasor');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    function render() {
        phasorAngle += 0.02;
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = rect.width;
        const h = rect.height;

        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        const isDark = document.documentElement.classList.contains('dark');
        ctx.clearRect(0, 0, w, h);
        const cx = w / 2;
        const cy = h / 2;
        const rMax = Math.min(w, h) * 0.38;

        // Polar grid circles
        ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(18, 18, 18, 0.12)';
        ctx.lineWidth = 1;
        for (let f = 0.25; f <= 1.0; f += 0.25) {
            ctx.beginPath();
            ctx.arc(cx, cy, rMax * f, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Axes crosshairs
        ctx.beginPath();
        ctx.moveTo(cx - rMax * 1.1, cy); ctx.lineTo(cx + rMax * 1.1, cy);
        ctx.moveTo(cx, cy - rMax * 1.1); ctx.lineTo(cx, cy + rMax * 1.1);
        ctx.stroke();

        ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.4)' : 'rgba(18, 18, 18, 0.4)';
        ctx.font = '9px monospace';
        ctx.fillText('Re (+)', cx + rMax * 1.05, cy - 4);
        ctx.fillText('Im (+j)', cx + 4, cy - rMax * 1.05);

        const a1 = phasorAngle;
        const a2 = phasorAngle - (2 * Math.PI / 3);
        const a3 = phasorAngle + (2 * Math.PI / 3);
        const phi = Math.acos(phasorState.cosPhi);

        function drawVec(theta, lenFrac, strokeColor, label, dashed = false) {
            const len = rMax * lenFrac;
            const ex = cx + Math.cos(theta) * len;
            const ey = cy + Math.sin(theta) * len;

            ctx.strokeStyle = strokeColor;
            ctx.fillStyle = strokeColor;
            ctx.lineWidth = dashed ? 1.5 : 2.5;
            if (dashed) ctx.setLineDash([4, 4]);
            else ctx.setLineDash([]);

            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(ex, ey);
            ctx.stroke();
            ctx.setLineDash([]);

            // Arrowhead
            const arrowAngle = Math.PI / 7;
            ctx.beginPath();
            ctx.moveTo(ex, ey);
            ctx.lineTo(ex - 7 * Math.cos(theta - arrowAngle), ey - 7 * Math.sin(theta - arrowAngle));
            ctx.lineTo(ex - 7 * Math.cos(theta + arrowAngle), ey - 7 * Math.sin(theta + arrowAngle));
            ctx.fill();

            ctx.font = 'bold 10px monospace';
            ctx.fillText(label, ex + Math.cos(theta) * 12, ey + Math.sin(theta) * 12);
        }

        // Voltages (L1, L2, L3)
        drawVec(a1, 0.85, isDark ? '#fbbf24' : '#d97706', 'U_L1');
        drawVec(a2, 0.85, isDark ? '#34d399' : '#059669', 'U_L2');
        drawVec(a3, 0.85, isDark ? '#22d3ee' : '#0891b2', 'U_L3');

        // Currents (I_L1, I_L2, I_L3)
        const scale = 1.0 / 50.0;
        drawVec(a1 - phi, Math.min(1.0, phasorState.i1 * scale), isDark ? '#f59e0b' : '#b45309', 'I_L1', true);
        drawVec(a2 - phi, Math.min(1.0, phasorState.i2 * scale), isDark ? '#10b981' : '#047857', 'I_L2', true);
        drawVec(a3 - phi, Math.min(1.0, phasorState.i3 * scale), isDark ? '#06b6d4' : '#0e7490', 'I_L3', true);

        phasorAnimId = requestAnimationFrame(render);
    }
    render();
}

function resizePhasor() {
    const canvas = document.getElementById('canvas-phasor');
    if (canvas) {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
    }
}

function setPhasorRegime(regime) {
    document.querySelectorAll('.phasor-regime-btn').forEach(btn => {
        const r = btn.getAttribute('data-regime');
        if (r === regime) {
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

    if (regime === 'balanced') {
        phasorState = { u1: 230, u2: 230, u3: 230, i1: 18.4, i2: 17.8, i3: 19.1, cosPhi: 0.94 };
    } else if (regime === 'inrush') {
        phasorState = { u1: 221, u2: 229, u3: 230, i1: 58.4, i2: 14.2, i3: 16.0, cosPhi: 0.65 };
    } else if (regime === 'asymmetry') {
        phasorState = { u1: 231, u2: 233, u3: 226, i1: 12.0, i2: 3.1, i3: 38.5, cosPhi: 0.91 };
    }

    const iAvg = (phasorState.i1 + phasorState.i2 + phasorState.i3) / 3;
    const i2 = Math.abs(Math.max(phasorState.i1, phasorState.i2, phasorState.i3) - Math.min(phasorState.i1, phasorState.i2, phasorState.i3)) / 2;
    const u2 = (i2 / (iAvg || 1)) * 100;

    const elI1 = document.getElementById('ph-i1');
    const elI2 = document.getElementById('ph-i2');
    const elU2 = document.getElementById('ph-u2');
    const elL1 = document.getElementById('ph-l1');
    const elL2 = document.getElementById('ph-l2');
    const elL3 = document.getElementById('ph-l3');

    if (elI1) elI1.textContent = `${iAvg.toFixed(1)} A`;
    if (elI2) elI2.textContent = `${i2.toFixed(1)} A`;
    if (elU2) elU2.textContent = `${u2.toFixed(1)} %`;
    if (elL1) elL1.textContent = `${phasorState.u1}V | ${phasorState.i1}A ∠ 0°`;
    if (elL2) elL2.textContent = `${phasorState.u2}V | ${phasorState.i2}A ∠ -120°`;
    if (elL3) elL3.textContent = `${phasorState.u3}V | ${phasorState.i3}A ∠ +120°`;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
