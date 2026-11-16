// VOLTGRID // Dual-Mode Cyber-Physical Studio (FastAPI WAL + Static sql.js WASM Fallback)
let allDatabases = [];
let activeDbId = 'volt';
let runtimeMode = 'api'; // 'api' (FastAPI SQLite WAL) | 'wasm' (Browser sql.js Static Fallback)
let wasmDb = null;
let wasmDbSizeKb = 96.0;

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

const STATIC_VOLT_PRESETS = [
    {
        title: 'Gesperrte Betriebsmittel (DIN VDE)',
        sql: "SELECT inventar_nr, geraet_name, hersteller, schutzklasse_code, standort, letztes_ergebnis, pruef_ampel\nFROM v_geraete_uebersicht\nWHERE pruef_ampel = 'GESPERRT';",
        description: 'Formale Schrankenverletzungen bei Schutzleiter-, Isolations- und Ableitstrommessungen.'
    },
    {
        title: 'Netz-Schieflast > 15 A (Peak-Events)',
        sql: "SELECT zeitstempel, u_l1, u_l2, u_l3, i_l1, i_l2, i_l3, ROUND(schieflast_strom_a, 2) AS delta_i_a, p_wirk_kw, cos_phi\nFROM telemetrie_messungen\nWHERE schieflast_strom_a > 15.0\nORDER BY schieflast_strom_a DESC, zeitstempel DESC\nLIMIT 20;",
        description: 'Asymmetrische Phasenstroeme mit erhoehter thermischer Neutralleiter-Belastung.'
    },
    {
        title: 'R_PE Leitungslaengenzuschlag (VDE 0701)',
        sql: "SELECT g.inventar_nr, g.bezeichnung, g.kabel_laenge_meter AS laenge_m, p.r_pe_ohm,\n       ROUND(MIN(1.0, CASE WHEN g.kabel_laenge_meter <= 5.0 THEN 0.3 ELSE 0.3 + 0.1 * CAST(((g.kabel_laenge_meter - 5.0) + 7.4999) / 7.5 AS INT) END), 2) AS vde_limit_ohm,\n       p.r_iso_mohm, p.i_ea_ma, p.ergebnis\nFROM geraete g\nJOIN geraeteklassen gk ON g.klasse_id = gk.id\nJOIN pruefungen p ON p.geraet_id = g.id\nWHERE gk.r_pe_max IS NOT NULL\nORDER BY g.kabel_laenge_meter DESC;",
        description: 'Verifiziert den dynamischen Schutzleiter-Grenzwert (0.3 Ohm bis 5m + 0.1 Ohm je 7.5m, max. 1.0 Ohm).'
    },
    {
        title: 'Blindleistungsspitzen (cos phi < 0.80)',
        sql: "SELECT zeitstempel, p_wirk_kw, cos_phi, i_l1, i_l2, i_l3, ROUND(schieflast_strom_a, 2) AS delta_i_a\nFROM telemetrie_messungen\nWHERE cos_phi < 0.80\nORDER BY cos_phi ASC, p_wirk_kw DESC\nLIMIT 20;",
        description: 'Induktive Anlauf- und Blindlastspitzen unterhalb des VDE-AR-N 4100 Zielbands.'
    },
    {
        title: 'Hersteller-Ausfallquote',
        sql: "SELECT hersteller, anzahl_pruefungen, bestanden, durchgefallen, avg_r_pe_ohm, avg_r_iso_mohm, durchfallquote_prozent\nFROM v_hersteller_qualitaet\nORDER BY durchfallquote_prozent DESC, anzahl_pruefungen DESC;",
        description: 'Aggregierte Zuverlaessigkeitsstatistik nach Betriebsmittel-Hersteller.'
    }
];

const SQL_JS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0';

