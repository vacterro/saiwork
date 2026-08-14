import { connect } from "net"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import type { SettingsService } from "../settings/service"
import type { SideCar, SideCarKind, SideCarPrefixMode, SideCarStatus } from "../api-types"

interface SideCarManagerOptions {
  settings: SettingsService
  eventBus: EventBus
  logger: Logger
}

interface SideCarConfigRecord {
  id: string
  kind: SideCarKind
  name: string
  port: number
  insecure: boolean
  prefixMode: SideCarPrefixMode
  createdAt: string
  updatedAt: string
}

interface SideCarRuntimeRecord {
  status: SideCarStatus
}

/** Raised when persisted `server.sidecars` is structurally invalid. Fail-closed:
 * the manager refuses to construct runtime state from corrupt bytes and blocks
 * every mutation so the corruption can never be silently overwritten. */
export class SideCarConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SideCarConfigError"
  }
}

export class SideCarManager {
  private readonly configs = new Map<string, SideCarConfigRecord>()
  private readonly runtime = new Map<string, SideCarRuntimeRecord>()
  private readonly configError: SideCarConfigError | null

  constructor(private readonly options: SideCarManagerOptions) {
    try {
      for (const record of this.loadConfiguredSideCars()) {
        this.configs.set(record.id, record)
        this.runtime.set(record.id, { status: "stopped" })
      }
      this.configError = null
    } catch (error) {
      this.configError = error instanceof SideCarConfigError ? error : new SideCarConfigError(String(error))
    }

    queueMicrotask(() => {
      for (const record of this.configs.values()) {
        void this.refreshPortSideCar(record.id).catch((error) => {
          this.options.logger.warn({ sidecarId: record.id, err: error }, "Failed to probe sidecar port")
        })
      }
    })
  }

  private assertOperational(): void {
    if (this.configError) throw this.configError
  }

  async list(): Promise<SideCar[]> {
    this.assertOperational()
    await this.refreshPortStatuses()
    return Array.from(this.configs.values()).map((record) => this.toSideCar(record))
  }

  async get(id: string): Promise<SideCar | undefined> {
    this.assertOperational()
    if (!this.configs.has(id)) return undefined
    await this.refreshPortSideCar(id)
    return this.toSideCar(this.requireConfig(id))
  }

  async create(input: {
    kind: SideCarKind
    name: string
    port: number
    insecure: boolean
    prefixMode: SideCarPrefixMode
  }): Promise<SideCar> {
    this.assertOperational()
    const normalizedName = input.name.trim()
    const id = this.buildSideCarId(normalizedName)
    if (this.configs.has(id)) {
      throw new Error(`SideCar '${id}' already exists`)
    }

    const now = new Date().toISOString()
    const record: SideCarConfigRecord = {
      id,
      kind: input.kind,
      name: normalizedName,
      port: input.port,
      insecure: input.insecure,
      prefixMode: input.prefixMode,
      createdAt: now,
      updatedAt: now,
    }

    // Transactional: persist the tentative list FIRST. Only after the durable
    // write succeeds do we commit the in-memory record, so a persistence
    // failure leaves memory and disk agreeing (neither contains the record).
    this.persistTentative([...this.configs.values(), record])
    this.configs.set(record.id, record)
    this.runtime.set(record.id, { status: "stopped" })
    await this.refreshPortSideCar(record.id)
    return this.toSideCar(record)
  }

  async update(
    id: string,
    input: Partial<{
      name: string
      port: number
      insecure: boolean
      prefixMode: SideCarPrefixMode
    }>,
  ): Promise<SideCar> {
    this.assertOperational()
    const current = this.requireConfig(id)
    // Clone instead of mutating the live record: the tentative version is what
    // gets persisted, and memory only adopts it after the write succeeds.
    const updated: SideCarConfigRecord = {
      ...current,
      name: typeof input.name === "string" ? input.name.trim() : current.name,
      port: typeof input.port === "number" ? input.port : current.port,
      insecure: typeof input.insecure === "boolean" ? input.insecure : current.insecure,
      prefixMode: typeof input.prefixMode === "string" ? input.prefixMode : current.prefixMode,
      updatedAt: new Date().toISOString(),
    }

    this.persistTentative([...this.configs.values()].map((record) => (record.id === id ? updated : record)))
    this.configs.set(id, updated)
    await this.refreshPortSideCar(id)
    return this.toSideCar(updated)
  }

  async delete(id: string): Promise<boolean> {
    this.assertOperational()
    if (!this.configs.has(id)) return false

    this.persistTentative([...this.configs.values()].filter((record) => record.id !== id))
    this.configs.delete(id)
    this.runtime.delete(id)
    this.options.eventBus.publish({ type: "sidecar.removed", sidecarId: id })
    return true
  }

  async shutdown() {
    return
  }

  buildTargetOrigin(sidecar: Pick<SideCar, "port" | "insecure">): string {
    const protocol = sidecar.insecure ? "http" : "https"
    return `${protocol}://127.0.0.1:${sidecar.port}`
  }

  buildProxyBasePath(id: string): string {
    return `/sidecars/${encodeURIComponent(id)}`
  }

