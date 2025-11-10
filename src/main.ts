import * as leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";

// Luck import (robust, type-safe; no `any`)
import * as LUCK_LIB from "./_luck.ts";

/** Deterministic FNV-1a hash mapped to [0,1). */
function hash01(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

/** Type for a deterministic RNG used by spawning logic. */
type LuckFn = (k: string) => number;

/** Resolve a luck-like function from the _luck module without using `any`. */
function resolveLuck(mod: Record<string, unknown>): LuckFn | null {
  const keys = ["luck", "Luck", "random", "rng", "hash", "default"] as const;
  for (const k of keys) {
    const maybe = mod[k];
    if (typeof maybe === "function") {
      return (maybe as (k: string) => number);
    }
  }
  return null;
}

/** Deterministic RNG, prefers exported luck(); falls back to hash01. */
const luck: LuckFn = resolveLuck(LUCK_LIB as Record<string, unknown>) ?? hash01;

// Create basic UI elements
const controlPanelDiv = document.createElement("div");
controlPanelDiv.id = "controlPanel";
document.body.append(controlPanelDiv);

const mapDiv = document.createElement("div");
mapDiv.id = "map";
document.body.append(mapDiv);

const statusPanelDiv = document.createElement("div");
statusPanelDiv.id = "statusPanel";
statusPanelDiv.innerHTML = `
  <div><strong>Inventory:</strong> <span id="invText">Empty</span></div>
  <div><strong>Goal:</strong> hold a token of value <span id="goalText">16</span></div>
  <div id="msg"></div>
`;
document.body.append(statusPanelDiv);

const invTextEl = statusPanelDiv.querySelector("#invText") as HTMLSpanElement;
const msgEl = statusPanelDiv.querySelector("#msg") as HTMLDivElement;
const goalTextEl = statusPanelDiv.querySelector("#goalText") as HTMLSpanElement;

// Our classroom location & tunables (exactly as specified)
const CLASSROOM_LATLNG = leaflet.latLng(
  36.997936938057016,
  -122.05703507501151,
);

const GAMEPLAY_ZOOM_LEVEL = 19;
const TILE_DEGREES = 1e-4; // grid size ≈ house-sized
const NEIGHBORHOOD_SIZE = 8; // kept for parity with the sample
const CACHE_SPAWN_PROBABILITY = 0.1; // deterministic spawn probability
const INTERACT_RANGE_STEPS = 3; // near-range interaction in cell steps
const WIN_VALUE = 16; // win threshold

// Mark NEIGHBORHOOD_SIZE as used
void NEIGHBORHOOD_SIZE;

// Create the map
const map = leaflet.map(mapDiv, {
  center: CLASSROOM_LATLNG,
  zoom: GAMEPLAY_ZOOM_LEVEL,
  minZoom: GAMEPLAY_ZOOM_LEVEL,
  maxZoom: GAMEPLAY_ZOOM_LEVEL,
  zoomControl: false,
  scrollWheelZoom: false,
});

leaflet
  .tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution:
      '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  })
  .addTo(map);

// Fixed player marker at the classroom
leaflet
  .circleMarker(CLASSROOM_LATLNG, {
    radius: 6,
    color: "#1d4ed8",
    weight: 2,
    fillOpacity: 0.9,
  })
  .bindTooltip("You")
  .addTo(map);

// Types
type CellID = { i: number; j: number };

// Helpers
/** Returns a stable string key for a cell id. */
function cellKey(c: CellID): string {
  return `${c.i}:${c.j}`;
}

/** Converts latitude/longitude to grid cell indices. */
function latLngToCell(lat: number, lng: number): CellID {
  return {
    i: Math.floor(lat / TILE_DEGREES),
    j: Math.floor(lng / TILE_DEGREES),
  };
}

/** Returns Leaflet bounds literal for a cell rectangle. */
function cellToBounds(c: CellID): leaflet.LatLngBoundsLiteral {
  const south = c.i * TILE_DEGREES;
  const west = c.j * TILE_DEGREES;
  const north = (c.i + 1) * TILE_DEGREES;
  const east = (c.j + 1) * TILE_DEGREES;
  return [
    [south, west], // SW
    [north, east], // NE
  ];
}

/** Returns geographic center of a cell. */
function cellCenter(c: CellID): leaflet.LatLngExpression {
  const b = cellToBounds(c);
  return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
}

/** Chebyshev distance in grid steps between two cells. */
function chebyshevDistance(a: CellID, b: CellID): number {
  return Math.max(Math.abs(a.i - b.i), Math.abs(a.j - b.j));
}

// Deterministic initial contents + session modifications
/** Deterministic initial token value */
function initialTokenValue(c: CellID): number | undefined {
  const k = cellKey(c);
  if (luck(`${k}|spawn`) >= CACHE_SPAWN_PROBABILITY) return undefined;
  const r = luck(`${k}|value`);
  if (r < 0.25) return 1;
  if (r < 0.5) return 2;
  if (r < 0.75) return 4;
  return 8;
}

/** Stores only cells changed by the player in this session. */
const modified = new Map<string, number | undefined>();

/** Reads the current value of a cell */
function readCell(c: CellID): number | undefined {
  const k = cellKey(c);
  if (modified.has(k)) return modified.get(k);
  return initialTokenValue(c);
}

/** Writes a new value for a cell to the session modifications. */
function writeCell(c: CellID, v: number | undefined): void {
  modified.set(cellKey(c), v);
}

// Inventory & feedback
let held: number | undefined = undefined;

/** Updates inventory text and goal value in the status panel. */
function updateInventoryUI(): void {
  invTextEl.textContent = held === undefined ? "Empty" : String(held);
  goalTextEl.textContent = String(WIN_VALUE);
}

/** Shows a short, transient message under the goal line. */
function flash(msg: string, cls: "ok" | "err" | "info" = "info"): void {
  msgEl.className = cls;
  msgEl.textContent = msg;
  setTimeout(() => {
    if (msgEl.textContent === msg) msgEl.textContent = "";
  }, 1400);
}

/** Checks and announces win when held value >= WIN_VALUE. */
function checkWin(): void {
  if (held !== undefined && held >= WIN_VALUE) {
    flash(`You win! Held token value = ${held}`, "ok");
  }
}

// Layers & rendering
const rectLayer = leaflet.layerGroup().addTo(map);
const labelLayer = leaflet.layerGroup().addTo(map);

/** Draws cell rectangles and visible token labels to the current viewport edges. */
function drawGridToScreenEdges(): void {
  rectLayer.clearLayers();
  labelLayer.clearLayers();

  const b = map.getBounds();
  const sw = b.getSouthWest();
  const ne = b.getNorthEast();

  const minC = latLngToCell(sw.lat, sw.lng);
  const maxC = latLngToCell(ne.lat, ne.lng);
  const playerCell = latLngToCell(CLASSROOM_LATLNG.lat, CLASSROOM_LATLNG.lng);

  for (let i = minC.i - 1; i <= maxC.i + 1; i++) {
    for (let j = minC.j - 1; j <= maxC.j + 1; j++) {
      const id: CellID = { i, j };
      const canInteract =
        chebyshevDistance(id, playerCell) <= INTERACT_RANGE_STEPS;

      const rect = leaflet
        .rectangle(cellToBounds(id), {
          color: canInteract ? "#10b981" : "#9ca3af",
          weight: 1,
          fillOpacity: canInteract ? 0.15 : 0.08,
        })
        .addTo(rectLayer);

      const val = readCell(id);
      if (val !== undefined) {
        leaflet
          .marker(cellCenter(id), {
            interactive: false,
            icon: leaflet.divIcon({
              className: "cellLabel",
              html:
                '<div style="font-weight:700;background:rgba(255,255,255,.85);' +
                'border:1px solid rgba(0,0,0,.15);padding:2px 6px;border-radius:6px">' +
                val +
                "</div>",
            }),
          })
          .addTo(labelLayer);
      }

      rect.on("click", () => {
        if (!canInteract) {
          flash("Too far away to interact.", "err");
          return;
        }
        handleCellClick(id);
      });
    }
  }
}

// Interaction logic
/** Handles clicking a cell: pickup if hand empty, or equal-merge to double. */
function handleCellClick(id: CellID): void {
  const current = readCell(id);

  // Pick up when hand empty and cell has a token
  if (held === undefined && current !== undefined) {
    held = current;
    writeCell(id, undefined);
    updateInventoryUI();
    flash(`Picked up ${held}.`, "ok");
    drawGridToScreenEdges();
    checkWin();
    return;
  }

  // Equal-merge crafting: place held onto same-valued cell => double
  if (held !== undefined && current !== undefined && current === held) {
    const newVal = held * 2;
    writeCell(id, newVal);
    held = undefined;
    updateInventoryUI();
    flash(`Crafted ${newVal}!`, "ok");
    drawGridToScreenEdges();
    checkWin();
    return;
  }

  // Otherwise no effect
  flash("Nothing happened.", "info");
}

// Boot
updateInventoryUI();
drawGridToScreenEdges();
// Locked zoom per sample; redraw on panning to keep edges filled
map.on("moveend", drawGridToScreenEdges);