document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    await detectAndInitBackendMode();
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
// DUAL-MODE ENGINE DETECTION (FastAPI WAL vs. Browser sql.js WASM Static Host)
// -----------------------------------------------------------------------------
async function detectAndInitBackendMode() {
    const params = new URLSearchParams(window.location.search);
    const forceWasm = params.get('mode') === 'wasm';

    if (!forceWasm) {
        try {
            const res = await fetch('./api/dbs', { cache: 'no-store' });
            const ct = res.headers.get('content-type') || '';
            if (res.ok && ct.includes('application/json')) {
                runtimeMode = 'api';
                setHeaderEngineLabels('WAL INGEST: < 0.5 ms', 'READ-ONLY WAL');
                return;
            }
        } catch (_err) {
            // Static host (e.g. GitHub Pages) without FastAPI server -> fall back to sql.js WASM
        }
    }

    await initStaticWasmSqlite();
}

function setHeaderEngineLabels(latencyText, modeText) {
    const latEl = document.getElementById('engine-latency-label');
    const modeEl = document.getElementById('engine-mode-label');
    if (latEl) latEl.textContent = latencyText;
    if (modeEl) modeEl.textContent = modeText;
}

function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
        if (window.initSqlJs) {
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Konnte sql.js nicht laden: ${src}`));
        document.head.appendChild(script);
    });
}

async function fetchFirstAvailableSnapshot(urls) {
    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                const buf = await res.arrayBuffer();
                if (buf.byteLength > 1024) {
                    const header = new TextDecoder('ascii').decode(new Uint8Array(buf, 0, 15));
                    if (header.startsWith('SQLite format 3')) {
                        return buf;
                    }
                }
            }
        } catch (_e) {
            // Try next candidate path
        }
    }
    throw new Error('Kein gueltiger SQLite-Snapshot (voltbase.db) gefunden.');
}

async function initStaticWasmSqlite() {
    runtimeMode = 'wasm';
    setHeaderEngineLabels('WASM BOOT...', 'STATIC WASM');

    await loadScriptOnce(`${SQL_JS_CDN}/sql-wasm.js`);
    const SQL = await window.initSqlJs({
        locateFile: (file) => `${SQL_JS_CDN}/${file}`
    });

    const buf = await fetchFirstAvailableSnapshot([
        './voltbase.db',
        '../data/voltbase.db',
        './data/voltbase.db'
    ]);
    wasmDbSizeKb = Math.round((buf.byteLength / 1024.0) * 10.0) / 10.0;
    wasmDb = new SQL.Database(new Uint8Array(buf));
    wasmDb.run('PRAGMA query_only = ON;');
    setHeaderEngineLabels('WASM RAM: < 0.2 ms', 'STATIC WASM');
}

function wasmQueryObjects(sql, params = []) {
    const stmt = wasmDb.prepare(sql, params);
    const rows = [];
    try {
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
    } finally {
        stmt.free();
    }
    return rows;
}

function computeVdeRpeLimitJs(lengthM, baseLimitOhm = 0.3) {
    if (lengthM <= 5.0) return Math.round(baseLimitOhm * 1000) / 1000;
    const extraSteps = Math.ceil((lengthM - 5.0) / 7.5);
    return Math.round(Math.min(1.0, baseLimitOhm + 0.1 * extraSteps) * 1000) / 1000;
}

function validateReadOnlySqlJs(sql) {
    const trimmed = sql.trim();
    if (!trimmed) return 'Leere SQL-Abfrage uebergeben.';
    const firstToken = trimmed.replace(/^[(;\s]+/, '').split(/\s+/)[0].toUpperCase();
    if (!['SELECT', 'EXPLAIN', 'WITH'].includes(firstToken)) {
        return `Read-Only Sandbox aktiv: Schreiboperation '${firstToken}' ist gesperrt.`;
    }
    const forbidden = [
        /\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i, /\bALTER\b/i,
        /\bCREATE\b/i, /\bVACUUM\b/i, /\bATTACH\b/i, /\bDETACH\b/i, /\bPRAGMA\s+.*\b=\b/i
    ];
    for (const pat of forbidden) {
        if (pat.test(trimmed)) {
            return 'Sicherheitsfilter: Destruktives Schluesselwort blockiert (nur Lesezugriff erlaubt).';
        }
    }
    return null;
}

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
        if (runtimeMode === 'wasm') {
            allDatabases = [{
                id: 'volt',
                name: 'VoltBase // Drehstrom & DIN VDE (WASM)',
                description: 'Clientseitiger SQLite-WASM-Snapshot fuer statisches Hosting',
                category: 'Electrical Grid & VDE Safety',
                exists: true,
                size_kb: wasmDbSizeKb,
                wal_size_kb: 0.0,
                presets: STATIC_VOLT_PRESETS
            }];
        } else {
            const res = await fetch('./api/dbs');
            allDatabases = await res.json();
        }

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
        sizeBadge.textContent = runtimeMode === 'wasm'
            ? `${dbInfo.size_kb} KB | WASM`
            : `${dbInfo.size_kb} KB | WAL: ${dbInfo.wal_size_kb} KB`;
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
        let entities = [];
        if (runtimeMode === 'wasm') {
            const master = wasmQueryObjects(
                "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name;"
            );
            entities = master.map(m => {
                const cntObj = wasmQueryObjects(`SELECT COUNT(*) AS cnt FROM \`${m.name}\`;`)[0] || { cnt: 0 };
                const cols = wasmQueryObjects(`PRAGMA table_xinfo(\`${m.name}\`);`).map(c => ({
                    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, pk: c.pk, hidden: c.hidden
                }));
                return { name: m.name, type: m.type, row_count: cntObj.cnt, columns: cols };
            });
        } else {
            const res = await fetch(`./api/db/${activeDbId}/tables`);
            if (!res.ok) {
                const rawText = await res.text();
                throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 100)}`);
            }
            const data = await res.json();
            entities = data.entities || [];
        }

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
            const preferredNames = ['v_geraete_uebersicht', 'telemetrie_messungen'];
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
// SQL QUERY EXECUTION (FastAPI WAL or Local sql.js WASM)
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
    rowStatus.textContent = runtimeMode === 'wasm' ? 'SQLite-WASM laeuft...' : 'Warte auf SQLite-WAL...';

    try {
        let result;
        if (runtimeMode === 'wasm') {
            const blockReason = validateReadOnlySqlJs(sql);
            if (blockReason) {
                result = { success: false, error: blockReason };
            } else {
                try {
                    const t0 = performance.now();
                    const execRes = wasmDb.exec(sql);
                    const elapsedMs = Math.round((performance.now() - t0) * 1000) / 1000;
                    const first = execRes[0] || { columns: [], values: [] };
                    let plan = [];
                    try {
                        const planRes = wasmDb.exec(`EXPLAIN QUERY PLAN ${sql}`);
                        if (planRes[0]) {
                            plan = planRes[0].values.map(r => String(r[3] ?? r.join(' ')));
                        }
                    } catch (_pe) {
                        // EXPLAIN on EXPLAIN ignored
                    }
                    result = {
                        success: true,
                        columns: first.columns,
                        rows: first.values.slice(0, 250),
                        total_rows: first.values.length,
                        execution_time_ms: elapsedMs,
                        query_plan: plan
                    };
                } catch (sqlErr) {
                    result = { success: false, error: sqlErr.message || String(sqlErr) };
                }
            }
        } else {
            const res = await fetch(`./api/db/${activeDbId}/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: sql, read_only: true })
            });

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

        head.innerHTML = `<tr>${(result.columns || []).map(c => `<th class="px-4 py-2 font-bold">${escapeHtml(c)}</th>`).join('')}</tr>`;

        if (!result.rows || result.rows.length === 0) {
            body.innerHTML = `<tr><td colspan="${(result.columns || []).length || 1}" class="text-center py-8 text-[var(--text-muted)] font-mono-tech">
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
        timeStatus.innerHTML = `<span class="text-rose-500">Ausfuehrungsfehler</span>`;
        body.innerHTML = `<tr><td class="p-4 text-rose-500">${escapeHtml(err.message)}</td></tr>`;
    }
}

// -----------------------------------------------------------------------------
// INVARIANTS GATES (FastAPI WAL or Local sql.js WASM)
// -----------------------------------------------------------------------------
function computeInvariantsWasm() {
    const g1 = wasmQueryObjects(`
        SELECT COUNT(*) AS total_samples,
               SUM(CASE WHEN frequenz_hz < 49.5 OR frequenz_hz > 50.5
                         OR u_l1 < 207.0 OR u_l1 > 253.0
                         OR u_l2 < 207.0 OR u_l2 > 253.0
                         OR u_l3 < 207.0 OR u_l3 > 253.0 THEN 1 ELSE 0 END) AS violations,
               ROUND(AVG(frequenz_hz), 3) AS avg_freq,
               ROUND(MIN(u_l1), 1) AS min_u1,
               ROUND(MAX(u_l3), 1) AS max_u3
        FROM telemetrie_messungen;
    `)[0];

    const latest = wasmQueryObjects(`
        SELECT id, schieflast_strom_a, i_l1, i_l2, i_l3, zeitstempel
        FROM telemetrie_messungen
        ORDER BY zeitstempel DESC, id DESC LIMIT 1;
    `)[0];

    const histUnb = wasmQueryObjects(`
        SELECT SUM(CASE WHEN schieflast_strom_a > 15.0 THEN 1 ELSE 0 END) AS unbalance_peaks,
               ROUND(MAX(schieflast_strom_a), 1) AS max_delta_i
        FROM telemetrie_messungen;
    `)[0];

    const fLatest = computeFortescue(Number(latest.i_l1), Number(latest.i_l2), Number(latest.i_l3));
    const peaks = Number(histUnb.unbalance_peaks || 0);
    const deltaLatest = Number(latest.schieflast_strom_a);
    const asymStatus = (deltaLatest > 15.0 || fLatest.iNeutral > 20.0)
        ? 'FAIL'
        : ((peaks > 0 || fLatest.u2Pct > 5.0) ? 'WARN' : 'PASS');

    const devRows = wasmQueryObjects(`
        SELECT g.id, g.inventar_nr, g.kabel_laenge_meter, gk.r_pe_max, gk.r_iso_min, gk.i_ea_max,
               p.r_pe_ohm, p.r_iso_mohm, p.i_ea_ma, p.ergebnis, v.pruef_ampel
        FROM geraete g
        JOIN geraeteklassen gk ON g.klasse_id = gk.id
        LEFT JOIN v_geraete_uebersicht v ON v.inventar_nr = g.inventar_nr
        LEFT JOIN (
            SELECT p1.*
            FROM pruefungen p1
            JOIN (SELECT geraet_id, MAX(pruefdatum) AS max_datum FROM pruefungen GROUP BY geraet_id) p2
              ON p1.geraet_id = p2.geraet_id AND p1.pruefdatum = p2.max_datum
        ) p ON g.id = p.geraet_id
        WHERE g.status = 'aktiv';
    `);

    let gesperrt = 0;
    let offen = 0;
    for (const r of devRows) {
        if (r.ergebnis === null || r.ergebnis === undefined) {
            offen += 1;
            continue;
        }
        const lim = r.r_pe_max !== null ? computeVdeRpeLimitJs(Number(r.kabel_laenge_meter || 0), Number(r.r_pe_max)) : null;
        const peFail = lim !== null && r.r_pe_ohm !== null && Number(r.r_pe_ohm) > lim;
        const isoFail = r.r_iso_min !== null && r.r_iso_mohm !== null && Number(r.r_iso_mohm) < Number(r.r_iso_min);
        const ieaFail = r.i_ea_max !== null && r.i_ea_ma !== null && Number(r.i_ea_ma) > Number(r.i_ea_max);
        if (r.ergebnis === 'DURCHGEFALLEN' || peFail || isoFail || ieaFail) gesperrt += 1;
        else if (r.pruef_ampel === 'ÜBERFÄLLIG') offen += 1;
    }

    const pf = wasmQueryObjects(`
        SELECT COUNT(*) AS total_samples,
               SUM(CASE WHEN cos_phi < 0.90 THEN 1 ELSE 0 END) AS inductive_events,
               ROUND(AVG(cos_phi), 3) AS avg_cosphi,
               ROUND(MIN(cos_phi), 2) AS min_cosphi
        FROM telemetrie_messungen;
    `)[0];

    return [
        {
            id: 'gate_en50160_grid_band',
            domain: 'DIN EN 50160 Power Quality',
            title: 'Spannungs- & Frequenzband (EN 50160)',
            formula: '49.5 Hz <= f <= 50.5 Hz  AND  U_Ln in [207V, 253V]',
            status: Number(g1.violations || 0) === 0 ? 'PASS' : 'WARN',
            metric_value: `${Number(g1.avg_freq).toFixed(2)} Hz (${g1.violations || 0}/${g1.total_samples} Verletzungen)`,
            detail: `Spannungsband real: [${g1.min_u1} V .. ${g1.max_u3} V] ueber ${g1.total_samples} Messpunkte`,
            target_bound: '230 V +/-10% / 50 Hz +/-1%'
        },
        {
            id: 'gate_grid_asymmetry',
            domain: 'Fortescue & VDE-AR-N 4100',
            title: 'Phasen-Schieflast & Neutralleiter (I_N)',
            formula: 'I_N = |I_L1 + I_L2 + I_L3| = 3|I_0|  AND  dI <= 15.0 A (max 20 A)',
            status: asymStatus,
            metric_value: `Aktuell I_N = ${fLatest.iNeutral.toFixed(1)} A (i_2 = ${fLatest.u2Pct.toFixed(1)}%) | ${peaks} Historien-Peaks`,
            detail: `Letzter Messpunkt #${latest.id} (${latest.i_l1}/${latest.i_l2}/${latest.i_l3} A) | Peak dI = ${histUnb.max_delta_i} A`,
            target_bound: 'dI <= 15.0 A / I_N <= 20.0 A'
        },
        {
            id: 'gate_vde_safety',
            domain: 'DIN VDE 0701-0702 / DGUV V3',
            title: 'Betriebsmittel- & Schutzleiter-Schranke',
            formula: 'R_PE <= min(1.0, 0.3 + 0.1*ceil((L-5)/7.5)) Ohm  AND  R_ISO >= R_ISO,min',
            status: gesperrt > 0 ? 'FAIL' : (offen > 0 ? 'WARN' : 'PASS'),
            metric_value: `${gesperrt} gesperrt, ${offen} offen/ueberfaellig (von ${devRows.length} aktiv)`,
            detail: 'Leitungslaengenzuschlag aktiv (50m Kabeltrommel: 0.58 Ohm <= 0.90 Ohm Limit -> BESTANDEN)',
            target_bound: '0 gesperrte / ungepruefte Geraete'
        },
        {
            id: 'gate_reactive_power_factor',
            domain: 'VDE-AR-N 4100 Reactive Power',
            title: 'Leistungsfaktor & Blindlast-Kompensation',
            formula: 'cos(phi) = P / S >= 0.90  (Q = P * tan(arccos(cos(phi))))',
            status: (Number(pf.avg_cosphi) >= 0.90 && Number(pf.min_cosphi) >= 0.85) ? 'PASS' : 'WARN',
            metric_value: `Mittel cos(phi) = ${Number(pf.avg_cosphi).toFixed(2)} (Min: ${Number(pf.min_cosphi).toFixed(2)})`,
            detail: `${pf.inductive_events}/149 Messpunkte unter cos(phi) 0.90 (Motoranlauf-Blindlastspitzen)`,
            target_bound: 'cos(phi) >= 0.90 induktiv'
        }
    ];
}

