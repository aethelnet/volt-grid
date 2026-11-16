import unittest
from fastapi.testclient import TestClient

from backend.app import app
from backend.invariants import compute_fortescue_unbalance, compute_vde_rpe_limit
from backend.registry import DATABASE_REGISTRY


class TestVoltGridStudio(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_list_databases_focused_and_valid(self):
        """Prueft, dass ausschliesslich real existierende Elektrotechnik-Datenbanken gelistet werden."""
        res = self.client.get("/api/dbs")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIsInstance(data, list)
        db_ids = {d["id"] for d in data}
        self.assertIn("volt", db_ids)
        self.assertNotIn("trading", db_ids)
        self.assertNotIn("tournaments", db_ids)
        for entry in data:
            self.assertTrue(entry["exists"], f"Toter DB-Eintrag gelistet: {entry['id']}")

    def test_get_tables_volt_includes_generated_columns(self):
        """Prueft das Schema-Listing inkl. virtueller Generated Column schieflast_strom_a."""
        res = self.client.get("/api/db/volt/tables")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["db_id"], "volt")
        by_name = {t["name"]: t for t in data["entities"]}
        self.assertTrue(
            {"geraete", "telemetrie_messungen", "v_geraete_uebersicht", "v_hersteller_qualitaet"}.issubset(
                by_name.keys()
            )
        )

        tele_cols = {c["name"] for c in by_name["telemetrie_messungen"]["columns"]}
        self.assertIn("schieflast_strom_a", tele_cols)

    def test_all_registered_sql_presets_execute_cleanly(self):
        """Fuehrt jedes Diagnose-Preset aus der Registry real gegen SQLite aus (0 SQL-Fehler)."""
        for db_id, meta in DATABASE_REGISTRY.items():
            for preset in meta["presets"]:
                res = self.client.post(
                    f"/api/db/{db_id}/query",
                    json={"query": preset["sql"], "read_only": True},
                )
                self.assertEqual(res.status_code, 200, f"HTTP-Fehler bei Preset '{preset['title']}'")
                payload = res.json()
                self.assertTrue(
                    payload.get("success"),
                    f"SQL-Fehler bei Preset '{preset['title']}': {payload.get('error')}",
                )
                self.assertGreater(len(payload["rows"]), 0, f"Preset '{preset['title']}' lieferte 0 Zeilen")
                self.assertLess(payload["execution_time_ms"], 50.0)

    def test_read_only_sandbox_blocks_destructive_query(self):
        """Verifiziert, dass destruktive Schreiboperationen im Read-Only-Modus abgewiesen werden."""
        destructive_queries = [
            "DELETE FROM geraete WHERE inventar_nr = '1';",
            "DROP TABLE telemetrie_messungen;",
            "UPDATE geraete SET hersteller = 'HACKED';",
            "INSERT INTO geraete (inventar_nr) VALUES ('99999');",
        ]
        for sql in destructive_queries:
            for ro_flag in (True, False):
                res = self.client.post(
                    "/api/db/volt/query",
                    json={"query": sql, "read_only": ro_flag},
                )
                self.assertEqual(
                    res.status_code,
                    403,
                    f"Sicherheitsluecke: '{sql}' (read_only={ro_flag}) wurde nicht blockiert!",
                )

    def test_invariant_gates_evaluation(self):
        """Verifiziert die formale Pruefung aller 4 Elektrotechnik-Systemschranken."""
        res = self.client.get("/api/invariants")
        self.assertEqual(res.status_code, 200)
        gates = res.json()
        self.assertEqual(len(gates), 4)

        by_id = {g["id"]: g for g in gates}
        expected_ids = {
            "gate_en50160_grid_band",
            "gate_grid_asymmetry",
            "gate_vde_safety",
            "gate_reactive_power_factor",
        }
        self.assertEqual(set(by_id.keys()), expected_ids)

        for gid, g in by_id.items():
            self.assertIn(g["status"], ("PASS", "WARN", "FAIL"), f"Gate '{gid}' unerwartet: {g}")
            self.assertNotIn("DB Error", g.get("metric_value", ""))
            self.assertTrue(g.get("formula"))

        self.assertIn("Hz", by_id["gate_en50160_grid_band"]["metric_value"])
        self.assertIn("cos(phi)", by_id["gate_reactive_power_factor"]["metric_value"])

    def test_telemetry_timeseries_endpoint(self):
        """Prueft die 149-Punkte-Zeitreihen-API fuer den Schieflast- & Neutralleiter-Graphen."""
        res = self.client.get("/api/telemetry/timeseries?limit=150")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["count"], 149)
        self.assertGreater(data["peak_u2_pct"], 20.0)
        self.assertGreater(data["peak_neutral_a"], 40.0)
        sample = data["samples"][0]
        for key in ("ts", "i1", "i2", "i3", "i_pos", "i_neg", "i_neutral", "u2_pct", "cos_phi"):
            self.assertIn(key, sample)

    def test_fortescue_and_vde_length_math(self):
        """Prueft Fortescue-Zerlegung und DIN VDE 0701-0702 Leitungslaengenzuschlag."""
        i_pos, i_neg, u2_pct = compute_fortescue_unbalance(16.0, 16.0, 16.0)
        self.assertAlmostEqual(i_pos, 16.0, places=6)
        self.assertAlmostEqual(i_neg, 0.0, places=6)
        self.assertAlmostEqual(u2_pct, 0.0, places=6)

        i_pos_u, i_neg_u, u2_pct_u = compute_fortescue_unbalance(30.0, 15.0, 15.0)
        self.assertAlmostEqual(i_pos_u, 20.0, places=6)
        self.assertAlmostEqual(i_neg_u, 5.0, places=6)
        self.assertAlmostEqual(u2_pct_u, 25.0, places=6)

        self.assertEqual(compute_fortescue_unbalance(0.0, 0.0, 0.0), (0.0, 0.0, 0.0))

        # DIN VDE 0701-0702: 0.3 Ohm bis 5m, +0.1 Ohm je weitere angefangene 7.5m, max 1.0 Ohm
        self.assertEqual(compute_vde_rpe_limit(4.0), 0.3)
        self.assertEqual(compute_vde_rpe_limit(5.0), 0.3)
        self.assertEqual(compute_vde_rpe_limit(12.5), 0.4)
        self.assertEqual(compute_vde_rpe_limit(50.0), 0.9)
        self.assertEqual(compute_vde_rpe_limit(100.0), 1.0)


if __name__ == "__main__":
    unittest.main()
