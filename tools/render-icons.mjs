#!/usr/bin/env node
// Renders the Levora mark to PNG at the sizes the manifest asks for.
//
// No dependencies and no image library: the mark is three primitives, and PNG
// is a container around a zlib stream, which Node already has. Rasterising here
// rather than committing binaries means the icon has a source of truth that can
// be edited — assets/icon.svg and this file draw the same geometry.
//
// Run with `node tools/render-icons.mjs`.

import { deflateSync } from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4; // 16 samples per pixel; enough for edges this simple

// The mark, on a 128 grid: a smooth wave. That is all, and deliberately.
//
// Three attempts at saying more failed, and the reason is the same each time —
// 16 px is the size that matters, and it holds one idea:
//
//   Two wedges converging on a bar read as the common "collapse" glyph, and
//   said nothing about sound.
//   A waveform going from jagged to even cannot work at all: an even waveform
//   at constant amplitude is a rectangle, and "small variation" is invisible.
//   A wave flattened against a ceiling turns into a zigzag — clipped crests are
//   joined by near-straight diagonals, and the glyph reads as a letter.
//
// So the mark says "audio" and stops. Every element has to earn its place, and
// an element nobody can see at the size that counts has not earned it.
//
// Horizontal and continuous on purpose: Boostr's mark is six uneven vertical
// bars, the two extensions cannot run together, and they must not be confusable
// in a toolbar.
const PLATE = { size: 128, radius: 27, colour: [0x1c, 0x1c, 0x1e] };
const GLYPH = [0x5a, 0xc8, 0xfa];

const WAVE = {
  left: 20,
  right: 108,
  centre: 64,
  // Proportion, not taste: peak-to-peak has to stay well under the wavelength
  // or the slopes go near-vertical and the curve stops looking like a wave and
  // starts looking like handwriting. At 1.5 cycles across this width the
  // wavelength is about 59, so 19 of amplitude keeps the ratio near 0.6.
  cycles: 1.5,
  amplitude: 19,
  stroke: 7, // half-width
  samples: 240,
};

/** The curve, as a polyline. Sampled once and reused for every size. */
const CURVE = Array.from({ length: WAVE.samples + 1 }, (_, i) => {
  const t = i / WAVE.samples;
  const x = WAVE.left + (WAVE.right - WAVE.left) * t;
  return [x, WAVE.centre - WAVE.amplitude * Math.sin(2 * Math.PI * WAVE.cycles * t)];
});

const distanceToSegment = (x, y, [ax, ay], [bx, by]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const inRoundedRect = (x, y, { x: rx, y: ry, width, height, radius }) => {
  if (x < rx || y < ry || x > rx + width || y > ry + height) return false;
  const cx = Math.min(Math.max(x, rx + radius), rx + width - radius);
  const cy = Math.min(Math.max(y, ry + radius), ry + height - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
};

/**
 * Inside the stroked curve.
 *
 * The polyline is monotonic in x, so the nearest segments can be found by index
 * instead of by scanning all of them — which matters, because this runs once per
 * supersample of every pixel.
 */
function inWave(x, y) {
  const span = WAVE.right - WAVE.left;
  const centreIndex = Math.round(((x - WAVE.left) / span) * WAVE.samples);
  const from = Math.max(0, centreIndex - 6);
  const to = Math.min(CURVE.length - 2, centreIndex + 6);
  for (let i = from; i <= to; i += 1) {
    if (distanceToSegment(x, y, CURVE[i], CURVE[i + 1]) <= WAVE.stroke) return true;
  }
  return false;
}

/** Coverage of the plate and of the glyph at one point, on the 128 grid. */
function sample(x, y) {
  const onPlate = inRoundedRect(x, y, {
    x: 0,
    y: 0,
    width: PLATE.size,
    height: PLATE.size,
    radius: PLATE.radius,
  });
  if (!onPlate) return null;
  return inWave(x, y) ? GLYPH : PLATE.colour;
}

function render(size) {
  const scale = PLATE.size / size;
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / SUPERSAMPLE;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const colour = sample(
            (px + (sx + 0.5) * step) * scale,
            (py + (sy + 0.5) * step) * scale,
          );
          if (!colour) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          covered += 1;
        }
      }
      const offset = (py * size + px) * 4;
      const total = SUPERSAMPLE * SUPERSAMPLE;
      if (covered === 0) continue; // transparent outside the rounded plate
      // Premultiplied averaging would darken the rounded corners against a
      // light toolbar, so the colour is the mean of the covered samples only
      // and coverage becomes alpha.
      pixels[offset] = Math.round(r / covered);
      pixels[offset + 1] = Math.round(g / covered);
      pixels[offset + 2] = Math.round(b / covered);
      pixels[offset + 3] = Math.round((covered / total) * 255);
    }
  }
  return pixels;
}

// --- PNG -------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  // Every scanline gets filter type 0. These images are small and the shapes
  // are flat, so a smarter filter would save bytes nobody is counting.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// The same geometry as a stroked path, so the mark has an editable source
// rather than only a rasteriser.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <!-- Levora mark: a wave running into a ceiling and flattening against it.
       Reads as audio at 16 px; the flat tops read as "held" once there is room
       for them. Generated geometry lives in tools/render-icons.mjs; keep the two
       in step. -->
  <rect width="128" height="128" rx="${PLATE.radius}" fill="#1C1C1E"/>
  <polyline fill="none" stroke="#5AC8FA" stroke-width="${WAVE.stroke * 2}"
    stroke-linecap="round" stroke-linejoin="round"
    points="${CURVE.filter((_, i) => i % 4 === 0).map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")}"/>
</svg>
`;

await mkdir(path.join(root, "assets"), { recursive: true });
await writeFile(path.join(root, "assets", "icon.svg"), svg);
for (const size of SIZES) {
  const file = path.join(root, "src", "icons", `icon-${size}.png`);
  await writeFile(file, encodePng(size, render(size)));
  console.log(`rendered src/icons/icon-${size}.png`);
}
