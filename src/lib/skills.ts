// Skills — frontend half. Skill *packages* (a SKILL.md + referenced files) live
// on disk in Rust (taffy-core::skills); this wraps the api surface. Skills are
// NOT executed — the agentic loop surfaces a `use_skill` tool that injects the
// SKILL.md on demand, and the model then acts using its other tools.
import { api } from '../services/api'

/** Mirrors Rust `SkillMeta` (parsed SKILL.md frontmatter). */
export interface SkillMeta {
  name: string
  description: string
  compatibility?: string
  allowedTools: string[]
}

export function listSkills(): Promise<SkillMeta[]> {
  return api.skillList()
}

export function importSkillMarkdown(content: string): Promise<SkillMeta> {
  return api.skillImportMarkdown(content)
}

export function importSkillZip(bytes: ArrayBuffer): Promise<SkillMeta> {
  return api.skillImportZip(bytes)
}

export function deleteSkill(name: string): Promise<void> {
  return api.skillDelete(name)
}

export function readSkill(name: string): Promise<string> {
  return api.skillRead(name)
}

/** Import a skill from a picked file: a `.zip` bundle or a single SKILL.md. */
export async function importSkillFile(file: File): Promise<SkillMeta> {
  const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip'
  if (isZip) {
    return importSkillZip(await file.arrayBuffer())
  }
  return importSkillMarkdown(await file.text())
}
