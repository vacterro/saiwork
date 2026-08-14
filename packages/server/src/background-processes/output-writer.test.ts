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

async function statSize(outputPath: string): Promise<number> {
  return (await fs.stat(outputPath)).size
}

describe("BoundedOutputWriter", () => {
  it("rotates only after capBytes is exceeded, then retains the newest retainBytes", async (t) => {
    const dir = await tempDir(t)
    const outputPath = path.join(dir, "output.txt")
    const cap = 4096
    const retain = 2048
    const writer = new BoundedOutputWriter(outputPath, { capBytes: cap, retainBytes: retain })
    const chunk = Buffer.alloc(512, 0x61)

    for (let i = 0; i < 4; i += 1) {
      writer.enqueue(chunk)
      await writer.flush()
    }
    assert.equal(await statSize(outputPath), 2048, "size 2048 (retainBytes) must NOT rotate")
    assert.equal(writer.droppedBytes, 0)

    for (let i = 0; i < 2; i += 1) {
      writer.enqueue(chunk)
      await writer.flush()
    }
    assert.equal(await statSize(outputPath), 3072, "size 3072 (between retain and cap) must NOT rotate")
    assert.equal(writer.droppedBytes, 0)

    for (let i = 0; i < 2; i += 1) {
      writer.enqueue(chunk)
      await writer.flush()
    }
    assert.equal(await statSize(outputPath), 4096, "size 4096 (capBytes) must NOT rotate")
    assert.equal(writer.droppedBytes, 0)

    writer.enqueue(Buffer.alloc(1, 0x61))
    await writer.flush()
    assert.equal(await statSize(outputPath), 2048, "size 4097 (> capBytes) MUST rotate and retain 2048")
    assert.equal(writer.droppedBytes, 4097 - retain, "droppedBytes counts exactly the discarded head")

    const bytes = await fs.readFile(outputPath)
    const emitted = Buffer.concat([Buffer.alloc(4096, 0x61), Buffer.alloc(1, 0x61)])
    assert.ok(bytes.equals(emitted.subarray(emitted.length - bytes.length)), "retained tail is the newest bytes")
  })

  it("keeps the on-disk file within the cap and accounts every byte", async (t) => {
    const dir = await tempDir(t)
    const outputPath = path.join(dir, "output.txt")
    const cap = 4096
    const retain = 2048
    const writer = new BoundedOutputWriter(outputPath, { capBytes: cap, retainBytes: retain })

    const chunk = Buffer.alloc(512, 0x62)
    const emitted: Buffer[] = []
    for (let i = 0; i < 40; i += 1) {
      emitted.push(chunk)
      writer.enqueue(chunk)
    }
    await writer.close()

    const bytes = await fs.readFile(outputPath)
    const total = emitted.reduce((sum, part) => sum + part.length, 0)
    assert.ok(bytes.length <= cap, `disk size ${bytes.length} exceeds cap`)
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

    const chunk = Buffer.alloc(1024, 0x63)
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

  it("hostile 100 MiB emitter stays within the disk cap with exact accounting", { timeout: 60_000 }, async (t) => {
    const dir = await tempDir(t)
    const outputPath = path.join(dir, "hostile.txt")
    const cap = 512 * 1024
    const retain = 256 * 1024
    const writer = new BoundedOutputWriter(outputPath, { capBytes: cap, retainBytes: retain })

    const chunk = Buffer.alloc(64 * 1024, 0x64)
    const total = 100 * 1024 * 1024
    const chunkCount = total / chunk.length
    for (let i = 0; i < chunkCount; i += 1) {
      writer.enqueue(chunk)
    }
    await writer.close()

    const bytes = await fs.readFile(outputPath)
    assert.ok(bytes.length <= cap, `100 MiB emitter left ${bytes.length} bytes on disk, over the ${cap} cap`)
    assert.ok(bytes.length >= retain, "at least the retention floor must survive")
    assert.equal(writer.droppedBytes + bytes.length, total, "every emitted byte is either on disk or counted dropped")
    assert.equal(bytes[0], 0x64, "retained tail is the newest bytes")
    assert.equal(bytes[bytes.length - 1], 0x64)
  })
})