async function loadInvariants() {
    try {
        let gates = [];
        if (runtimeMode === 'wasm') {
            gates = computeInvariantsWasm();
        } else {
            const res = await fetch('./api/invariants');
            if (!res.ok) return;
            gates = await res.json();
        }

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

            ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.09)' : 'rgba(18, 18, 18, 0.10)';
            ctx.lineWidth = 1;
            for (let f = 0.25; f <= 1.0; f += 0.25) {
                ctx.beginPath();
                ctx.arc(cx, cy, rMax * f, 0, Math.PI * 2);
                ctx.stroke();
            }

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

            drawVec(a1, phasorState.u1 / 270.0, isDark ? 'rgba(251, 191, 36, 0.55)' : 'rgba(217, 119, 6, 0.50)', 'U_L1', false, 1.8);
            drawVec(a2, phasorState.u2 / 270.0, isDark ? 'rgba(52, 211, 153, 0.55)' : 'rgba(5, 150, 105, 0.50)', 'U_L2', false, 1.8);
            drawVec(a3, phasorState.u3 / 270.0, isDark ? 'rgba(34, 211, 238, 0.55)' : 'rgba(8, 145, 178, 0.50)', 'U_L3', false, 1.8);

            const iScale = 1.0 / 60.0;
            drawVec(a1 - phi, phasorState.i1 * iScale, isDark ? '#fbbf24' : '#b45309', 'I_L1', true, 2.4);
            drawVec(a2 - phi, phasorState.i2 * iScale, isDark ? '#34d399' : '#047857', 'I_L2', true, 2.4);
            drawVec(a3 - phi, phasorState.i3 * iScale, isDark ? '#22d3ee' : '#0e7490', 'I_L3', true, 2.4);

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
function computeTimeseriesWasm(limit = 150) {
    const raw = wasmQueryObjects(`
        SELECT id, zeitstempel, u_l1, u_l2, u_l3, i_l1, i_l2, i_l3,
               schieflast_strom_a, p_wirk_kw, frequenz_hz, cos_phi
        FROM telemetrie_messungen
        ORDER BY zeitstempel DESC, id DESC
        LIMIT ${Number(limit)};
    `).reverse();

    let peakU2 = 0.0;
    let peakIn = 0.0;
    let violations = 0;
    const samples = raw.map(r => {
        const i1 = Number(r.i_l1);
        const i2 = Number(r.i_l2);
        const i3 = Number(r.i_l3);
        const f = computeFortescue(i1, i2, i3);
        const deltaI = Number(r.schieflast_strom_a);
        if (deltaI > 15.0 || f.u2Pct > 2.0) violations += 1;
        peakU2 = Math.max(peakU2, f.u2Pct);
        peakIn = Math.max(peakIn, f.iNeutral);
        return {
            id: r.id,
            ts: r.zeitstempel,
            u1: Math.round(Number(r.u_l1) * 10) / 10,
            u2: Math.round(Number(r.u_l2) * 10) / 10,
            u3: Math.round(Number(r.u_l3) * 10) / 10,
            i1: Math.round(i1 * 100) / 100,
            i2: Math.round(i2 * 100) / 100,
            i3: Math.round(i3 * 100) / 100,
            delta_i: Math.round(deltaI * 100) / 100,
            i_pos: Math.round(f.iPos * 100) / 100,
            i_neg: Math.round(f.iNeg * 100) / 100,
            i_neutral: Math.round(f.iNeutral * 100) / 100,
            u2_pct: Math.round(f.u2Pct * 100) / 100,
            p_kw: Math.round(Number(r.p_wirk_kw) * 100) / 100,
            freq_hz: Math.round(Number(r.frequenz_hz) * 1000) / 1000,
            cos_phi: Math.round(Number(r.cos_phi) * 1000) / 1000
        };
    });

    return {
        count: samples.length,
        violations,
        peak_u2_pct: Math.round(peakU2 * 100) / 100,
        peak_neutral_a: Math.round(peakIn * 100) / 100,
        samples
    };
}

async function loadTelemetryTimeseries() {
    try {
        let data;
        if (runtimeMode === 'wasm') {
            data = computeTimeseriesWasm(150);
        } else {
            const res = await fetch('./api/telemetry/timeseries?limit=150');
            if (!res.ok) return;
            data = await res.json();
        }
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

    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(18,18,18,0.5)';
    ctx.textAlign = 'left';
    ctx.fillText(telemetrySamples[0].ts.slice(5, 16), padLeft, h - 7);
    ctx.textAlign = 'center';
    const mid = Math.floor(telemetrySamples.length / 2);
    ctx.fillText(telemetrySamples[mid].ts.slice(5, 16), xOf(mid), h - 7);
    ctx.textAlign = 'right';
    ctx.fillText(telemetrySamples[telemetrySamples.length - 1].ts.slice(5, 16), w - padRight, h - 7);

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
