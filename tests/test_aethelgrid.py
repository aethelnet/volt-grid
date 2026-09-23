import unittest
import sqlite3
from pathlib import Path
from fastapi.testclient import TestClient
from backend.app import app
from backend.registry import DATABASE_REGISTRY

class TestAethelGrid(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Fallback Test-DB für LGNN erzeugen, falls nicht vorhanden
        lgnn_path = Path(DATABASE_REGISTRY["lgnn"]["path"])
        if not lgnn_path.exists():
            lgnn_path.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(lgnn_path) as conn:
                conn.execute("CREATE TABLE IF NOT EXISTS lgnn_nodes (id INTEGER PRIMARY KEY, node_type TEXT, text_content TEXT, mean_activation REAL, confidence REAL, last_updated TEXT);")
                conn.execute("INSERT OR IGNORE INTO lgnn_nodes VALUES (1, 'sensor', 'synapse_01', 0.85, 0.99, '2026-09-23');")

    def setUp(self):
        self.client = TestClient(app)

    def test_list_databases(self):
        """Prüft, ob alle registrierten Monorepo-Datenbanken aufgelistet werden."""
        res = self.client.get("/api/dbs")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIsInstance(data, list)
        db_ids = {d["id"] for d in data}
        self.assertTrue({"lgnn", "guardian", "trading", "volt"}.issubset(db_ids))

    def test_get_tables_volt(self):
        """Prüft das Schema-Listing für den VoltGrid Cyber-Physical Twin."""
        res = self.client.get("/api/db/volt/tables")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["db_id"], "volt")
        table_names = {t["name"] for t in data["entities"]}
        self.assertTrue({"geraete", "telemetrie_messungen"}.issubset(table_names))

    def test_get_tables_lgnn(self):
        """Prüft das Schema-Listing für den LGNN Neural Core."""
        res = self.client.get("/api/db/lgnn/tables")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["db_id"], "lgnn")
        table_names = {t["name"] for t in data["entities"]}
        self.assertIn("lgnn_nodes", table_names)

    def test_query_execution_valid_select(self):
        """Führt eine valide SELECT-Abfrage auf voltbase.db aus."""
        res = self.client.post("/api/db/volt/query", json={
            "query": "SELECT inventar_nr, bezeichnung, hersteller FROM geraete LIMIT 5;",
            "read_only": True
        })
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["success"])
        self.assertIn("columns", data)
        self.assertIn("execution_time_ms", data)
        self.assertLess(data["execution_time_ms"], 50.0) # Sub-50ms execution

    def test_read_only_sandbox_blocks_destructive_query(self):
        """Verifiziert, dass destruktive Schreiboperationen im Read-Only-Modus abgewiesen werden."""
        destructive_queries = [
            "DELETE FROM geraete WHERE inventar_nr = '1';",
            "DROP TABLE telemetrie_messungen;",
            "UPDATE geraete SET hersteller = 'HACKED';",
            "INSERT INTO geraete (inventar_nr) VALUES ('99999');"
        ]
        for sql in destructive_queries:
            res = self.client.post("/api/db/volt/query", json={
                "query": sql,
                "read_only": True
            })
            self.assertEqual(res.status_code, 403, f"Sicherheitslücke: '{sql}' wurde nicht blockiert!")

    def test_invariant_gates_evaluation(self):
        """Verifiziert die formale Prüfung aller Systemschranken."""
        res = self.client.get("/api/invariants")
        self.assertEqual(res.status_code, 200)
        gates = res.json()
        self.assertIsInstance(gates, list)
        self.assertEqual(len(gates), 4) # 4 definierte Invarianten

        gate_ids = {g["id"] for g in gates}
        self.assertIn("gate_vde_safety", gate_ids)
        self.assertIn("gate_grid_asymmetry", gate_ids)
        self.assertIn("gate_lgnn_stability", gate_ids)