  buildTargetPath(id: string, incomingPath: string, search = ""): string {
    const record = this.requireConfig(id)
    const publicBase = this.buildProxyBasePath(id)
    const normalizedPath = incomingPath || publicBase

    if (record.prefixMode === "preserve") {
      return `${normalizedPath}${search}`
    }

    let stripped = normalizedPath.startsWith(publicBase) ? normalizedPath.slice(publicBase.length) : normalizedPath
    if (!stripped || stripped === "/") {
      stripped = "/"
    } else if (!stripped.startsWith("/")) {
      stripped = `/${stripped}`
    }
    return `${stripped}${search}`
  }

  private async refreshPortStatuses() {
    await Promise.all(Array.from(this.configs.values()).map((record) => this.refreshPortSideCar(record.id)))
  }

  private async refreshPortSideCar(id: string) {
    const record = this.configs.get(id)
    if (!record) return
    const isAvailable = await this.isPortAvailable(record.port)
    const current = this.runtime.get(id)
    const nextStatus: SideCarStatus = isAvailable ? "running" : "stopped"
    if (current?.status === nextStatus) {
      return
    }

    this.runtime.set(id, { status: nextStatus })
    record.updatedAt = new Date().toISOString()
    this.publish(id)
  }

  private publish(id: string) {
    const record = this.configs.get(id)
    if (!record) return
    this.options.eventBus.publish({ type: "sidecar.updated", sidecar: this.toSideCar(record) })
  }

  private toSideCar(record: SideCarConfigRecord): SideCar {
    const runtime = this.runtime.get(record.id)
    return {
      id: record.id,
      kind: record.kind,
      name: record.name,
      port: record.port,
      insecure: record.insecure,
      prefixMode: record.prefixMode,
      status: runtime?.status ?? "stopped",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  private requireConfig(id: string): SideCarConfigRecord {
    const record = this.configs.get(id)
    if (!record) {
      throw new Error("SideCar not found")
    }
    return record
  }

  private persistTentative(records: SideCarConfigRecord[]) {
    const sidecars = records.map((record) => ({ ...record }))
    this.options.settings.mergePatchOwner("config", "server", { sidecars })
  }

  private loadConfiguredSideCars(): SideCarConfigRecord[] {
    const serverConfig = this.options.settings.getOwner("config", "server") as { sidecars?: unknown }
    if (serverConfig?.sidecars === undefined) return []
    const list = serverConfig.sidecars
    if (!Array.isArray(list)) {
      throw new SideCarConfigError("server.sidecars must be an array")
    }

    const seen = new Set<string>()
    const records: SideCarConfigRecord[] = []
    for (const [index, item] of list.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new SideCarConfigError(`server.sidecars[${index}] must be an object`)
      }
      const record = item as Record<string, unknown>
      if (record.kind !== "port") {
        throw new SideCarConfigError(`server.sidecars[${index}].kind must be "port"`)
      }
      const id = typeof record.id === "string" ? record.id.trim() : ""
      if (!id) {
        throw new SideCarConfigError(`server.sidecars[${index}].id must be a non-empty string`)
      }
      if (seen.has(id)) {
        throw new SideCarConfigError(`server.sidecars contains a duplicate id '${id}'`)
      }
      seen.add(id)
      const name = typeof record.name === "string" ? record.name.trim() : ""
      if (!name) {
        throw new SideCarConfigError(`server.sidecars[${index}].name must be a non-empty string`)
      }
      const port = record.port
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new SideCarConfigError(`server.sidecars[${index}].port must be an integer in 1..65535`)
      }
      if (record.prefixMode !== "preserve" && record.prefixMode !== "strip") {
        throw new SideCarConfigError(`server.sidecars[${index}].prefixMode must be "preserve" or "strip"`)
      }
      // Explicitly-supported legacy optional fields are normalized; everything
      // else above is required and strict. Timestamps must be valid ISO dates
      // when present (missing ones get a stable default).
      const insecure = record.insecure === true
      const createdAt = typeof record.createdAt === "string" && record.createdAt ? record.createdAt : null
      if (createdAt !== null && Number.isNaN(Date.parse(createdAt))) {
        throw new SideCarConfigError(`server.sidecars[${index}].createdAt must be a valid ISO timestamp`)
      }
      const finalCreatedAt = createdAt ?? new Date().toISOString()
      const updatedAt = typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : finalCreatedAt
      if (Number.isNaN(Date.parse(updatedAt))) {
        throw new SideCarConfigError(`server.sidecars[${index}].updatedAt must be a valid ISO timestamp`)
      }
      records.push({ id, kind: "port", name, port, insecure, prefixMode: record.prefixMode, createdAt: finalCreatedAt, updatedAt })
    }
    return records
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.end()
        resolve(true)
      })
      socket.once("error", () => {
        socket.destroy()
        resolve(false)
      })
    })
  }

  private buildSideCarId(name: string): string {
    const normalized = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "")

    if (!normalized) {
      throw new Error("SideCar name must include letters or numbers")
    }

    return normalized
  }
}
