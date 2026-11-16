import os
from pathlib import Path


def resolve_db_path(candidates, default):
    for c in candidates:
        if c:
            p = Path(c)
            if p.exists():
                return p
    return Path(default)


DATABASE_REGISTRY = {
    "volt": {
        "id": "volt",
        "name": "VoltBase // Drehstrom & DIN VDE",
        "description": "3-Phasen-Drehstromnetz, Fortescue-Asymmetrie und DIN VDE 0701-0702 Betriebsmittelpruefung",
        "path": resolve_db_path(
            [
                os.getenv("VOLTBASE_PATH"),
                Path(__file__).resolve().parent.parent / "data" / "voltbase.db",
            ],
            default=Path(__file__).resolve().parent.parent / "data" / "voltbase.db",
        ),
        "category": "Electrical Grid & VDE Safety",
        "presets": [
            {
                "title": "Gesperrte Betriebsmittel (DIN VDE)",
                "sql": "SELECT inventar_nr, geraet_name, hersteller, schutzklasse_code, standort, letztes_ergebnis, pruef_ampel\nFROM v_geraete_uebersicht\nWHERE pruef_ampel = 'GESPERRT';",
                "description": "Formale Schrankenverletzungen bei Schutzleiter-, Isolations- und Ableitstrommessungen.",
            },
            {
                "title": "Netz-Schieflast > 15 A (Peak-Events)",
                "sql": "SELECT zeitstempel, u_l1, u_l2, u_l3, i_l1, i_l2, i_l3, ROUND(schieflast_strom_a, 2) AS delta_i_a, p_wirk_kw, cos_phi\nFROM telemetrie_messungen\nWHERE schieflast_strom_a > 15.0\nORDER BY schieflast_strom_a DESC, zeitstempel DESC\nLIMIT 20;",
                "description": "Asymmetrische Phasenstroeme mit erhoehter thermischer Neutralleiter-Belastung.",
            },
            {
                "title": "R_PE Leitungslaengenzuschlag (VDE 0701)",
                "sql": "SELECT g.inventar_nr, g.bezeichnung, g.kabel_laenge_meter AS laenge_m, p.r_pe_ohm,\n       ROUND(MIN(1.0, CASE WHEN g.kabel_laenge_meter <= 5.0 THEN 0.3 ELSE 0.3 + 0.1 * CAST(((g.kabel_laenge_meter - 5.0) + 7.4999) / 7.5 AS INT) END), 2) AS vde_limit_ohm,\n       p.r_iso_mohm, p.i_ea_ma, p.ergebnis\nFROM geraete g\nJOIN geraeteklassen gk ON g.klasse_id = gk.id\nJOIN pruefungen p ON p.geraet_id = g.id\nWHERE gk.r_pe_max IS NOT NULL\nORDER BY g.kabel_laenge_meter DESC;",
                "description": "Verifiziert den dynamischen Schutzleiter-Grenzwert (0.3 Ohm bis 5m + 0.1 Ohm je 7.5m, max. 1.0 Ohm).",
            },
            {
                "title": "Blindleistungsspitzen (cos phi < 0.80)",
                "sql": "SELECT zeitstempel, p_wirk_kw, cos_phi, i_l1, i_l2, i_l3, ROUND(schieflast_strom_a, 2) AS delta_i_a\nFROM telemetrie_messungen\nWHERE cos_phi < 0.80\nORDER BY cos_phi ASC, p_wirk_kw DESC\nLIMIT 20;",
                "description": "Induktive Anlauf- und Blindlastspitzen unterhalb des VDE-AR-N 4100 Zielbands.",
            },
            {
                "title": "Hersteller-Ausfallquote",
                "sql": "SELECT hersteller, anzahl_pruefungen, bestanden, durchgefallen, avg_r_pe_ohm, avg_r_iso_mohm, durchfallquote_prozent\nFROM v_hersteller_qualitaet\nORDER BY durchfallquote_prozent DESC, anzahl_pruefungen DESC;",
                "description": "Aggregierte Zuverlaessigkeitsstatistik nach Betriebsmittel-Hersteller.",
            },
        ],
    },
}

# Optionale Einbindung einer weiteren externen SQLite-WAL-Datenbank per Umgebungsvariable
_extra_db = os.getenv("VOLTGRID_EXTRA_DB")
if _extra_db and Path(_extra_db).exists():
    DATABASE_REGISTRY["external"] = {
        "id": "external",
        "name": f"External WAL ({Path(_extra_db).name})",
        "description": "Benutzerdefinierte SQLite-Datenbank im Read-Only-Inspektionsmodus",
        "path": Path(_extra_db),
        "category": "External SQLite WAL",
        "presets": [],
    }


def get_available_databases(include_missing: bool = False):
    """Gibt Metadaten zu allen real vorhandenen SQLite-Datenbanken zurueck."""
    show_all = include_missing or os.getenv("VOLTGRID_SHOW_MISSING_DBS", "0") == "1"
    results = []
    for key, info in DATABASE_REGISTRY.items():
        p = Path(info["path"])
        exists = p.exists()
        if not exists and not show_all:
            continue
        size_bytes = p.stat().st_size if exists else 0
        wal_path = Path(str(p) + "-wal")
        wal_size_bytes = wal_path.stat().st_size if wal_path.exists() else 0

        results.append(
            {
                "id": key,
                "name": info["name"],
                "description": info["description"],
                "category": info["category"],
                "path": str(p),
                "exists": exists,
                "size_kb": round(size_bytes / 1024, 1),
                "wal_size_kb": round(wal_size_bytes / 1024, 1),
                "presets": info["presets"],
            }
        )
    return results
