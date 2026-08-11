export interface InitialSessionState {
  restoreActive: boolean
  ready: boolean
  fetching: boolean
  creating: boolean
  listError?: string
  parentCount: number
}

interface InitialSessionDependencies {
  waitForHydration: () => Promise<void>
  waitForRestore: () => Promise<void>
  canCreate: () => boolean
  create: () => Promise<{ id: string }>
  moveDraft: (sessionId: string) => void
  shouldActivate: () => boolean
  activate: (sessionId: string) => void
}

const initialSessionRequests = new Map<string, Promise<void>>()
const sessionRestoreBarriers = new Map<string, Promise<void>>()

export function shouldCreateInitialSession(state: InitialSessionState): boolean {
  return !state.restoreActive
    && state.ready
    && !state.fetching
    && !state.creating
    && !state.listError
    && state.parentCount === 0
}

export function trackSessionRestoreBarrier(instanceId: string, operation: Promise<unknown>): void {
  const settled = operation.then(() => undefined, () => undefined)
  const previous = sessionRestoreBarriers.get(instanceId)
  const barrier = previous
    ? Promise.all([previous, settled]).then(() => undefined)
    : settled
  sessionRestoreBarriers.set(instanceId, barrier)
  void barrier.then(() => {
    if (sessionRestoreBarriers.get(instanceId) === barrier) sessionRestoreBarriers.delete(instanceId)
  })
}

export async function waitForSessionRestoreBarrier(instanceId: string): Promise<void> {
  await sessionRestoreBarriers.get(instanceId)
}

export function ensureInitialSession(instanceId: string, dependencies: InitialSessionDependencies): Promise<void> {
  const existing = initialSessionRequests.get(instanceId)
  if (existing) return existing

  const request = (async () => {
    await dependencies.waitForHydration()
    await dependencies.waitForRestore()
    if (!dependencies.canCreate()) return
    const session = await dependencies.create()
    dependencies.moveDraft(session.id)
    if (dependencies.shouldActivate()) dependencies.activate(session.id)
  })()

  initialSessionRequests.set(instanceId, request)
  void request.then(
    () => {
      if (initialSessionRequests.get(instanceId) === request) initialSessionRequests.delete(instanceId)
    },
    () => {
      if (initialSessionRequests.get(instanceId) === request) initialSessionRequests.delete(instanceId)
    },
  )
  return request
}
