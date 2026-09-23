# VOLTGRID // Cyber-Physical Twin & Invariant Studio

[![License: AGPL v3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Production](https://img.shields.io/badge/Live%20Node-volt.aethelburg.network-16a34a)](https://volt.aethelburg.network)
[![Architecture](https://img.shields.io/badge/CI-Architects%20Desk%20Brutalist-black)](#)

**VoltGrid** ist ein leichtgewichtiges, Headless-fähiges **Cyber-Physical Diagnostics & Invariant Verification Studio** für komplexe dreiphasige Drehstrom-Verteilernetze und verteilte relationale Datenbanken im SQLite WAL-Modus.

Das System verbindet zeitkontinuierliche Vektorfelder in der komplexen Ebene mit symbolischer Schranken-Verifikation nach europäischen Sicherheitsnormen (DIN VDE 0701-0702).

---

## ⚡ Kernfunktionen

1. **Fortescue-Symmetrische Komponenten (Phasor Decomposition)**:
   - Zerlegt asymmetrische Dreiphasen-Messungen ($I_{L1}, I_{L2}, I_{L3}$) in Echtzeit in Mit- ($I_1$), Gegen- ($I_2$) und Nullsysteme ($I_0$).
   - Prädiktive Erkennung von Schieflasten ($I_{\text{unbalance}} > 15\,\text{A}$) und thermischen Überlastungen von Neutralleitern.
   - Hochauflösendes HTML5 Canvas Phasor-Diagramm mit Echtzeit-Vektorrotation in der Gaußschen Zahlenebene.

2. **DIN VDE 0701-0702 Invariant Constraint Solver**:
   - Parametrische Grenzwertverifikation für Schutzleiterwiderstand ($R_{\text{PE}} \le 0.3\,\Omega$), Isolationswiderstand ($R_{\text{ISO}} \ge 1.0\,\text{M}\Omega$) und Schutzleiterstrom ($I_{\text{PE}} \le 3.5\,\text{mA}$).
   - Dynamischer Leitungslängenzuschlag: $0.1\,\Omega$ für die ersten $5\,\text{m} + 0.1\,\Omega$ pro zusätzliche $7.5\,\text{m}$ (max. $1.0\,\Omega$).
   - Automatische Mängel-Klassifikation (`GESPERRT`, `WARNUNG`, `KONFORM`).

3. **Read-Only SQLite WAL Diagnostics Engine**:
   - Sub-Millisekunden Latenz für komplexe relationale Abfragen im Write-Ahead-Logging (WAL) Modus.
   - Strikte Sicherheits-Sandbox: Nur `SELECT`, `WITH` und `EXPLAIN` Statements zugelassen.
   - Vorkonfigurierte Diagnose-Presets zur schnellen Inspektion von Transaktions-Ledgern, PnL-Historien und Mesh-Topologien.

4. **Architects Desk Brutalist CI**:
   - Minimalistische Benutzeroberfläche: Warmes Velum (`#f8f8f6`), 1px Hairlines (`#e2e2dc`), tiefschwarze Typografie (`#121212`) und 24px Konstruktionsraster.
   - Vollständiger Dark/Light-Mode Switcher mit persistenter Speicherung.

---

## 🚀 Schnelleinstieg

### Voraussetzungen
- Python 3.10+
- `pip install fastapi uvicorn pydantic`

### Installation & Start
```bash
# 1. Repository klonen
git clone https://github.com/aethelnet/volt-grid.git
cd volt-grid

# 2. Abhängigkeiten installieren
pip install -r requirements.txt

# 3. Server starten (Port 8050)
python3 -m backend.app
# oder via Shell-Skript:
./start_hud.sh
```

Öffne im Browser:
👉 **[http://localhost:8050](http://localhost:8050)**

---

## 🧪 Test-Suite

```bash
python3 -m unittest discover tests
```
- Multi-DB Schema Discovery & Metadaten-Generierung
- Query Execution Performance
- Read-Only Sandbox Sicherheits-Verifikation (Ablehnung von `DROP`, `UPDATE`, `INSERT`)
- Fortescue-Invarianz & DIN VDE Schranken-Prüfung

---

## 🔒 Lizenz

GNU Affero General Public License v3.0 (AGPLv3). Siehe [LICENSE](LICENSE).
