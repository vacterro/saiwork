import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import { BoundedOutputWriter } from "./output-writer"

async function tempDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-output-writer-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

describe("BoundedOutputWriter", () => {
  it("keeps the on-disk file within the cap and retains the newest bytes", async (t) => {
    const dir = await tempDir(t)
    const outputPath = path.join(dir, "output.txt")
    const cap = 4096
    const retain = 2048
    const writer = new BoundedOutputWriter(outputPath, { capBytes: cap, retainBytes: retain })

    const chunk = Buffer.alloc(512, 0x61)
    const emitted: Buffer[] = []
    for (let i = 0; i < 40; i += 1) {
      emitted.push(chunk)
      writer.enqueue(chunk)
    }
    await writer.close()

    const bytes = await fs.readFile(outputPath)
    const total = emitted.reduce((sum, part) => sum + part.length, 0)
    assert.ok(bytes.length <= cap, `disk size ${bytes.length} exceeds cap`)
    assert.ok(bytes.length >= retain, `retained ${bytes.length} below retention floor`)
    assert.ok(writer.droppedBytes > 0)
    assert.equal(writer.droppedBytes + bytes.length, total)
    assert.ok(bytes.equals(Buffer.concat(emitted).subarray(total - bytes.length)))
  })

  it("bounds the in-memory pending queue and accounts every byte", async (t) => {
    const dir = await tempDir(t)
    const outputPath = path.join(dir, "output.txt")
    const writer = new BoundedOutputWriter(outputPath, {
      capBytes: 4096,
      retainBytes: 2048,
      queueLimitBytes: 2048,
    })

    const chunk = Buffer.alloc(1024, 0x62)
    for (let i = 0; i < 20; i += 1) {
      writer.enqueue(chunk)
    }
    await writer.close()

    const bytes = await fs.readFile(outputPath)
    assert.ok(bytes.length <= 4096)
    assert.ok(writer.droppedBytes > 0)
    assert.equal(writer.droppedBytes + bytes.length, 20 * 1024)
  })

  it("flushes everything when within the cap", async (t) => {
    const dir = await tempDir(t)
    const outputPath = path.join(dir, "output.txt")
    const writer = new BoundedOutputWriter(outputPath, { capBytes: 4096, retainBytes: 2048 })

    const data = Buffer.from("0123456789")
    writer.enqueue(data)
    writer.enqueue(data)
    await writer.close()

    const bytes = await fs.readFile(outputPath)
    assert.equal(bytes.toString(), "01234567890123456789")
    assert.equal(writer.droppedBytes, 0)
  })

  it("counts writes after close as dropped and leaves the file unchanged", async (t) => {
    const dir = await tempDir(t)
    const outputPath = path.join(dir, "output.txt")
    const writer = new BoundedOutputWriter(outputPath, {})

    writer.enqueue(Buffer.from("hello"))
    await writer.close()
    const before = writer.droppedBytes
    writer.enqueue(Buffer.from("world"))

    assert.equal(writer.droppedBytes, before + 5)
    const bytes = await fs.readFile(outputPath)
    assert.equal(bytes.toString(), "hello")
  })

  it("surfaces write failures through onError and rejects further writes", async (t) => {
    const dir = await tempDir(t)
    const outputPath = path.join(dir, "does-not-exist-dir", "output.txt")
    const errors: unknown[] = []
    const writer = new BoundedOutputWriter(outputPath, { onError: (error) => errors.push(error) })

    writer.enqueue(Buffer.from("boom"))
    await writer.close()

    assert.equal(errors.length, 1)
  })
})
