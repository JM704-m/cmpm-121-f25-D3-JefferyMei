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

type LuckFn = (key: string) => number;

/** Try to find a luck-like function exported from _luck.ts. */
function resolveLuck(mod: Record<string, unknown>): LuckFn | null {
  const candidateNames = [
    "luck",
    "Luck",
    "random",
    "rng",
    "hash",
    "default",
  ] as const;
  for (const name of candidateNames) {
    const value = mod[name];
    if (typeof value === "function") {
      return value as (key: string) => number;
    }
  }
  return null;
}

/** Deterministic RNG used everywhere in the world. */
const luck: LuckFn = resolveLuck(LUCK_LIB as Record<string, unknown>) ??
  hash01;

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
const goalTextEl = statusPanelDiv.querySelector(
  "#goalText",
) as HTMLSpanElement;
const msgEl = statusPanelDiv.querySelector("#msg") as HTMLDivElement;

// New game button
const newGameButton = document.createElement("button");
newGameButton.textContent = "New Game";
newGameButton.style.marginTop = "6px";
statusPanelDiv.append(newGameButton);

// Tunable world parameters
/** Classroom location used as default center. */
const CLASSROOM_LATLNG = leaflet.latLng(
  36.997936938057016,
  -122.05703507501151,
);

const GAMEPLAY_ZOOM_LEVEL = 19;
const TILE_DEGREES = 1e-4; // ~ house-sized grid cells
const CACHE_SPAWN_PROBABILITY = 0.1;
const INTERACT_RANGE_STEPS = 5;
const METERS_PER_DEG = 111_320;
const WIN_VALUE = 32;
const STORAGE_KEY = "cmpm121-d3-world-of-bits";

// Movement modes for the facade
type MovementMode = "buttons" | "geolocation";

// Map and basic geometry helpers
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

/** Cell center as [lat, lng] tuple. */
function cellCenter(c: CellID): leaflet.LatLngTuple {
  const b = cellToBounds(c);
  const lat = (b[0][0] + b[1][0]) / 2;
  const lng = (b[0][1] + b[1][1]) / 2;
  return [lat, lng];
}

/** Cell center as Leaflet LatLng. */
function cellToLatLng(c: CellID): leaflet.LatLng {
  const [lat, lng] = cellCenter(c);
  return leaflet.latLng(lat, lng);
}

function euclidSteps(a: CellID, b: CellID): number {
  const dx = a.i - b.i;
  const dy = a.j - b.j;
  return Math.sqrt(dx * dx + dy * dy);
}

// World state: deterministic initial values + persistent modified cells
/** Initial token value; undefined means empty. */
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

/** Read current cell value, considering persistent modifications. */
function readCell(c: CellID): number | undefined {
  const k = cellKey(c);
  if (modified.has(k)) return modified.get(k);
  return initialTokenValue(c);
}

/** Persist new cell value. */
function writeCell(c: CellID, v: number | undefined): void {
  modified.set(cellKey(c), v);
}

// Inventory and messaging (single-slot inventory)
let held: number | undefined = undefined;

function updateInventoryUI(): void {
  invTextEl.textContent = held === undefined ? "Empty" : String(held);
  goalTextEl.textContent = String(WIN_VALUE);
}

function flash(msg: string, cls: "ok" | "err" | "info" = "info"): void {
  msgEl.className = cls;
  msgEl.textContent = msg;
  setTimeout(() => {
    if (msgEl.textContent === msg) msgEl.textContent = "";
  }, 1500);
}

function checkWin(): void {
  if (held !== undefined && held >= WIN_VALUE) {
    flash(`You win! Held token value = ${held}`, "ok");
  }
}

// Movement facade (buttons vs geolocation) — D3.d core
let playerCell: CellID = latLngToCell(
  CLASSROOM_LATLNG.lat,
  CLASSROOM_LATLNG.lng,
);
let movementMode: MovementMode = "buttons";
let geoWatchId: number | null = null;

/** Move the character to a given cell and update map + marker. */
function setPlayerCell(newCell: CellID): void {
  playerCell = newCell;
  const ll = cellToLatLng(playerCell);
  playerMarker.setLatLng(ll);
  map.panTo(ll, { animate: true });
  drawGridToScreenEdges();
  saveGameState();
}

/** Move by grid steps (used only when in button mode). */
function movePlayerBySteps(di: number, dj: number): void {
  setPlayerCell({ i: playerCell.i + di, j: playerCell.j + dj });
}

/** Small helper to create control buttons. */
function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.style.marginRight = "6px";
  btn.onclick = onClick;
  return btn;
}

// Arrow buttons for button-based movement
const northButton = makeButton("⬆ N", () => movePlayerBySteps(1, 0));
const southButton = makeButton("⬇ S", () => movePlayerBySteps(-1, 0));
const westButton = makeButton("⬅ W", () => movePlayerBySteps(0, -1));
const eastButton = makeButton("➡ E", () => movePlayerBySteps(0, 1));

// Toggle between buttons and geolocation
const movementToggleButton = makeButton("Use GPS", () => {
  const nextMode: MovementMode = movementMode === "buttons"
    ? "geolocation"
    : "buttons";
  setMovementMode(nextMode);
});

// Attach controls
controlPanelDiv.append(
  northButton,
  southButton,
  westButton,
  eastButton,
  movementToggleButton,
);

