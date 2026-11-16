import os
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.invariants import check_all_invariants, compute_fortescue_unbalance
from backend.registry import DATABASE_REGISTRY, get_available_databases

app = FastAPI(
    title="VoltGrid Cyber-Physical Studio",
    description="3-Phase Symmetrical Components, DIN VDE 0701-0702 Verification & Read-Only SQLite WAL Studio",
    version="1.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


class QueryRequest(BaseModel):
    query: str
    read_only: Optional[bool] = True


def get_db_conn(db_id: str, read_only: bool = True):
    if db_id not in DATABASE_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unbekannte Datenbank-ID: '{db_id}'")

    entry = DATABASE_REGISTRY[db_id]
    db_path = Path(entry["path"])
    if not db_path.exists():
        raise HTTPException(status_code=404, detail=f"Datenbankdatei existiert nicht: {db_path}")

    if read_only:
        conn = sqlite3.connect(f"file:{db_path.resolve()}?mode=ro", uri=True, timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only = ON;")
    else:
        conn = sqlite3.connect(str(db_path), timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL;")
    return conn


@app.get("/api/dbs")
def list_databases():
    """Listet alle vorhandenen SQLite-Datenbanken inkl. WAL-Status und Diagnose-Presets auf."""
    return get_available_databases()


@app.get("/api/db/{db_id}/tables")
def get_database_tables(db_id: str):
    """Liefert alle Tabellen, Views, Zeilenzahlen und Spaltenschemata (inkl. Generated Columns)."""
    conn = get_db_conn(db_id, read_only=True)
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT name, type
            FROM sqlite_master
            WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
            ORDER BY type, name;
        """)
        entities = cur.fetchall()

        results = []
        for ent in entities:
            name = ent["name"]
            ent_type = ent["type"]

            row_count = 0
            try:
                cur.execute(f"SELECT COUNT(*) FROM `{name}`;")
                row_count = cur.fetchone()[0]
            except Exception:
                pass

            cur.execute(f"PRAGMA table_xinfo(`{name}`);")
            cols = [
                {"cid": c[0], "name": c[1], "type": c[2], "notnull": c[3], "pk": c[5], "hidden": c[6]}
                for c in cur.fetchall()
            ]

            results.append(
                {
                    "name": name,
                    "type": ent_type,
                    "row_count": row_count,
                    "columns": cols,
                }
            )

        return {"db_id": db_id, "entities": results}
    finally:
        conn.close()


def sanitize_cell_value(val: Any) -> Any:
    if isinstance(val, (bytes, bytearray)):
        try:
            return val.decode("utf-8")
        except UnicodeDecodeError:
            hex_prefix = val[:8].hex()
            return f"<BLOB {len(val)}B: 0x{hex_prefix}...>"
    return val


@app.post("/api/db/{db_id}/query")
def execute_database_query(db_id: str, req: QueryRequest):
    """Fuehrt eine strikt lesende SQL-Abfrage auf der gewaehlten SQLite-WAL-Datenbank aus."""
    sql = req.query.strip()
    if not sql:
        raise HTTPException(status_code=400, detail="Leere SQL-Abfrage uebergeben.")

    allow_writes = os.getenv("VOLTGRID_ALLOW_WRITES", "0") == "1"
    enforce_read_only = True if not allow_writes else bool(req.read_only)

    if enforce_read_only:
        first_token = re.split(r"\s+", sql.lstrip("(; \n\t"))[0].upper()
        if first_token not in ("SELECT", "EXPLAIN", "WITH"):
            raise HTTPException(
                status_code=403,
                detail=f"Read-Only Sandbox aktiv: Schreiboperation '{first_token}' ist gesperrt.",
            )

        forbidden_patterns = [
            r"\bINSERT\b",
            r"\bUPDATE\b",
            r"\bDELETE\b",
            r"\bDROP\b",
            r"\bALTER\b",
            r"\bCREATE\b",
            r"\bVACUUM\b",
            r"\bATTACH\b",
            r"\bDETACH\b",
            r"\bPRAGMA\s+.*\b=\b",
        ]
        for pat in forbidden_patterns:
            if re.search(pat, sql, re.IGNORECASE):
                raise HTTPException(
                    status_code=403,
                    detail="Sicherheitsfilter: Destruktives Schluesselwort blockiert (nur Lesezugriff erlaubt).",
                )

    conn = get_db_conn(db_id, read_only=enforce_read_only)
    try:
        cur = conn.cursor()
        start_time = time.perf_counter()
        cur.execute(sql)
        execution_time_ms = round((time.perf_counter() - start_time) * 1000.0, 3)

        if cur.description:
            columns = [c[0] for c in cur.description]
            raw_rows = cur.fetchall()
            total_rows = len(raw_rows)
            rows = [[sanitize_cell_value(val) for val in r] for r in raw_rows[:250]]

            query_plan = []
            try:
                p_cur = conn.cursor()
                p_cur.execute(f"EXPLAIN QUERY PLAN {sql}")
                for p in p_cur.fetchall():
                    query_plan.append(p[3] if len(p) > 3 else str(p))
            except Exception:
                pass

            return {
                "success": True,
                "is_select": True,
                "columns": columns,
                "rows": rows,
                "total_rows": total_rows,
                "execution_time_ms": execution_time_ms,
                "query_plan": query_plan,
            }
        else:
            conn.commit()
            return {
                "success": True,
                "is_select": False,
                "rows_affected": cur.rowcount,
                "execution_time_ms": execution_time_ms,
                "query_plan": [],
            }
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        conn.close()


@app.get("/api/invariants")
def get_invariant_gates():
    """Prueft deterministische DIN-VDE-, EN-50160- und Zustandsraum-Invarianten."""
    return check_all_invariants()


@app.get("/api/telemetry/timeseries")
def get_telemetry_timeseries(limit: int = Query(150, ge=10, le=500)):
    """
    Liefert die chronologische 3-Phasen-Messreihe aus `voltbase.db` inklusive
    Fortescue-Komponenten (|I_1|, |I_2|, u_2 %) und resultierendem Neutralleiterstrom I_N.
    """
    conn = get_db_conn("volt", read_only=True)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, zeitstempel, u_l1, u_l2, u_l3, i_l1, i_l2, i_l3,
                   schieflast_strom_a, p_wirk_kw, frequenz_hz, cos_phi
            FROM telemetrie_messungen
            ORDER BY zeitstempel DESC, id DESC
            LIMIT ?;
            """,
            (limit,),
        )
        rows = list(reversed(cur.fetchall()))
        samples = []
        peak_u2 = 0.0
        peak_in = 0.0
        violations = 0
        for r in rows:
            i1 = float(r["i_l1"])
            i2 = float(r["i_l2"])
            i3 = float(r["i_l3"])
            i_pos, i_neg, u2_pct = compute_fortescue_unbalance(i1, i2, i3)
            i_neutral = 3.0 * i_neg
            delta_i = float(r["schieflast_strom_a"])
            if delta_i > 15.0 or u2_pct > 2.0:
                violations += 1
            peak_u2 = max(peak_u2, u2_pct)
            peak_in = max(peak_in, i_neutral)
            samples.append(
                {
                    "id": r["id"],
                    "ts": r["zeitstempel"],
                    "u1": round(float(r["u_l1"]), 1),
                    "u2": round(float(r["u_l2"]), 1),
                    "u3": round(float(r["u_l3"]), 1),
                    "i1": round(i1, 2),
                    "i2": round(i2, 2),
                    "i3": round(i3, 2),
                    "delta_i": round(delta_i, 2),
                    "i_pos": round(i_pos, 2),
                    "i_neg": round(i_neg, 2),
                    "i_neutral": round(i_neutral, 2),
                    "u2_pct": round(u2_pct, 2),
                    "p_kw": round(float(r["p_wirk_kw"]), 2),
                    "freq_hz": round(float(r["frequenz_hz"]), 3),
                    "cos_phi": round(float(r["cos_phi"]), 3),
                }
            )
        return {
            "count": len(samples),
            "violations": violations,
            "peak_u2_pct": round(peak_u2, 2),
            "peak_neutral_a": round(peak_in, 2),
            "samples": samples,
        }
    finally:
        conn.close()


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8050"))
    uvicorn.run("backend.app:app", host=host, port=port, reload=False)
