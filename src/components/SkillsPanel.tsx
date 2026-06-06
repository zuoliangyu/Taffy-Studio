// Skills manager — lives inside Settings. Import SKILL.md packages (a single
// .md or a .zip bundle), list them, delete. Skills are read on disk in Rust;
// the agentic loop surfaces them to the model via the `use_skill` tool.
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { deleteSkill, importSkillFile, listSkills, type SkillMeta } from '../lib/skills'
import { Icon } from './Icon'

export function SkillsPanel() {
  const { t } = useI18n()
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  function refresh() {
    listSkills()
      .then(setSkills)
      .catch((e) => setError(String(e)))
  }
  useEffect(() => {
    refresh()
  }, [])

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-importing the same filename
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await importSkillFile(file)
      refresh()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove(name: string) {
    try {
      await deleteSkill(name)
    } catch (e) {
      setError(String(e))
    }
    refresh()
  }

  return (
    <div className="skills-panel">
      <p className="muted-small">{t('skill.desc')}</p>

      {skills.length === 0 ? (
        <p className="muted-small">{t('skill.empty')}</p>
      ) : (
        <div className="skill-list">
          {skills.map((s) => (
            <div key={s.name} className="skill-card">
              <div className="skill-card-main">
                <code className="skill-name">{s.name}</code>
                <span className="skill-desc">{s.description}</span>
                {s.allowedTools.length > 0 && (
                  <span className="muted-small">tools: {s.allowedTools.join(', ')}</span>
                )}
              </div>
              <button
                type="button"
                className="icon-only destructive-btn"
                onClick={() => void remove(s.name)}
                title={t('common.delete')}
                aria-label={t('common.delete')}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <div className="storage-error">{error}</div>}

      <div className="skills-foot">
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.zip"
          style={{ display: 'none' }}
          onChange={onPick}
        />
        <button
          type="button"
          className="ghost small"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? t('skill.importing') : t('skill.import')}
        </button>
      </div>
    </div>
  )
}
