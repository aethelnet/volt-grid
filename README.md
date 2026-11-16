# VOLTGRID // 3-Phase Fortescue & DIN VDE Invariant Studio

[![License: AGPL v3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Standards](https://img.shields.io/badge/Normen-DIN%20VDE%200701--0702%20%7C%20EN%2050160-black)](#)
[![Architecture](https://img.shields.io/badge/Engine-FastAPI%20%2B%20SQLite%20WAL-16a34a)](#)

**VoltGrid** ist ein in sich geschlossenes, leichtgewichtiges **Cyber-Physical Diagnostics & Invariant Verification Studio** fuer dreiphasige Drehstrom-Verteilernetze (`400 V / 230 V, 50 Hz`) und elektrische Betriebsmittelpruefungen im deterministischen SQLite-WAL-Modus.

Das Werkzeug verbindet komplexe Zeigerrechnung in der Gausschen Zahlenebene (Fortescue-Zerlegung und Kirchhoffsche Sternpunkt-Summation) mit formaler Schrankenpruefung nach **DIN VDE 0701-0702** und **DIN EN 50160**.

---

## Kernfunktionen

1. **Symmetrische Komponenten nach Fortescue & Sternpunkt-Analyse (`[03 // SCHIEFLAST & PHASOR]`)**:
   - Zerlegt asymmetrische Dreiphasenstroeme ($I_{L1}, I_{L2}, I_{L3}$) in Echtzeit in Mitsystem ($|I_1|$), Gegensystem ($|I_2|$) und Unsymmetriegrad ($u_2 = |I_2| / |I_1|$).
   - Berechnet und zeichnet den resultierenden Neutralleitervektor $\vec{I}_N = \vec{I}_{L1} + \vec{I}_{L2} + \vec{I}_{L3} = 3 \vec{I}_0$ direkt in das rotierende 50-Hz-Zeigerdiagramm.
   - Interaktiver Phasen-Pruefstand mit Schiebereglern ($I_{L1..L3}$, $\cos\varphi$) sowie **149-Punkte-Zeitreihenverlauf** aus `voltbase.db` inkl. Klick-Inspektion einzelner Messzeitpunkte.

2. **DIN VDE 0701-0702 & DIN EN 50160 Invariant Gates (`[02 // INVARIANT GATES]`)**:
   - Parametrische Grenzwertverifikation fuer Schutzleiterwiderstand ($R_{\text{PE}}$), Isolationswiderstand ($R_{\text{ISO}} \ge 1.0\,\text{M}\Omega$) und Schutzleiterstrom ($I_{\text{EA}} \le 3.5\,\text{mA}$).
   - Exakter Leitungslaengenzuschlag nach DIN VDE 0701-0702: $0.3\,\Omega$ bis $5\,\text{m}$ Anschlussleitung $+\,0.1\,\Omega$ je weitere angefangene $7.5\,\text{m}$ (gedeckelt bei $1.0\,\Omega$, z. B. $50\,\text{m}$ Kabeltrommel $\rightarrow 0.90\,\Omega$).
   - Automatische Spannungs- und Frequenzbandpruefung ($230\,\text{V} \pm 10\,\%$, $50\,\text{Hz} \pm 1\,\%$) ueber die gesamte Messhistorie.

3. **Read-Only SQLite WAL Query Studio (`[01 // SQL QUERY STUDIO]`)**:
   - Sub-Millisekunden-Abfragen (`mode=ro` + `PRAGMA query_only = ON`) inklusive `EXPLAIN QUERY PLAN` B-Tree-Inspektion und Unterstuetzung fuer virtuelle Generated Columns (`schieflast_strom_a`).
   - Mehrstufige Read-Only-Sandbox blockiert destruktive Operationen (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `ATTACH`, `PRAGMA ... =`).
   - Fachspezifische Diagnose-Presets fuer gesperrte Betriebsmittel, Schieflast-Peaks $> 15\,\text{A}$, Leitungslaengenzuschlaege und Hersteller-Ausfallquoten.

---

## Schnelleinstieg

### Voraussetzungen
- Python 3.10+

### Installation & Start
```bash
# 1. Abhaengigkeiten installieren
pip install -r requirements.txt

# 2. Server auf Port 8050 starten
python3 -m backend.app
# oder via Launcher-Skript:
./start_hud.sh
```

Im Browser oeffnen:
**[http://localhost:8050](http://localhost:8050)**

---

## Test-Suite

```bash
python3 -m unittest discover tests -v
```
Prueft Schema-Discovery (inkl. Generated Columns), alle SQL-Diagnose-Presets, Read-Only-Sandbox-Sicherheit (`HTTP 403`), Zeitreihen-Telemetrie (`149` Messpunkte) sowie die analytische Fortescue- und DIN-VDE-Mathematik.

---

## Lizenz

GNU Affero General Public License v3.0 (AGPLv3). Siehe [LICENSE](LICENSE).