/** Start geolocation-based movement (real-time tracking). */
function startGeolocation(): void {
  if (!navigator.geolocation) {
    flash("Geolocation API not available.", "err");
    return;
  }
  if (geoWatchId !== null) return;

  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const newLatLng = leaflet.latLng(lat, lng);

      // FIX START

      // Update logic: Calculate the grid cell based on GPS, but don't snap the visual marker to it yet.
      playerCell = latLngToCell(lat, lng);

      // Visual update: Move the marker to the EXACT GPS location for smooth movement.
      playerMarker.setLatLng(newLatLng);

      // Visual update: Center the map on the player's real location.
      map.panTo(newLatLng);

      // Save state and redraw the grid
      saveGameState();
      drawGridToScreenEdges();

      // FIX END
    },
    (err) => {
      flash("Unable to read geolocation.", "err");
      console.error(err);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 5000,
    },
  );
}

/** Stop geolocation tracking. */
function stopGeolocation(): void {
  if (geoWatchId !== null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
}

/**
 * Facade entry point: the rest of the game only calls this to change
 * movement mode. Implementation details (buttons vs GPS) are hidden
 * behind this function.
 */
function setMovementMode(mode: MovementMode): void {
  if (movementMode === mode) return;

  // Tear down previous implementation
  if (movementMode === "geolocation") {
    stopGeolocation();
  }

  movementMode = mode;

  const usingButtons = movementMode === "buttons";
  northButton.disabled = !usingButtons;
  southButton.disabled = !usingButtons;
  westButton.disabled = !usingButtons;
  eastButton.disabled = !usingButtons;
  movementToggleButton.textContent = usingButtons ? "Use GPS" : "Use Buttons";

  if (movementMode === "geolocation") {
    startGeolocation();
  }

  saveGameState();
}

// Rendering layers
const gridLayer = leaflet.layerGroup().addTo(map);
const tokenTileLayer = leaflet.layerGroup().addTo(map);
const labelLayer = leaflet.layerGroup().addTo(map);
const rangeLayer = leaflet.layerGroup().addTo(map);

/** Draw circular interaction radius around the player. */
function drawRangeCircle(): void {
  rangeLayer.clearLayers();
  const radiusMeters = INTERACT_RANGE_STEPS * TILE_DEGREES * METERS_PER_DEG;

  leaflet
    .circle(playerMarker.getLatLng(), {
      radius: radiusMeters,
      color: "#22c55e",
      weight: 2,
      fillColor: "#22c55e",
      fillOpacity: 0.08,
    })
    .addTo(rangeLayer);
}

/** Rebuild the visible grid and tokens from world state. */
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

// Interaction rules (single-slot inventory + crafting)
function handleCellClick(id: CellID): void {
  const current = readCell(id);

  if (held === undefined) {
    if (current !== undefined) {
      held = current;
      writeCell(id, undefined);
      updateInventoryUI();
      flash(`Picked up ${held}.`, "ok");
      drawGridToScreenEdges();
      saveGameState();
      checkWin();
      return;
    }
    flash("Nothing happened.", "info");
    return;
  }

  const v = held;

  if (current === undefined) {
    writeCell(id, v);
    held = undefined;
    updateInventoryUI();
    flash(`Placed ${v}.`, "ok");
    drawGridToScreenEdges();
    saveGameState();
    return;
  }

  if (current === v) {
    writeCell(id, v * 2);
    held = undefined;
    updateInventoryUI();
    flash(`Merged to ${v * 2}!`, "ok");
    drawGridToScreenEdges();
    saveGameState();
    checkWin();
    return;
  }

  const w = current;
  writeCell(id, v);
  held = w;
  updateInventoryUI();
  flash(`Swapped: cell=${v}, holding=${w}.`, "ok");
  drawGridToScreenEdges();
  saveGameState();
}

// localStorage persistence
type SavedState = {
  playerCell: CellID;
  held: number | null;
  modified: Record<string, number | null>;
  movementMode: MovementMode;
};

function saveGameState(): void {
  const obj: SavedState = {
    playerCell,
    held: held ?? null,
    movementMode,
    modified: Object.fromEntries(
      Array.from(modified.entries()).map(([k, v]) => [k, v ?? null]),
    ),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // Ignore storage errors (e.g. private mode).
  }
}

function loadGameState(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as SavedState;

    if (
      parsed.playerCell &&
      typeof parsed.playerCell.i === "number" &&
      typeof parsed.playerCell.j === "number"
    ) {
      playerCell = { i: parsed.playerCell.i, j: parsed.playerCell.j };
    }

    held = parsed.held ?? undefined;

    modified.clear();
    if (parsed.modified) {
      for (const [k, v] of Object.entries(parsed.modified)) {
        modified.set(k, v ?? undefined);
      }
    }

    movementMode = parsed.movementMode === "geolocation"
      ? "geolocation"
      : "buttons";
  } catch {
    // Ignore malformed state.
  }
}

/** Clear all progress and restart at the classroom location. */
function resetGameState(): void {
  modified.clear();
  held = undefined;
  playerCell = latLngToCell(CLASSROOM_LATLNG.lat, CLASSROOM_LATLNG.lng);
  movementMode = "buttons";
  saveGameState();
  updateInventoryUI();
  setPlayerCell(playerCell);
  setMovementMode("buttons");
  flash("Started a new game.", "info");
}

// Boot sequence
// Load persisted state before first draw
loadGameState();
updateInventoryUI();
setPlayerCell(playerCell);
setMovementMode(movementMode);

// Redraw on map movement / zoom
map.on("moveend", drawGridToScreenEdges);
map.on("zoomend", drawGridToScreenEdges);

// New game button
newGameButton.onclick = () => {
  resetGameState();
};
