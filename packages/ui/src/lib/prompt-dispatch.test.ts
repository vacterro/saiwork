import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { dispatchOrdinaryPrompt, shouldDrainPromptQueue } from "./prompt-dispatch.ts"

describe("prompt dispatch policy", () => {
  it("queues ordinary and SAIPEN messages when queue mode is on", async () => {
    const queued: string[] = []
    const sent: string[] = []
    const dispatch = (prompt: string) => dispatchOrdinaryPrompt({
      queueEnabled: true,
      instanceId: "instance",
      sessionId: "session",
      prompt,
      attachments: [],
      enqueue: async (_instanceId, _sessionId, text) => { queued.push(text); return { ok: true } },
      send: async (_instanceId, _sessionId, text) => { sent.push(text) },
    })

    assert.deepEqual(await dispatch("ordinary"), { result: "queued" })
    assert.deepEqual(await dispatch("hh"), { result: "queued" })
    assert.deepEqual(queued, ["ordinary", "hh"])
    assert.deepEqual(sent, [])
  })

  it("sends directly when queue mode is off", async () => {
    const queued: string[] = []
    const sent: string[] = []
    const result = await dispatchOrdinaryPrompt({
      queueEnabled: false,
      instanceId: "instance",
      sessionId: "new-session",
      prompt: "first session prompt",
      attachments: [],
      enqueue: async (_instanceId, _sessionId, text) => { queued.push(text); return { ok: true } },
      send: async (_instanceId, _sessionId, text) => { sent.push(text) },
    })

    assert.deepEqual(result, { result: "sent" })
    assert.deepEqual(queued, [])
    assert.deepEqual(sent, ["first session prompt"])
  })

  it("drains only an idle, unpaused queue that does not need input", () => {
    assert.equal(shouldDrainPromptQueue({ busy: false, needsInput: false, paused: false, pending: 1 }), true)
    assert.equal(shouldDrainPromptQueue({ busy: true, needsInput: false, paused: false, pending: 1 }), false)
    assert.equal(shouldDrainPromptQueue({ busy: false, needsInput: true, paused: false, pending: 1 }), false)
    assert.equal(shouldDrainPromptQueue({ busy: false, needsInput: false, paused: true, pending: 1 }), false)
    assert.equal(shouldDrainPromptQueue({ busy: false, needsInput: false, paused: false, pending: 0 }), false)
  })
})

describe("prompt dispatch refusal", () => {
  it("reports a refused enqueue instead of claiming the prompt was queued", async () => {
    const outcome = await dispatchOrdinaryPrompt({
      queueEnabled: true,
      instanceId: "instance",
      sessionId: "session",
      prompt: "too big",
      attachments: [],
      enqueue: async () => ({ ok: false, reason: "quota" }),
      send: async () => { throw new Error("send must not run when queueing") },
    })

    assert.deepEqual(outcome, { result: "rejected", reason: "quota" })
  })
})
