export function normalizeSaipenHome(value: string): string | null {
  return value.trim() || null
}

export function normalizeSaipenFiles(value: string): string[] | null {
  const files = value.split(",").map((file) => file.trim()).filter(Boolean)
  return files.length > 0 ? files : null
}
