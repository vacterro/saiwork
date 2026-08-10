import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { QUEUE_BODY_HEIGHT_PX, QUEUE_HINT_HEIGHT_PX, QUEUE_LIST_HEIGHT_PX, resolveQueueLayout } from "./prompt-queue-layout.ts"

const counts = [0, 1, 4, 20]

/**
 * The whole point of the fixed-height panel: the number of queued prompts must
 * never change how much vertical space the panel takes, because that space is
 * taken from the message list.
 */
describe("prompt queue layout", () => {
  it("never varies the height with the number of queued items", () => {
    for (const expanded of [false, true]) {
      const heights = new Set(
        counts.map((pending) => resolveQueueLayout({ expanded, pending }).bodyHeightPx),
      )
      assert.equal(heights.size, 1, `height varied with count while expanded=${expanded}`)
    }
  })

  it("collapsed renders the header strip only", () => {
    for (const pending of counts) {
      const layout = resolveQueueLayout({ expanded: false, pending })
      assert.equal(layout.state, "collapsed")
      assert.equal(layout.bodyHeightPx, 0)
    }
  })

  it("expanded reserves a fixed body height for any count", () => {
    for (const pending of counts) {
      const layout = resolveQueueLayout({ expanded: true, pending })
      assert.equal(layout.state, "expanded")
      assert.equal(layout.bodyHeightPx, QUEUE_BODY_HEIGHT_PX)
    }
  })

  it("collapsed never expands by itself", () => {
    const layout = resolveQueueLayout({ expanded: false, pending: 20 })
    assert.equal(layout.state, "collapsed", "a queue full of entries must not force the panel open")
  })

  it("reserves exactly the list height plus the hint slot", () => {
    assert.equal(
      QUEUE_BODY_HEIGHT_PX,
      QUEUE_LIST_HEIGHT_PX + QUEUE_HINT_HEIGHT_PX,
      "the expanded body must be exactly the fixed list plus the fixed hint slot",
    )
  })
})
