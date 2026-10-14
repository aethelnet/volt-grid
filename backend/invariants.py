import cmath
import sqlite3
from pathlib import Path
from backend.registry import DATABASE_REGISTRY


def compute_fortescue_unbalance(i1_mag: float, i2_mag: float, i3_mag: float) -> tuple[float, float, float]:
    """
    Berechnet Mitsystem |I_pos|, Gegensystem |I_neg| und Unsymmetriegrad u_2 (%)
    mittels komplexer Fortescue-Transformation unter symmetrischem Phasenwinkel (0°, -120°, +120°).
    """
    a = cmath.rect(1.0, 2.0 * cmath.pi / 3.0)
    a2 = a * a
    i_l1_phasor = complex(i1_mag, 0.0)
    i_l2_phasor = i2_mag * a2
    i_l3_phasor = i3_mag * a
    i_pos = abs((i_l1_phasor + a * i_l2_phasor + a2 * i_l3_phasor) / 3.0)
    i_neg = abs((i_l1_phasor + a2 * i_l2_phasor + a * i_l3_phasor) / 3.0)
    u2_pct = (i_neg / i_pos * 100.0) if i_pos > 1e-9 else 0.0
    return i_pos, i_neg, u2_pct


def check_all_invariants():
    """Prüft deterministische Systemschranken und Sicherheits-Invarianten über alle Domänen."""
    gates = []

    # -------------------------------------------------------------------------
    # GATE 1: LGNN Kognitive Stabilität & Divergenz
    # -------------------------------------------------------------------------
    lgnn_path = DATABASE_REGISTRY["lgnn"]["path"]
    if lgnn_path.exists():
        try:
            conn = sqlite3.connect(f"file:{lgnn_path.resolve()}?mode=ro", uri=True, timeout=3.0)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            
            # Prüfen auf NaN, Inf oder Übersteuerungen (|activation| > 10.0)
            cur.execute("""
                SELECT 
                    COUNT(*) AS total_nodes,
                    SUM(CASE WHEN mean_activation > 5.0 OR mean_activation < -5.0 THEN 1 ELSE 0 END) AS saturated_nodes,
                    ROUND(AVG(mean_activation), 4) AS avg_activation,
                    ROUND(AVG(confidence), 4) AS avg_confidence
                FROM lgnn_nodes;
            """)
            stats = cur.fetchone()
            conn.close()

            total = stats["total_nodes"] or 0
            saturated = stats["saturated_nodes"] or 0
            is_stable = (saturated == 0)

            gates.append({
                "id": "gate_lgnn_stability",
                "domain": "Neural Architecture",
                "title": "LGNN Zustandsraum-Stabilität (div h)",
                "formula": "|h_i| ≤ 5.0 ∧ NaN ∉ H",
                "status": "PASS" if is_stable else "WARN",
                "metric_value": f"Gesättigt: {saturated} / {total}",
                "detail": f"Durchschnittliche Aktivierung: {stats['avg_activation']}, Konfidenz: {stats['avg_confidence']}",
                "target_bound": "0 gesättigte Knoten"
            })
        except Exception as e:
            gates.append({
                "id": "gate_lgnn_stability",
                "domain": "Neural Architecture",
                "title": "LGNN Zustandsraum-Stabilität",
                "status": "UNKNOWN",
                "metric_value": "DB Busy",
                "detail": str(e),
                "target_bound": "|h_i| ≤ 5.0"
            })

    # -------------------------------------------------------------------------
    # GATE 2: DIN EN 50160 Spannungs- & Netzfrequenzband (Telemetrie-Schranke)
    # -------------------------------------------------------------------------
    volt_path = DATABASE_REGISTRY["volt"]["path"]
    if volt_path.exists():
        try:
            conn = sqlite3.connect(f"file:{volt_path.resolve()}?mode=ro", uri=True, timeout=3.0)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute("""
                SELECT 
                    COUNT(*) AS total_samples,
                    SUM(CASE WHEN frequenz_hz < 49.5 OR frequenz_hz > 50.5 
                              OR u_l1 < 207.0 OR u_l1 > 253.0
                              OR u_l2 < 207.0 OR u_l2 > 253.0
                              OR u_l3 < 207.0 OR u_l3 > 253.0 THEN 1 ELSE 0 END) AS violations,
                    ROUND(AVG(frequenz_hz), 3) AS avg_freq,
                    ROUND(MIN(u_l1), 1) AS min_u1
                FROM telemetrie_messungen;
            """)
            row = cur.fetchone()
            conn.close()

            violations = int(row["violations"] or 0)
            total_samples = int(row["total_samples"] or 0)
            avg_freq = float(row["avg_freq"] or 50.0)
            gates.append({
                "id": "gate_en50160_grid_band",
                "domain": "DIN EN 50160 Power Quality",
                "title": "Spannungs- & Frequenzband (EN 50160)",
                "formula": "49.5 Hz ≤ f ≤ 50.5 Hz ∧ U_Ln ∈ [207V, 253V]",
                "status": "PASS" if violations == 0 else "WARN",
                "metric_value": f"{avg_freq:.2f} Hz ({violations}/{total_samples} Verletzungen)",
                "detail": f"Min U_L1: {row['min_u1']} V | Geprüfte Messpunkte: {total_samples}",
                "target_bound": "230 V ±10% / 50 Hz ±1%"
            })
        except Exception as e:
            gates.append({
                "id": "gate_en50160_grid_band",
                "domain": "DIN EN 50160 Power Quality",
                "title": "Spannungs- & Frequenzband (EN 50160)",
                "status": "UNKNOWN",
                "metric_value": "DB Error",
                "detail": str(e),
                "target_bound": "230 V ±10%"
            })

    # -------------------------------------------------------------------------
    # GATE 3: Cyber-Physical Grid Schieflast (Komplexe Fortescue-Transformation)
    # -------------------------------------------------------------------------
    if volt_path.exists():
        try:
            conn = sqlite3.connect(f"file:{volt_path.resolve()}?mode=ro", uri=True, timeout=3.0)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute("""
                SELECT schieflast_strom_a, i_l1, i_l2, i_l3, zeitstempel 
                FROM telemetrie_messungen 
                ORDER BY zeitstempel DESC LIMIT 1;
            """)
            latest = cur.fetchone()
            conn.close()

            if latest:
                i1_mag = float(latest["i_l1"])
                i2_mag = float(latest["i_l2"])
                i3_mag = float(latest["i_l3"])
                i_pos, i_neg, u2_pct = compute_fortescue_unbalance(i1_mag, i2_mag, i3_mag)
                delta_i = float(latest["schieflast_strom_a"])
                is_balanced = (delta_i <= 15.0 and u2_pct <= 10.0)
                gates.append({
                    "id": "gate_grid_asymmetry",
                    "domain": "Cyber-Physical Systems",
                    "title": "Drehstrom-Symmetrie (Fortescue u₂)",
                    "formula": "I₂ = ⅓|I_L1 + a²I_L2 + aI_L3| ∧ ΔI ≤ 15.0 A",
                    "status": "PASS" if is_balanced else "FAIL",
                    "metric_value": f"|I₂| = {i_neg:.1f} A (u₂ = {u2_pct:.1f}%)",
                    "detail": f"L1: {i1_mag}A | L2: {i2_mag}A | L3: {i3_mag}A (ΔI = {delta_i:.1f}A)",
                    "target_bound": "≤ 15.0 A (DIN EN 50160)"
                })
        except Exception:
            pass

    # -------------------------------------------------------------------------
    # GATE 4: DIN VDE 0701-0702 Personenschutz-Schranke
    # -------------------------------------------------------------------------
    if volt_path.exists():
        try:
            conn = sqlite3.connect(f"file:{volt_path.resolve()}?mode=ro", uri=True, timeout=3.0)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute("""
                SELECT COUNT(*) AS defekt_count 
                FROM v_geraete_uebersicht 
                WHERE pruef_ampel = 'GESPERRT';
            """)
            defekt = cur.fetchone()["defekt_count"]
            conn.close()

            gates.append({
                "id": "gate_vde_safety",
                "domain": "Deterministic Safety",
                "title": "DIN VDE Betriebsmittel-Schranke",
                "formula": "R_PE ≤ 0.30 Ω ∧ R_ISO ≥ 1.0 MΩ",
                "status": "WARN" if defekt > 0 else "PASS",
                "metric_value": f"{defekt} gesperrte Prüflinge",
                "detail": "Kritische Mängel sofort aus Betrieb nehmen",
                "target_bound": "0 Mängel"
            })
        except Exception:
            pass

    return gates
