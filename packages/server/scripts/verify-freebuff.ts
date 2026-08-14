/**
 * FreeBuff integration verification, run after a FreeBuff update/reinstall.
 *
 * Usage: node --import tsx scripts/verify-freebuff.ts
 * Optional: FREEBUFF_RUN_TURN=1 runs one real agent turn (consumes quota).
 *
 * Checks, in order:
 *   1. install located (tolerant of a renamed app directory)
 *   2. concurrent starts converge on one launch-bound ready engine
 *   3. account authed
 *   4. which catalog model ids the engine currently accepts (createThread probe,
 *      no quota consumed)
 *   5. closeThread releases the slot (open another thread after closing)
 *   6. optional: one completed real turn (consumes quota)
 *   7. graceful close followed by a fresh SAIWORK-managed restart
 *
 * Exits non-zero on the first failed invariant. Safe to re-run.
 */
import { mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { FreebuffEngineManager } from "../src/freebuff/engine"
import { FreebuffController } from "../src/freebuff/controller"
import { createLogger } from "../src/logger"
import { locateFreebuffInstall } from "../src/freebuff/install"
import { FREEBUFF_MODELS, freebuffMaxReasoningEffort } from "../src/freebuff/models"
import { runFreebuffTurn } from "../src/freebuff/gateway"

const logger = createLogger({ component: "freebuff-verify" })
const workspace = path.join(os.tmpdir(), "saiwork-freebuff-verify")
mkdirSync(workspace, { recursive: true })

async function main() {
  const install = locateFreebuffInstall()
  if (!install) {
    throw new Error("FreeBuff install not found. Check SAIWORK_FREEBUFF_HOME or reinstall FreeBuff Desktop.")
  }
  console.log(`OK  install: ${install.root} (Desktop ${install.version ?? "unverified"})`)

  const engineManager = new FreebuffEngineManager({ logger })
  const controller = new FreebuffController({ engineManager, logger })
  try {
    const starts = await Promise.all([
      controller.ensureRunning(),
      controller.ensureRunning(),
      controller.ensureRunning(),
    ])
    const status = starts[0]
    if (!status.ready || !status.engineRunning) {
      throw new Error(`engine did not start: ${status.error ?? "unknown"}`)
    }
    if (!starts.every((entry) => entry.port === status.port && entry.ready)) {
      throw new Error("concurrent engine starts did not converge on one ready port")
    }
    console.log(`OK  engine: concurrent start converged on port ${status.port}`)

    const client = controller.client()
    if (!client) throw new Error("no client after engine start")
    const auth = await client.authStatus()
    if (!auth.authed) {
      throw new Error("not authenticated with FreeBuff; sign in to FreeBuff Desktop once")
    }
    console.log(`OK  auth: ${(auth.user as { email?: string } | undefined)?.email ?? "authed"}`)

    const accepted: string[] = []
    const rejected: string[] = []
    for (const model of FREEBUFF_MODELS) {
      try {
        const created = await client.createThread({
          projectPath: workspace,
          harnessId: "codebuff",
          model: model.id,
          reasoningEffort: freebuffMaxReasoningEffort(model.id),
        })
        await client.closeThread(created.id)
        accepted.push(model.id)
        console.log(`OK  model ${model.id}: accepted (effort ${freebuffMaxReasoningEffort(model.id)})`)
      } catch (error) {
        rejected.push(model.id)
        console.log(`WARN model ${model.id}: rejected (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    if (accepted.length === 0) {
      throw new Error("no catalog model accepted by the engine")
    }

    const slotCheck = await client.createThread({ projectPath: workspace, harnessId: "codebuff", model: accepted[0] })
    await client.closeThread(slotCheck.id)
    const reopened = await client.createThread({ projectPath: workspace, harnessId: "codebuff", model: accepted[0] })
    await client.closeThread(reopened.id)
    console.log("OK  slot: create->close->create succeeded (slot release works)")

    if (process.env.FREEBUFF_RUN_TURN === "1") {
      const turn = await client.createThread({ projectPath: workspace, harnessId: "codebuff", model: accepted[0] })
      try {
        const answer = await runFreebuffTurn(
          client,
          turn.id,
          "Reply with exactly: FREE_BUFF_OK and nothing else.",
          () => {},
          { timeoutMs: 10 * 60 * 1000 },
        )
        if (answer.trim() !== "FREE_BUFF_OK") throw new Error(`unexpected turn answer: ${JSON.stringify(answer)}`)
        console.log("OK  turn: completed with FREE_BUFF_OK")
      } finally {
        await client.closeThread(turn.id).catch(() => undefined)
      }
    } else {
      console.log("SKIP real turn (set FREEBUFF_RUN_TURN=1 to run one and burn quota)")
    }

    await controller.stop()
    const restarted = await controller.ensureRunning()
    if (!restarted.ready || !restarted.engineRunning) {
      throw new Error(`SAIWORK restart failed: ${restarted.error ?? "unknown"}`)
    }
    const restartedClient = controller.client()
    if (!restartedClient || !(await restartedClient.authStatus()).authed) {
      throw new Error("restarted engine lost the authenticated Desktop session")
    }
    console.log(`OK  restart: new managed launch ready on port ${restarted.port}`)

    console.log("\nVERIFY PASS")
  } finally {
    await controller.stop()
  }
}

main().catch((error) => {
  console.error("VERIFY FAILED:", error)
  process.exitCode = 1
})
