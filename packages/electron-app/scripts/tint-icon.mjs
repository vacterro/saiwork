#!/usr/bin/env node
/**
 * Tints a white-on-alpha mark to the Vintage Golden palette.
 *
 * The SAIPEN artwork ships as white on transparent so it can be recoloured per
 * product. SAIWORK has exactly one palette, so the tint is fixed here rather
 * than passed in: an icon that drifts from the interface it belongs to is the
 * same failure as a stray hex value in a stylesheet.
 *
 * Usage:
 *   node scripts/tint-icon.mjs <input.png> <output.png> [alpha|plate]
 *
 *   plate (default) flattens onto --background, for app icons that must not
 *   carry partial transparency into the .ico/.icns encoders.
 *   alpha keeps transparency, for placing the mark on another surface.
 */
import { readFileSync, writeFileSync } from "fs"
import { PNG } from "pngjs"

const [, , inputPath, outputPath, modeArg] = process.argv
if (!inputPath || !outputPath) {
  console.error("usage: node scripts/tint-icon.mjs <input.png> <output.png> [alpha|plate]")
  process.exit(1)
}

const mode = modeArg === "alpha" ? "alpha" : "plate"

const MARK = { r: 0xf0, g: 0xc0, b: 0x8a }
const PLATE = { r: 0x34, g: 0x20, b: 0x12 }

const png = PNG.sync.read(readFileSync(inputPath))
const { width, height, data } = png

for (let i = 0; i < data.length; i += 4) {
  const alpha = data[i + 3]

  if (alpha === 0) {
    if (mode === "plate") {
      data[i] = PLATE.r
      data[i + 1] = PLATE.g
      data[i + 2] = PLATE.b
      data[i + 3] = 255
    }
    continue
  }

  if (mode === "alpha") {
    data[i] = MARK.r
    data[i + 1] = MARK.g
    data[i + 2] = MARK.b
    continue
  }

  const a = alpha / 255
  data[i] = Math.round(MARK.r * a + PLATE.r * (1 - a))
  data[i + 1] = Math.round(MARK.g * a + PLATE.g * (1 - a))
  data[i + 2] = Math.round(MARK.b * a + PLATE.b * (1 - a))
  data[i + 3] = 255
}

writeFileSync(outputPath, PNG.sync.write(png))
console.log(`wrote ${outputPath} (${width}x${height}, mode=${mode})`)
