import time
import sqlite3
import re
from pathlib import Path
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, List, Dict, Any

from backend.registry import DATABASE_REGISTRY, get_available_databases
from backend.invariants import check_all_invariants

app = FastAPI(
    title="AethelGrid SRE Studio",
    description="Database-First Diagnostics HUD & Invariant Gate Inspector for Auratic Prime",
    version="1.0.0"
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

# -----------------------------------------------------------------------------
# DATABASE CONNECTION HELPER
# -----------------------------------------------------------------------------
def get_db_conn(db_id: str):
    if db_id not in DATABASE_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unbekannte Datenbank-ID: '{db_id}'")
    
    entry = DATABASE_REGISTRY[db_id]
    db_path = Path(entry["path"])
    if not db_path.exists():
        raise HTTPException(status_code=404, detail=f"Datenbankdatei existiert nicht: {db_path}")

    conn = sqlite3.connect(str(db_path), timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    return conn

# -----------------------------------------------------------------------------
# API ROUTEN
# -----------------------------------------------------------------------------

@app.get("/api/dbs")
def list_databases():
    """Listet alle registrierten SQLite-Datenbanken der Monorepo auf."""
    return get_available_databases()

@app.get("/api/db/{db_id}/tables")
def get_database_tables(db_id: str):
    """Liefert alle Tabellen, Zeilenzahlen und Spaltenschemata einer Datenbank."""
    conn = get_db_conn(db_id)
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
            
            # Row count
            row_count = 0
            try:
                cur.execute(f"SELECT COUNT(*) FROM `{name}`;")
                row_count = cur.fetchone()[0]
            except Exception:
                pass

            # Columns
            cur.execute(f"PRAGMA table_info(`{name}`);")
            cols = [{"cid": c[0], "name": c[1], "type": c[2], "notnull": c[3], "pk": c[5]} for c in cur.fetchall()]

            results.append({
                "name": name,
                "type": ent_type,
                "row_count": row_count,
                "columns": cols
            })

        return {"db_id": db_id, "entities": results}
    finally:
        conn.close()

@app.post("/api/db/{db_id}/query")
def execute_database_query(db_id: str, req: QueryRequest):
    """Führt eine relationale SQL-Abfrage auf der gewählten Datenbank aus."""
    sql = req.query.strip()
    if not sql:
        raise HTTPException(status_code=400, detail="Leere SQL-Abfrage übergeben.")

    # 1. READ-ONLY SCHUTZSCHRANKE (AST / Regex Token Parser)
    if req.read_only:
        # Nur SELECT und EXPLAIN erlauben
        first_token = re.split(r'\s+', sql.lstrip('(; \n\t'))[0].upper()
        if first_token not in ("SELECT", "EXPLAIN", "WITH"):
            raise HTTPException(
                status_code=403, 
                detail=f"Read-Only Sandbox aktiv: Schreiboperation '{first_token}' ist in der öffentlichen Diagnose-Ansicht gesperrt."
            )

        # Destruktive Statements verbieten
        forbidden_patterns = [
            r'\bINSERT\b', r'\bUPDATE\b', r'\bDELETE\b', r'\bDROP\b', 
            r'\bALTER\b', r'\bCREATE\b', r'\bVACUUM\b', r'\bATTACH\b', 
            r'\bDETACH\b', r'\bPRAGMA\s+.*\b=\b'
        ]
        for pat in forbidden_patterns:
            if re.search(pat, sql, re.IGNORECASE):
                raise HTTPException(
                    status_code=403,
                    detail=f"Sicherheitsfilter: Destruktives Schlüsselwort gefunden. Im SRE-Studio sind nur Lesezugriffe gestattet."
                )

    conn = get_db_conn(db_id)
    try:
        cur = conn.cursor()
        start_time = time.perf_counter()
        cur.execute(sql)
        execution_time_ms = round((time.perf_counter() - start_time) * 1000.0, 3)

        if cur.description:
            columns = [c[0] for c in cur.description]
            rows = [list(r) for r in cur.fetchall()]
            total_rows = len(rows)

            # Query Plan abrufen
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
                "rows": rows[:250], # Max 250 rows to protect UI
                "total_rows": total_rows,
                "execution_time_ms": execution_time_ms,
                "query_plan": query_plan
            }
        else:
            conn.commit()
            return {
                "success": True,
                "is_select": False,
                "rows_affected": cur.rowcount,
                "execution_time_ms": execution_time_ms,
                "query_plan": []
            }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }
    finally:
        conn.close()

@app.get("/api/invariants")
def get_invariant_gates():
    """Prüft deterministische Sicherheits- und Stabilitäts-Invarianten aller Monorepo-Systeme."""
    return check_all_invariants()

# -----------------------------------------------------------------------------
# STATIC FRONTEND MOUNT
# -----------------------------------------------------------------------------
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
