import type {
  SaipenSubLifecycle,
  SaipenSubPackageCounts,
  SaipenSubPackageStatus,
} from "../../../server/src/api-types"

const lifecycleKeys: Record<SaipenSubLifecycle, string> = {
  active: "saipen.subs.lifecycle.active",
  blocked: "saipen.subs.lifecycle.blocked",
  done: "saipen.subs.lifecycle.done",
  missing: "saipen.subs.lifecycle.missing",
  malformed: "saipen.subs.lifecycle.malformed",
}

const packageKeys: Record<SaipenSubPackageStatus, string> = {
  none: "saipen.subs.package.none",
  ready: "saipen.subs.package.ready",
  draft: "saipen.subs.package.draft",
  blocked: "saipen.subs.package.blocked",
  reviewed: "saipen.subs.package.reviewed",
  stale: "saipen.subs.package.stale",
  missing: "saipen.subs.package.missing",
  malformed: "saipen.subs.package.malformed",
}

export function getSaipenSubLifecycleKey(lifecycle: SaipenSubLifecycle): string {
  return lifecycleKeys[lifecycle]
}

export function getSaipenSubPackageKey(status: SaipenSubPackageStatus): string {
  return packageKeys[status]
}

export function getSaipenSubPackageCounts(counts: SaipenSubPackageCounts) {
  return (Object.entries(counts) as Array<[keyof SaipenSubPackageCounts, number]>).filter(([, count]) => count > 0)
}
