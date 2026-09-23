import os
from pathlib import Path

MONOREPO_ROOT = Path(__file__).resolve().parents[3]

def resolve_db_path(candidates, default):
    for c in candidates:
        if c:
            p = Path(c)
            if p.exists():
                return p
    return Path(default)

DATABASE_REGISTRY = {
    "lgnn": {
        "id": "lgnn",
        "name": "LGNN Neural Core",
        "description": "Liquid Graph Neural Network Synapsen, Neuronen und Kognitions-Commits",
        "path": resolve_db_path([
            Path(__file__).resolve().parent.parent / "data" / "lgnn.db",
            MONOREPO_ROOT / "packages" / "aethelnet-node" / "lgnn.db",
            "/home/ubuntu/voltgrid/data/lgnn.db",
            "/home/ubuntu/auratic-systems-prime/packages/aethelnet-node/lgnn.db",
            "/home/ubuntu/aethelburg-observer/lgnn.db",
            "/home/ubuntu/lgnn.db",
        ], default=MONOREPO_ROOT / "packages" / "aethelnet-node" / "lgnn.db"),
        "category": "Neural Architecture",
        "presets": [
            {
                "title": "Top 10 aktivierte Neuronen",
                "sql": "SELECT id, node_type, text_content, mean_activation, confidence, last_updated\nFROM lgnn_nodes\nORDER BY mean_activation DESC\nLIMIT 10;",
                "description": "Zeigt die Knoten mit den höchsten Aktivierungspotenzialen im kontinuierlichen Zustandsraum."
            },
            {
                "title": "Letzte kognitive Commits",
                "sql": "SELECT hash, parent_hash, coherence_score, description, timestamp\nFROM lgnn_commits\nORDER BY timestamp DESC\nLIMIT 10;",
                "description": "Inspektion der Ouroboros-Graphenmutationen und Revisionshistorie."
            },
            {
                "title": "Stärkste Synapsen (Edges)",
                "sql": "SELECT source, target, weight\nFROM lgnn_edges\nORDER BY weight DESC\nLIMIT 15;",
                "description": "Synaptische Kopplungsstärken zwischen kognitiven Neuronen im dynamischen Graph."
            }
        ]
    },
    "trading": {
        "id": "trading",
        "name": "Trade Ledger Live",
        "description": "Echtzeit-Ausführungsbuch der Sovereign Trading Engine",
        "path": resolve_db_path([
            MONOREPO_ROOT / "trade_ledger_live.db",
            "/home/ubuntu/auratic-systems-prime/trade_ledger.db",
        ], default=MONOREPO_ROOT / "trade_ledger_live.db"),
        "category": "Algorithmic Finance",
        "presets": [
            {
                "title": "Letzte Ausführungen & Fills",
                "sql": "SELECT id, symbol, side, price, size, pnl, fee, timestamp\nFROM trades\nORDER BY timestamp DESC\nLIMIT 15;",
                "description": "Prüfung von Slippage, Order-Fills und realisierten PnL-Werten."
            },
            {
                "title": "PnL & Volumen Aggregation",
                "sql": "SELECT \n    symbol,\n    COUNT(id) AS trade_count,\n    ROUND(SUM(pnl), 2) AS total_pnl,\n    ROUND(AVG(fee), 4) AS avg_fee\nFROM trades\nGROUP BY symbol;",
                "description": "Statistische Performance-Übersicht pro gehandeltem Asset."
            }
        ]
    },
    "guardian": {
        "id": "guardian",
        "name": "Guardian & P2P Mesh",
        "description": "Aethelnet Guardian Registry, offene Positionen und On-Chain Sentinel",
        "path": resolve_db_path([
            MONOREPO_ROOT / "data" / "aethelnet_guardian.db",
            "/home/ubuntu/auratic-systems-prime/sovereign_trading_engine/crawler/aethelnet_guardian.db",
        ], default=MONOREPO_ROOT / "data" / "aethelnet_guardian.db"),
        "category": "Sentinel & Security",
        "presets": [
            {
                "title": "Aktive Guardian Positionen",
                "sql": "SELECT * FROM open_positions LIMIT 20;",
                "description": "Überwachung der aktiven Sentinel-Sicherungsorders und Deckungen."
            }
        ]
    },
    "tournaments": {
        "id": "tournaments",
        "name": "Edison Tournament State",
        "description": "Deterministische State-Machine für Edison-Format Turniere",
        "path": resolve_db_path([
            MONOREPO_ROOT / "apps" / "ygo_rl" / "tournaments.db",
            "/home/ubuntu/ygo_service/apps/tournaments.db",
        ], default=MONOREPO_ROOT / "apps" / "ygo_rl" / "tournaments.db"),
        "category": "State Machine & WASM",
        "presets": [
            {
                "title": "Aktuelle Turnierliste",
                "sql": "SELECT id, name, status, current_round, created_at FROM tournaments;",
                "description": "Status aller aktiven und archivierten Store Locals Turniere."
            },
            {
                "title": "Turnier-Audit Trail",
                "sql": "SELECT id, tournament_id, event_type, payload, created_at\nFROM tournament_audit_log\nORDER BY id DESC\nLIMIT 10;",
                "description": "Kryptographisch nachvollziehbare Ereignis-Historie."
            }
        ]
    },
    "volt": {
        "id": "volt",
        "name": "VoltGrid Cyber-Physical Twin",
        "description": "3-Phasen-Drehstromnetz, Fortescue-Asymmetrie und DIN VDE 0701 Verifikation",
        "path": resolve_db_path([
            os.getenv("VOLTBASE_PATH"),
            Path(__file__).resolve().parent.parent / "data" / "voltbase.db",
            os.getenv("FERIZ_VOLTBASE_PATH"),
        ], default=Path(__file__).resolve().parent.parent / "data" / "voltbase.db"),
        "category": "Cyber-Physical Systems",
        "presets": [
            {
                "title": "Gesperrte Geräte (Mängel)",
                "sql": "SELECT inventar_nr, geraet_name, hersteller, letztes_ergebnis, pruef_ampel\nFROM v_geraete_uebersicht\nWHERE pruef_ampel = 'GESPERRT';",
                "description": "Formale Schrankenverletzungen bei Schutzleiter- und Isolationsmessungen."
            },
            {
                "title": "Netz-Schieflast über 15 Ampere",
                "sql": "SELECT zeitstempel, i_l1, i_l2, i_l3, schieflast_strom_a, p_wirk_kw\nFROM telemetrie_messungen\nWHERE schieflast_strom_a > 15.0\nORDER BY zeitstempel DESC\nLIMIT 10;",
                "description": "Asymmetrische Phasenströme mit Gefährdungspotenzial für Neutralleiter."
            }
        ]
    }
}

def get_available_databases():
    """Gibt Metadaten zu allen existierenden Datenbanken zurück."""
    results = []
    for key, info in DATABASE_REGISTRY.items():
        p = Path(info["path"])
        exists = p.exists()
        size_bytes = p.stat().st_size if exists else 0
        wal_path = Path(str(p) + "-wal")
        wal_size_bytes = wal_path.stat().st_size if wal_path.exists() else 0
        
        results.append({
            "id": key,
            "name": info["name"],
            "description": info["description"],
            "category": info["category"],
            "path": str(p),
            "exists": exists,
            "size_kb": round(size_bytes / 1024, 1),
            "wal_size_kb": round(wal_size_bytes / 1024, 1),
            "presets": info["presets"]
        })
    return results
