export function getSessionProjectName(projectName: string | undefined, folder: string): string {
  const configured = projectName?.trim()
  if (configured) return configured
  const folderName = folder.split(/[\\/]+/).filter(Boolean).pop()?.trim()
  return folderName || "Session"
}

export function getNextProjectSessionTitle(baseName: string, existingTitles: Iterable<string>): string {
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`^${escaped}(?: (\\d+))?$`, "i")
  let highest = 0

  for (const title of existingTitles) {
    const match = title.trim().match(pattern)
    if (!match) continue
    highest = Math.max(highest, match[1] ? Number.parseInt(match[1], 10) : 1)
  }

  return highest === 0 ? baseName : `${baseName} ${highest + 1}`
}
