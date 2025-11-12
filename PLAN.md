D3: World of Bits
Game Design Vision

The player interacts with a fixed map around the classroom. Nearby grid cells can be clicked to collect or craft tokens of increasing value.

Technologies

TypeScript for main game logic

Leaflet for the map interface

Deno + Vite for build and deployment

Assignments
D3.a: Core mechanics

Steps：

Create map, control, and status panels

Center the map on the classroom location

Draw a visible grid of fixed-size cells

Show token values directly on each cell

Make cells clickable for interactions

Limit interactions to nearby cells

Implement inventory (hold one token at a time)

Add crafting (equal-value tokens combine → double value)

Detect win when holding a token of value 16

D3.b: Globe-spanning Gameplay

Key technical challenge: Keep the grid filled to the screen edges while the player moves; use a world-anchored grid (i/j based on lat/lng and fixed cell size).
Key gameplay challenge: Let players roam and repeatedly collect/merge to reach a higher target value.
Refine detail D3.a: Change the display of the area around the player to a circle.

Steps：

- Add movement buttons (N / S / W / E), 1 grid step per click

- Represent player position as a cell and keep a marker in sync

- Draw cells out to viewport edges as the map moves/zooms

- Show a circular interaction range (Euclidean), radius = 5 cells

- Only allow interactions inside the circle

- “Memoryless” cells: forget modified state when off-screen (session only)

- Render token tiles as yellow squares with centered numbers

- Deterministic spawning via (fallback hash)luck

- Inventory model: single slot (hold exactly one token)

- Interactions：

  - Pick up: remove token from cell into hand

  - Place: drop held token onto empty cell

  - Merge: if held value equals cell value → cell becomes double, held token consumed

  - Swap: if held value differs from cell value → exchange (cell gets held; hand takes cell)

- Win condition: target token value 32

- Cleanup and deployment verification (two successful runs)
