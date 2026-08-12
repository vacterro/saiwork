import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { formatQuotaCount } from "./format-quota"

describe("formatQuotaCount", () => {
  it("keeps integers clean", () => {
    assert.equal(formatQuotaCount(6), "6")
    assert.equal(formatQuotaCount(0), "0")
  })

  it("rounds float noise to two decimals", () => {
    assert.equal(formatQuotaCount(1.400000000000000000000000467), "1.4")
    assert.equal(formatQuotaCount(4.5999999999999996), "4.6")
    assert.equal(formatQuotaCount(0.1), "0.1")
  })

  it("handles non-finite values", () => {
    assert.equal(formatQuotaCount(Number.NaN), "0")
    assert.equal(formatQuotaCount(Number.POSITIVE_INFINITY), "0")
  })
})
