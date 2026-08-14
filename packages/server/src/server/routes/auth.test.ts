import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { it } from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { AuthManager } from "../../auth/manager"
import { hashPassword } from "../../auth/password-hash"
import type { SessionManagerOptions } from "../../auth/session-manager"
import { registerAuthRoutes } from "./auth"

it("renders the escaped default username literally as the login field value", async () => {
  const app = Fastify({ logger: false })
  const username = " code$&\"nomad "
  const authManager = {
    getSessionFromRequest: () => null,
    getStatus: () => ({ username }),
  } as unknown as AuthManager
  registerAuthRoutes(app, { authManager })

  const response = await app.inject({ method: "GET", url: "/login" })

  assert.equal(response.statusCode, 200)
  assert.ok(response.body.includes('value=" code$&amp;&quot;nomad "'))
  assert.match(response.body, /const username = \$\("username"\)\.value\s*\n/)
  assert.equal(response.body.match(/autocapitalize="none"/g)?.length, 2)
  assert.equal(response.body.match(/autocorrect="off"/g)?.length, 2)
  assert.equal(response.body.match(/spellcheck="false"/g)?.length, 2)
  assert.match(response.body, /<form id="login" class="card">/)
  assert.match(response.body, /<button id="submit" type="submit">Continue<\/button>/)
  assert.match(response.body, /--background: #1A1810;/)
  assert.match(response.body, /border-radius: 0 !important;/)
  assert.doesNotMatch(response.body, /#4c6fff|rgba\(/i)
  await app.close()
})

it("revokes the presented server-side session on logout", async () => {
  const harness = createAuthHarness()
  try {
    const login = await loginWithPassword(harness.app, "old-password")
    const copiedCookie = getCookie(login.headers["set-cookie"])

    const before = await harness.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie: copiedCookie } })
    assert.deepEqual(before.json(), { authenticated: true, username: "saiwork", passwordUserProvided: true })

    const logout = await harness.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: copiedCookie },
    })
    assert.equal(logout.statusCode, 200)
    assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/)

    const replay = await harness.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie: copiedCookie } })
    assert.deepEqual(replay.json(), { authenticated: false })
  } finally {
    await harness.close()
  }
})

it("rejects a copied cookie after idle expiry", async () => {
  let now = 10_000
  const harness = createAuthHarness({
    idleTtlMs: 50,
    absoluteTtlMs: 500,
    now: () => now,
  })
  try {
    const login = await loginWithPassword(harness.app, "old-password")
    const copiedCookie = getCookie(login.headers["set-cookie"])

    now += 49
    const active = await harness.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie: copiedCookie } })
    assert.equal(active.json().authenticated, true)

    now += 50
    const expired = await harness.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie: copiedCookie } })
    assert.deepEqual(expired.json(), { authenticated: false })
  } finally {
    await harness.close()
  }
})

it("bounds repeated logins and logout leaves no reusable cookie", async () => {
  let nextId = 0
  const harness = createAuthHarness({
    maxSessions: 3,
    createId: () => `route-session-${++nextId}`,
  })
  try {
    const cookies: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const login = await loginWithPassword(harness.app, "old-password")
      cookies.push(getCookie(login.headers["set-cookie"]))
    }

    for (const cookie of cookies.slice(0, 2)) {
      const evicted = await harness.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } })
      assert.deepEqual(evicted.json(), { authenticated: false })
    }
    for (const cookie of cookies.slice(2)) {
      const retained = await harness.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } })
      assert.equal(retained.json().authenticated, true)
    }

    for (let index = 0; index < 20; index += 1) {
      const login = await loginWithPassword(harness.app, "old-password")
      const cookie = getCookie(login.headers["set-cookie"])
      await harness.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })
      const replay = await harness.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } })
      assert.equal(replay.json().authenticated, false)
    }
  } finally {
    await harness.close()
  }
})

it("password rotation revokes every old session and replaces only the caller session", async () => {
  const harness = createAuthHarness()
  try {
    const firstLogin = await loginWithPassword(harness.app, "old-password")
    const secondLogin = await loginWithPassword(harness.app, "old-password")
    const firstCookie = getCookie(firstLogin.headers["set-cookie"])
    const secondCookie = getCookie(secondLogin.headers["set-cookie"])

    const rotated = await harness.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie: firstCookie },
      payload: { password: "new-password" },
    })
    assert.equal(rotated.statusCode, 200)
    assert.deepEqual(rotated.json(), {
      ok: true,
      username: "saiwork",
      passwordUserProvided: true,
    })
    const replacementCookie = getCookie(rotated.headers["set-cookie"])
    assert.notEqual(replacementCookie, firstCookie)

    for (const cookie of [firstCookie, secondCookie]) {
      const oldSession = await harness.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } })
      assert.deepEqual(oldSession.json(), { authenticated: false })
    }
    const replacement = await harness.app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie: replacementCookie },
    })
    assert.equal(replacement.json().authenticated, true)

    assert.equal((await loginWithPassword(harness.app, "old-password")).statusCode, 401)
    assert.equal((await loginWithPassword(harness.app, "new-password")).statusCode, 200)
  } finally {
    await harness.close()
  }
})

function createAuthHarness(sessionOptions?: SessionManagerOptions) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-auth-test-"))
  const authFile = {
    version: 1 as const,
    username: "saiwork",
    password: hashPassword("old-password"),
    userProvided: true,
    updatedAt: new Date(0).toISOString(),
  }
  fs.writeFileSync(path.join(directory, "auth.json"), JSON.stringify(authFile), "utf-8")

  const authManager = new AuthManager(
    {
      configPath: path.join(directory, "config.yaml"),
      username: "saiwork",
      generateToken: false,
      sessionOptions,
    },
    pino({ level: "silent" }),
  )
  const app = Fastify({ logger: false })
  registerAuthRoutes(app, { authManager })

  return {
    app,
    async close() {
      await app.close()
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

function loginWithPassword(app: ReturnType<typeof Fastify>, password: string) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "saiwork", password },
  })
}

function getCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header
  assert.ok(value)
  return value.split(";", 1)[0]
}
