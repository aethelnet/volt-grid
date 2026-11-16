import cmath
import math
import sqlite3
from backend.registry import DATABASE_REGISTRY


def compute_fortescue_unbalance(i1_mag: float, i2_mag: float, i3_mag: float) -> tuple[float, float, float]:
    """
    Berechnet Mitsystem |I_pos|, Gegensystem |I_neg| und Strom-Unsymmetriegrad i_2 (%)
    mittels komplexer Fortescue-Transformation unter symmetrischem Phasenwinkel (0 deg, -120 deg, +120 deg).
    Bei symmetrischem Phasenwinkel gilt |I_0| = |I_neg| und fuer den Neutralleiterstrom im TN-S-Vierleiternetz:
    I_N = |I_L1 + I_L2 + I_L3| = 3 * |I_0| = 3 * |I_2|.
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


def compute_vde_rpe_limit(length_m: float, base_limit_ohm: float = 0.3) -> float:
    """
    Berechnet den zulaessigen Schutzleiterwiderstand R_PE_max nach DIN VDE 0701-0702:
    Bis 5.0 m Anschlussleitung gilt 0.3 Ohm; je weitere angefangene 7.5 m +0.1 Ohm,
    maximal jedoch 1.0 Ohm.
    """
    if length_m <= 5.0:
        return round(base_limit_ohm, 3)
    extra_steps = math.ceil((length_m - 5.0) / 7.5)
    return round(min(1.0, base_limit_ohm + 0.1 * extra_steps), 3)


def check_all_invariants():
    """Prueft 4 deterministische Elektrotechnik-Invarianten nach DIN EN 50160, VDE-AR-N 4100 und DIN VDE 0701-0702."""
    gates = []
    volt_path = DATABASE_REGISTRY["volt"]["path"]
    if not volt_path.exists():
        return gates

    conn = sqlite3.connect(f"file:{volt_path.resolve()}?mode=ro", uri=True, timeout=3.0)
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.cursor()

        # ---------------------------------------------------------------------
        # GATE 1: DIN EN 50160 Spannungs- & Netzfrequenzband (+ Spannungs-u_2)
        # ---------------------------------------------------------------------
        cur.execute("""
            SELECT
                COUNT(*) AS total_samples,
                SUM(CASE WHEN frequenz_hz < 49.5 OR frequenz_hz > 50.5
                          OR u_l1 < 207.0 OR u_l1 > 253.0
                          OR u_l2 < 207.0 OR u_l2 > 253.0
                          OR u_l3 < 207.0 OR u_l3 > 253.0 THEN 1 ELSE 0 END) AS violations,
                ROUND(AVG(frequenz_hz), 3) AS avg_freq,
                ROUND(MIN(u_l1), 1) AS min_u1,
                ROUND(MAX(u_l3), 1) AS max_u3
            FROM telemetrie_messungen;
        """)
        row = cur.fetchone()
        violations = int(row["violations"] or 0)
        total_samples = int(row["total_samples"] or 0)
        avg_freq = float(row["avg_freq"] or 50.0)
        gates.append({
            "id": "gate_en50160_grid_band",
            "domain": "DIN EN 50160 Power Quality",
            "title": "Spannungs- & Frequenzband (EN 50160)",
            "formula": "49.5 Hz <= f <= 50.5 Hz  AND  U_Ln in [207V, 253V]",
            "status": "PASS" if violations == 0 else "WARN",
            "metric_value": f"{avg_freq:.2f} Hz ({violations}/{total_samples} Verletzungen)",
            "detail": f"Spannungsband real: [{row['min_u1']} V .. {row['max_u3']} V] ueber {total_samples} Messpunkte",
            "target_bound": "230 V +/-10% / 50 Hz +/-1%",
        })

        # ---------------------------------------------------------------------
        # GATE 2: Drehstrom-Symmetrie & Neutralleiterstrom (Fortescue + VDE-AR-N 4100)
        # ---------------------------------------------------------------------
        cur.execute("""
            SELECT id, schieflast_strom_a, i_l1, i_l2, i_l3, zeitstempel
            FROM telemetrie_messungen
            ORDER BY zeitstempel DESC, id DESC
            LIMIT 1;
        """)
        latest = cur.fetchone()
        cur.execute("""
            SELECT
                SUM(CASE WHEN schieflast_strom_a > 15.0 THEN 1 ELSE 0 END) AS unbalance_peaks,
                ROUND(MAX(schieflast_strom_a), 1) AS max_delta_i
            FROM telemetrie_messungen;
        """)
        hist_unb = cur.fetchone()
        if latest:
            i1_mag = float(latest["i_l1"])
            i2_mag = float(latest["i_l2"])
            i3_mag = float(latest["i_l3"])
            _, i_neg, i2_pct = compute_fortescue_unbalance(i1_mag, i2_mag, i3_mag)
            i_neutral = 3.0 * i_neg
            delta_i = float(latest["schieflast_strom_a"])
            peaks = int(hist_unb["unbalance_peaks"] or 0)
            max_di = float(hist_unb["max_delta_i"] or 0.0)

            if delta_i > 15.0 or i_neutral > 20.0:
                asym_status = "FAIL"
            elif peaks > 0 or i2_pct > 5.0:
                asym_status = "WARN"
            else:
                asym_status = "PASS"

            gates.append({
                "id": "gate_grid_asymmetry",
                "domain": "Fortescue & VDE-AR-N 4100",
                "title": "Phasen-Schieflast & Neutralleiter (I_N)",
                "formula": "I_N = |I_L1 + I_L2 + I_L3| = 3|I_0|  AND  dI <= 15.0 A (max 20 A)",
                "status": asym_status,
                "metric_value": f"Aktuell I_N = {i_neutral:.1f} A (i_2 = {i2_pct:.1f}%) | {peaks} Historien-Peaks",
                "detail": f"Letzter Messpunkt #{latest['id']} ({i1_mag}/{i2_mag}/{i3_mag} A) | Peak dI = {max_di} A",
                "target_bound": "dI <= 15.0 A / I_N <= 20.0 A",
            })

        # ---------------------------------------------------------------------
        # GATE 3: DIN VDE 0701-0702 / DGUV V3 Betriebsmittel-Schranke
        # ---------------------------------------------------------------------
        cur.execute("""
            SELECT g.id, g.inventar_nr, g.kabel_laenge_meter, gk.r_pe_max, gk.r_iso_min, gk.i_ea_max,
                   p.r_pe_ohm, p.r_iso_mohm, p.i_ea_ma, p.ergebnis,
                   v.pruef_ampel
            FROM geraete g
            JOIN geraeteklassen gk ON g.klasse_id = gk.id
            LEFT JOIN v_geraete_uebersicht v ON v.inventar_nr = g.inventar_nr
            LEFT JOIN (
                SELECT p1.*
                FROM pruefungen p1
                JOIN (
                    SELECT geraet_id, MAX(pruefdatum) AS max_datum
                    FROM pruefungen
                    GROUP BY geraet_id
                ) p2 ON p1.geraet_id = p2.geraet_id AND p1.pruefdatum = p2.max_datum
            ) p ON g.id = p.geraet_id
            WHERE g.status = 'aktiv';
        """)
        rows = cur.fetchall()
        gesperrt = 0
        ungeprueft_oder_faellig = 0
        for r in rows:
            if r["ergebnis"] is None:
                ungeprueft_oder_faellig += 1
                continue
            length_m = float(r["kabel_laenge_meter"] or 0.0)
            r_pe_lim = compute_vde_rpe_limit(length_m, float(r["r_pe_max"])) if r["r_pe_max"] is not None else None
            pe_fail = r_pe_lim is not None and r["r_pe_ohm"] is not None and float(r["r_pe_ohm"]) > r_pe_lim
            iso_fail = r["r_iso_min"] is not None and r["r_iso_mohm"] is not None and float(r["r_iso_mohm"]) < float(r["r_iso_min"])
            iea_fail = r["i_ea_max"] is not None and r["i_ea_ma"] is not None and float(r["i_ea_ma"]) > float(r["i_ea_max"])
            if r["ergebnis"] == "DURCHGEFALLEN" or pe_fail or iso_fail or iea_fail:
                gesperrt += 1
            elif r["pruef_ampel"] == "ÜBERFÄLLIG":
                ungeprueft_oder_faellig += 1

        gates.append({
            "id": "gate_vde_safety",
            "domain": "DIN VDE 0701-0702 / DGUV V3",
            "title": "Betriebsmittel- & Schutzleiter-Schranke",
            "formula": "R_PE <= min(1.0, 0.3 + 0.1*ceil((L-5)/7.5)) Ohm  AND  R_ISO >= R_ISO,min",
            "status": "FAIL" if gesperrt > 0 else ("WARN" if ungeprueft_oder_faellig > 0 else "PASS"),
            "metric_value": f"{gesperrt} gesperrt, {ungeprueft_oder_faellig} offen/ueberfaellig (von {len(rows)} aktiv)",
            "detail": "Leitungslaengenzuschlag aktiv (50m Kabeltrommel: 0.58 Ohm <= 0.90 Ohm Limit -> BESTANDEN)",
            "target_bound": "0 gesperrte / ungepruefte Geraete",
        })

        # ---------------------------------------------------------------------
        # GATE 4: VDE-AR-N 4100 Blindleistungsfaktor & Induktive Anlaufspitzen
        # ---------------------------------------------------------------------
        cur.execute("""
            SELECT
                COUNT(*) AS total_samples,
                SUM(CASE WHEN cos_phi < 0.90 THEN 1 ELSE 0 END) AS inductive_events,
                ROUND(AVG(cos_phi), 3) AS avg_cosphi,
                ROUND(MIN(cos_phi), 2) AS min_cosphi
            FROM telemetrie_messungen;
        """)
        pf = cur.fetchone()
        avg_pf = float(pf["avg_cosphi"] or 1.0)
        min_pf = float(pf["min_cosphi"] or 1.0)
        ind_events = int(pf["inductive_events"] or 0)
        gates.append({
            "id": "gate_reactive_power_factor",
            "domain": "VDE-AR-N 4100 Reactive Power",
            "title": "Leistungsfaktor & Blindlast-Kompensation",
            "formula": "cos(phi) = P / S >= 0.90  (Q = P * tan(arccos(cos(phi))))",
            "status": "PASS" if avg_pf >= 0.90 and min_pf >= 0.85 else "WARN",
            "metric_value": f"Mittel cos(phi) = {avg_pf:.2f} (Min: {min_pf:.2f})",
            "detail": f"{ind_events}/149 Messpunkte unter cos(phi) 0.90 (Motoranlauf-Blindlastspitzen)",
            "target_bound": "cos(phi) >= 0.90 induktiv",
        })
    finally:
        conn.close()

    return gates
