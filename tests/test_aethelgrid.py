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
        self.assertTrue({"lgnn", "trading", "volt"}.issubset(db_ids))

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
            for ro_flag in (True, False):
                res = self.client.post("/api/db/volt/query", json={
                    "query": sql,
                    "read_only": ro_flag
                })
                self.assertEqual(res.status_code, 403, f"Sicherheitslücke: '{sql}' (read_only={ro_flag}) wurde nicht blockiert!")

    def test_invariant_gates_evaluation(self):
        """Verifiziert die formale Prüfung aller Systemschranken inkl. Status- und Werte-Integrität."""
        res = self.client.get("/api/invariants")
        self.assertEqual(res.status_code, 200)
        gates = res.json()
        self.assertIsInstance(gates, list)
        self.assertEqual(len(gates), 4)

        by_id = {g["id"]: g for g in gates}
        expected_ids = {"gate_vde_safety", "gate_grid_asymmetry", "gate_en50160_grid_band", "gate_lgnn_stability"}
        self.assertEqual(set(by_id.keys()), expected_ids)

        for gid, g in by_id.items():
            self.assertIn(
                g["status"],
                ("PASS", "WARN", "FAIL"),
                f"Gate '{gid}' fiel auf '{g['status']}' zurück (Detail: {g.get('detail')})"
            )
            self.assertNotIn("DB Error", g.get("metric_value", ""))
            self.assertNotIn("DB Busy", g.get("metric_value", ""))
            self.assertTrue(g.get("formula"), f"Gate '{gid}' hat keine mathematische Formel definiert")

        # Prüfe konkrete Werte auf den ausgelieferten Referenzdatenbanken
        self.assertEqual(by_id["gate_lgnn_stability"]["status"], "PASS")
        self.assertIn("|I₂| =", by_id["gate_grid_asymmetry"]["metric_value"])
        self.assertIn("Hz", by_id["gate_en50160_grid_band"]["metric_value"])

    def test_fortescue_symmetrical_components_math(self):
        """Prüft die komplexe Fortescue-Transformation gegen analytische Referenzwerte."""
        from backend.invariants import compute_fortescue_unbalance

        # 1. Perfekt symmetrisches Drehstromsystem (16 A auf L1, L2, L3) -> |I_pos| = 16 A, |I_neg| = 0 A, u2 = 0%
        i_pos, i_neg, u2_pct = compute_fortescue_unbalance(16.0, 16.0, 16.0)
        self.assertAlmostEqual(i_pos, 16.0, places=6)
        self.assertAlmostEqual(i_neg, 0.0, places=6)
        self.assertAlmostEqual(u2_pct, 0.0, places=6)

        # 2. Einphasige Überlast (30 A, 15 A, 15 A) -> |I_pos| = 20 A, |I_neg| = 5 A, u2 = 25.0%
        i_pos_u, i_neg_u, u2_pct_u = compute_fortescue_unbalance(30.0, 15.0, 15.0)
        self.assertAlmostEqual(i_pos_u, 20.0, places=6)
        self.assertAlmostEqual(i_neg_u, 5.0, places=6)
        self.assertAlmostEqual(u2_pct_u, 25.0, places=6)

        # 3. Stromloses Netz (0 A, 0 A, 0 A) -> kein ZeroDivisionError
        i_pos_z, i_neg_z, u2_pct_z = compute_fortescue_unbalance(0.0, 0.0, 0.0)
        self.assertEqual((i_pos_z, i_neg_z, u2_pct_z), (0.0, 0.0, 0.0))


