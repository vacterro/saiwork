/**
 * FreeBuff integration verification, run after a FreeBuff update/reinstall.
 *
 * Usage: node --import tsx scripts/verify-freebuff.ts
 * Optional: FREEBUFF_RUN_TURN=1 runs one real agent turn (consumes quota).
 *
 * Checks, in order:
 *   1. install located (tolerant of a renamed app directory)
 *   2. engine spawns and /api/auth/status answers
 *   3. account authed
 *   4. which catalog model ids the engine currently accepts (createThread probe,
 *      no quota consumed)
 *   5. closeThread releases the slot (open another thread after closing)
 *   6. optional: one real turn
 *
 * Exits non-zero on the first failed invariant. Safe to re-run.
 */
import { mkdirSync } from "node:fs"
import { FreebuffEngineManager } from "../src/freebuff/engine"
import { FreebuffController } from "../src/freebuff/controller"
import { createLogger } from "../src/logger"
import { locateFreebuffInstall } from "../src/freebuff/install"
import { FREEBUFF_MODELS } from "../src/freebuff/models"

const logger = createLogger({ component: "freebuff-verify" })
const workspace = "V:/_TEMP_/opencode/freebuff-verify"
mkdirSync(workspace, { recursive: true })

async function main() {
  const install = locateFreebuffInstall()
  if (!install) {
    console.error("FAIL: FreeBuff install not found. Check SAIWORK_FREEBUFF_HOME or reinstall FreeBuff desktop.")
    process.exit(1)
  }
  console.log(`OK  install: ${install.root}`)

  const engineManager = new FreebuffEngineManager({ logger })
  const controller = new FreebuffController({ engineManager, logger })
  try {
    const status = await controller.ensureRunning()
    if (!status.ready || !status.engineRunning) {
      console.error(`FAIL: engine did not start: ${status.error ?? "unknown"}`)
      process.exit(1)
    }
    console.log(`OK  engine: ready on port ${status.port}`)

    const client = controller.client()
    if (!client) throw new Error("no client after engine start")
    const auth = await client.authStatus()
    if (!auth.authed) {
      console.error("FAIL: not authenticated with FreeBuff. Sign in to FreeBuff desktop once.")
      process.exit(1)
    }
    console.log(`OK  auth: ${(auth.user as { email?: string } | undefined)?.email ?? "authed"}`)

    const accepted: string[] = []
    const rejected: string[] = []
    for (const model of FREEBUFF_MODELS) {
      try {
        const created = await client.createThread({ projectPath: workspace, harnessId: "codebuff", model: model.id })
        await client.closeThread(created.id)
        accepted.push(model.id)
        console.log(`OK  model ${model.id}: accepted`)
      } catch (error) {
        rejected.push(model.id)
        console.log(`WARN model ${model.id}: rejected (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    if (accepted.length === 0) {
      console.error("FAIL: no catalog model accepted by the engine")
      process.exit(1)
    }

    const slotCheck = await client.createThread({ projectPath: workspace, harnessId: "codebuff", model: accepted[0] })
    await client.closeThread(slotCheck.id)
    const reopened = await client.createThread({ projectPath: workspace, harnessId: "codebuff", model: accepted[0] })
    await client.closeThread(reopened.id)
    console.log("OK  slot: create->close->create succeeded (slot release works)")

    if (process.env.FREEBUFF_RUN_TURN === "1") {
      const turn = await client.createThread({ projectPath: workspace, harnessId: "codebuff", model: accepted[0] })
      const result = await client.postMessage(turn.id, "Reply with exactly: FREE_BUFF_OK and nothing else.")
      console.log(`OK  turn dispatched: ${JSON.stringify(result)}`)
      await client.closeThread(turn.id)
    } else {
      console.log("SKIP real turn (set FREEBUFF_RUN_TURN=1 to run one and burn quota)")
    }

    console.log("\nVERIFY PASS")
  } finally {
    await controller.stop()
  }
}

main().catch((error) => {
  console.error("VERIFY FAILED:", error)
  process.exit(1)
})
