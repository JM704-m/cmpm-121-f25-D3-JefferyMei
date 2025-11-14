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

// Basic UI
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
  <div><strong>Goal:</strong> hold a token of value <span id="goalText">32</span></div>
  <div id="msg"></div>
`;
document.body.append(statusPanelDiv);

const invTextEl = statusPanelDiv.querySelector("#invText") as HTMLSpanElement;
const msgEl = statusPanelDiv.querySelector("#msg") as HTMLDivElement;
const goalTextEl = statusPanelDiv.querySelector("#goalText") as HTMLSpanElement;

// Fixed location of classroom
const CLASSROOM_LATLNG = leaflet.latLng(
  36.997936938057016,
  -122.05703507501151,
);

const GAMEPLAY_ZOOM_LEVEL = 19;
const TILE_DEGREES = 1e-4; // house-sized grid
const CACHE_SPAWN_PROBABILITY = 0.1; // deterministic spawn prob
const INTERACT_RANGE_STEPS = 5; // circle radius (in grid steps)
const WIN_VALUE = 32;

// approx meters/degree for circle visualization
const METERS_PER_DEG = 111_320;

// Map
const map = leaflet.map(mapDiv, {
  center: CLASSROOM_LATLNG,
  zoom: GAMEPLAY_ZOOM_LEVEL,
  minZoom: 16,
  maxZoom: 20,
  zoomControl: true,
  scrollWheelZoom: true,
});

leaflet
  .tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution:
      '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  })
  .addTo(map);

const playerMarker = leaflet
  .circleMarker(CLASSROOM_LATLNG, {
    radius: 6,
    color: "#1d4ed8",
    weight: 2,
    fillOpacity: 0.9,
  })
  .bindTooltip("You")
  .addTo(map);

type CellID = { i: number; j: number };

// Helpers
function cellKey(c: CellID): string {
  return `${c.i}:${c.j}`;
}

function latLngToCell(lat: number, lng: number): CellID {
  return {
    i: Math.floor(lat / TILE_DEGREES),
    j: Math.floor(lng / TILE_DEGREES),
  };
}

function cellToBounds(c: CellID): leaflet.LatLngBoundsLiteral {
  const south = c.i * TILE_DEGREES;
  const west = c.j * TILE_DEGREES;
  const north = (c.i + 1) * TILE_DEGREES;
  const east = (c.j + 1) * TILE_DEGREES;
  return [
    [south, west],
    [north, east],
  ];
}
// Returns geographic center of a cell as a tuple [lat, lng]
function cellCenter(c: CellID): leaflet.LatLngTuple {
  const b = cellToBounds(c);
  const lat = (b[0][0] + b[1][0]) / 2;
  const lng = (b[0][1] + b[1][1]) / 2;
  return [lat, lng];
}

// Converts cell id to a Leaflet LatLng object
function cellToLatLng(c: CellID): leaflet.LatLng {
  const [lat, lng] = cellCenter(c);
  return leaflet.latLng(lat, lng);
}

function euclidSteps(a: CellID, b: CellID): number {
  const dx = a.i - b.i;
  const dy = a.j - b.j;
  return Math.sqrt(dx * dx + dy * dy);
}

// World state
function initialTokenValue(c: CellID): number | undefined {
  const k = cellKey(c);
  if (luck(`${k}|spawn`) >= CACHE_SPAWN_PROBABILITY) return undefined;
  const r = luck(`${k}|value`);
  if (r < 0.25) return 1;
  if (r < 0.5) return 2;
  if (r < 0.75) return 4;
  return 8;
}
const modified = new Map<string, number | undefined>();
function readCell(c: CellID): number | undefined {
  const k = cellKey(c);
  if (modified.has(k)) return modified.get(k);
  return initialTokenValue(c);
}
function writeCell(c: CellID, v: number | undefined): void {
  modified.set(cellKey(c), v);
}

// Inventory & feedback
let held: number | undefined = undefined;

function updateInventoryUI(): void {
  goalTextEl.textContent = String(WIN_VALUE);
  invTextEl.textContent = held === undefined ? "Empty" : String(held);
}

function flash(msg: string, cls: "ok" | "err" | "info" = "info"): void {
  msgEl.className = cls;
  msgEl.textContent = msg;
  setTimeout(() => {
    if (msgEl.textContent === msg) msgEl.textContent = "";
  }, 1400);
}

function checkWin(): void {
  if (held !== undefined && held >= WIN_VALUE) {
    flash(`You win! Held token value = ${held}`, "ok");
  }
}

// Player movement
let playerCell: CellID = latLngToCell(
  CLASSROOM_LATLNG.lat,
  CLASSROOM_LATLNG.lng,
);

function movePlayer(di: number, dj: number): void {
  playerCell = { i: playerCell.i + di, j: playerCell.j + dj };
  const ll = cellToLatLng(playerCell);
  playerMarker.setLatLng(ll);
  map.panTo(ll, { animate: true });
  drawGridToScreenEdges();
}

function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.style.marginRight = "6px";
  btn.onclick = onClick;
  return btn;
}

controlPanelDiv.append(
  makeButton("⬆ N", () => movePlayer(1, 0)),
  makeButton("⬇ S", () => movePlayer(-1, 0)),
  makeButton("⬅ W", () => movePlayer(0, -1)),
  makeButton("➡ E", () => movePlayer(0, 1)),
);

// Layers & rendering
const gridLayer = leaflet.layerGroup().addTo(map);
const tokenTileLayer = leaflet.layerGroup().addTo(map);
const labelLayer = leaflet.layerGroup().addTo(map);
const rangeLayer = leaflet.layerGroup().addTo(map);

/** Draws a circular interaction range around the player. */
function drawRangeCircle(): void {
  rangeLayer.clearLayers();
  const radiusMeters = INTERACT_RANGE_STEPS * TILE_DEGREES * METERS_PER_DEG;
  leaflet
    .circle(cellToLatLng(playerCell), {
      radius: radiusMeters,
      color: "#22c55e",
      weight: 2,
      fillColor: "#22c55e",
      fillOpacity: 0.08,
    })
    .addTo(rangeLayer);
}

/**
 * Rebuilds the visible grid from scratch each time based on
 * deterministic values + the persistent modified map.
 */
function drawGridToScreenEdges(): void {
  gridLayer.clearLayers();
  tokenTileLayer.clearLayers();
  labelLayer.clearLayers();
  drawRangeCircle();

  const b = map.getBounds();
  const sw = b.getSouthWest();
  const ne = b.getNorthEast();

  const minC = latLngToCell(sw.lat, sw.lng);
  const maxC = latLngToCell(ne.lat, ne.lng);

  for (let i = minC.i - 1; i <= maxC.i + 1; i++) {
    for (let j = minC.j - 1; j <= maxC.j + 1; j++) {
      const id: CellID = { i, j };

      leaflet
        .rectangle(cellToBounds(id), {
          color: "#9ca3af",
          weight: 1,
          fillOpacity: 0.05,
        })
        .addTo(gridLayer);

      const val = readCell(id);
      if (val !== undefined) {
        leaflet
          .rectangle(cellToBounds(id), {
            color: "#f59e0b",
            fillColor: "#fcd34d",
            weight: 1,
            fillOpacity: 0.6,
          })
          .addTo(tokenTileLayer);

        leaflet
          .marker(cellCenter(id), {
            interactive: false,
            icon: leaflet.divIcon({
              className: "cellLabel",
              html:
                '<div style="font-weight:700;letter-spacing:.5px;text-shadow:0 1px 0 rgba(0,0,0,.15)">' +
                val +
                "</div>",
            }),
          })
          .addTo(labelLayer);
      }

      const clickableRect = leaflet
        .rectangle(cellToBounds(id), { weight: 0, fillOpacity: 0 })
        .addTo(gridLayer);

      clickableRect.on("click", () => {
        const canInteract = euclidSteps(id, playerCell) <= INTERACT_RANGE_STEPS;
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

  // Hand empty: pick up from a non-empty cell (cell clears)
  if (held === undefined) {
    if (current !== undefined) {
      held = current;
      writeCell(id, undefined);
      updateInventoryUI();
      flash(`Picked up ${held}.`, "ok");
      drawGridToScreenEdges();
      checkWin();
      return;
    }
    flash("Nothing happened.", "info");
    return;
  }

  // Holding v
  const v = held;

  // Place onto empty
  if (current === undefined) {
    writeCell(id, v);
    held = undefined;
    updateInventoryUI();
    flash(`Placed ${v}.`, "ok");
    drawGridToScreenEdges();
    return;
  }

  // Equal-value merge -> cell becomes 2v and the held token is consumed
  if (current === v) {
    writeCell(id, v * 2);
    held = undefined; // consume held
    updateInventoryUI();
    flash(`Merged to ${v * 2}!`, "ok");
    drawGridToScreenEdges();
    checkWin();
    return;
  }

  // Different values -> swap
  const w = current;
  writeCell(id, v);
  held = w;
  updateInventoryUI();
  flash(`Swapped: cell=${v}, holding=${w}.`, "ok");
  drawGridToScreenEdges();
}

// Boot
updateInventoryUI();
playerMarker.setLatLng(cellToLatLng(playerCell));
drawGridToScreenEdges();

map.on("moveend", drawGridToScreenEdges);
map.on("zoomend", drawGridToScreenEdges);
