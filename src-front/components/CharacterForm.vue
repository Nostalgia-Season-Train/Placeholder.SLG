<script setup lang="ts">
/**
 * 角色表单：新增与编辑共用，字段与角色属性文档一致。
 * 只负责收集并提交表单，落库与生效时机由调用方决定。
 */
import { computed, ref, watch } from 'vue'
import {
  FACTION_NAMES,
  GENERAL_POSITIONS,
  GENERAL_ROLES,
  GENERAL_TEAMS,
  STAT_GRADES,
  type AllianceConfig,
  type GeneralTeam,
} from '@shared/types'
import type { CardCreateDTO, CharacterCardDTO } from '@shared/protocol'

const props = defineProps<{
  /** null 表示新增 */
  card: CharacterCardDTO | null
  alliances: AllianceConfig[]
  busy: boolean
  error: string
  /** assign：显示同盟、团与职位；library：只管理角色属性，归属由新游戏分配 */
  mode?: 'assign' | 'library'
}>()

const emit = defineEmits<{
  save: [payload: CardCreateDTO]
  close: []
}>()

const showAssignment = computed(() => (props.mode ?? 'assign') === 'assign')

function blankDraft(): CardCreateDTO {
  return {
    name: '',
    faction: props.alliances[0]?.faction ?? 'red',
    team: null,
    role: '武将',
    position: '无',
    attack: '中',
    magic: '低',
    personality: '',
    description: '',
    dialoguePrompt: '',
    authorNote: '',
  }
}

const draft = ref<CardCreateDTO>(blankDraft())
const localError = ref('')

watch(
  () => props.card,
  (card) => {
    localError.value = ''
    draft.value = card
      ? {
          name: card.name,
          faction: card.faction,
          team: card.team,
          role: card.role,
          position: card.position,
          attack: card.attack,
          magic: card.magic,
          personality: card.personality,
          description: card.description,
          dialoguePrompt: card.dialoguePrompt,
          authorNote: card.authorNote,
        }
      : blankDraft()
  },
  { immediate: true },
)

const factionOptions = computed(() => {
  const options = props.alliances.map((alliance) => ({
    value: alliance.faction,
    label: alliance.name,
  }))
  // 编辑未启用同盟的角色时保留原选项，避免下拉回落到空值
  if (!options.some((option) => option.value === draft.value.faction)) {
    options.push({
      value: draft.value.faction,
      label: `${FACTION_NAMES[draft.value.faction]}（未启用）`,
    })
  }
  return options
})

const teamValue = computed({
  get: () => draft.value.team ?? '',
  set: (value: string) => {
    draft.value.team = value ? (value as GeneralTeam) : null
  },
})

const title = computed(() => (props.card ? '编辑角色' : '添加角色'))

function submit(): void {
  const name = draft.value.name.trim()
  if (!name) {
    localError.value = '名称不能为空'
    return
  }
  emit('save', { ...draft.value, name })
}
</script>

<template>
  <div class="card-form-mask" @click.self="emit('close')">
    <section class="card-form" role="dialog" aria-modal="true" :aria-label="title">
      <header class="settings-head">
        <h3>{{ title }}</h3>
        <button type="button" class="close" aria-label="关闭" @click="emit('close')">×</button>
      </header>

      <div class="card-form-body">
        <label class="field">
          <span>名称</span>
          <input v-model="draft.name" type="text" maxlength="24" placeholder="角色名称" />
        </label>
        <template v-if="showAssignment">
          <label class="field">
            <span>同盟</span>
            <select v-model="draft.faction">
              <option v-for="option in factionOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>团</span>
            <select v-model="teamValue">
              <option value="">无团</option>
              <option v-for="team in GENERAL_TEAMS" :key="team" :value="team">{{ team }}</option>
            </select>
          </label>
        </template>
        <label class="field">
          <span>定位</span>
          <select v-model="draft.role">
            <option v-for="role in GENERAL_ROLES" :key="role" :value="role">{{ role }}</option>
          </select>
        </label>
        <label v-if="showAssignment" class="field">
          <span>职位</span>
          <select v-model="draft.position">
            <option v-for="position in GENERAL_POSITIONS" :key="position" :value="position">
              {{ position === '无' ? '无（上前线）' : position }}
            </option>
          </select>
        </label>
        <div class="card-grid">
          <label class="field">
            <span>攻击</span>
            <select v-model="draft.attack">
              <option v-for="grade in STAT_GRADES" :key="grade" :value="grade">{{ grade }}</option>
            </select>
          </label>
          <label class="field">
            <span>魔力</span>
            <select v-model="draft.magic">
              <option v-for="grade in STAT_GRADES" :key="grade" :value="grade">{{ grade }}</option>
            </select>
          </label>
        </div>
        <label class="field">
          <span>性格</span>
          <input
            v-model="draft.personality"
            type="text"
            maxlength="120"
            placeholder="如：勇猛、忠诚"
          />
        </label>
        <label class="field">
          <span>描述</span>
          <textarea v-model="draft.description" rows="2" placeholder="背景与经历（可选）"></textarea>
        </label>
        <label class="field">
          <span>对话提示词</span>
          <textarea
            v-model="draft.dialoguePrompt"
            rows="2"
            placeholder="说话方式与语气（可选）"
          ></textarea>
        </label>
        <label class="field">
          <span>作者注释</span>
          <textarea
            v-model="draft.authorNote"
            rows="2"
            placeholder="给使用者看的备注（可选）"
          ></textarea>
        </label>

        <p v-if="localError || error" class="form-error">{{ localError || error }}</p>

        <div class="settings-actions">
          <button type="button" :disabled="busy" @click="submit">
            {{ busy ? '保存中…' : '保存' }}
          </button>
          <button type="button" class="ghost" @click="emit('close')">取消</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.card-form-mask {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(4, 8, 11, 0.55);
  backdrop-filter: blur(2px);
}

.card-form {
  width: min(400px, 100%);
  max-height: min(86vh, 700px);
  display: flex;
  flex-direction: column;
  padding: 14px 16px 16px;
  border: 1px solid rgba(214, 186, 122, 0.38);
  border-radius: 14px;
  background: rgba(12, 19, 24, 0.97);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  color: #e9e4d6;
}

.settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.settings-head h3 {
  font-size: 13px;
  letter-spacing: 0.16em;
  color: #f1e6c8;
}

.settings-head .close {
  border: none;
  background: transparent;
  color: #9fadb0;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.card-form-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding-right: 4px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.card-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.field {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #9fadb0;
}

.field > span {
  flex: none;
  width: 84px;
}

.field input[type='text'],
.field select,
.field textarea {
  flex: 1;
  min-width: 0;
  border: 1px solid rgba(214, 186, 122, 0.3);
  border-radius: 6px;
  padding: 6px 8px;
  background: rgba(8, 13, 17, 0.85);
  color: #e9e4d6;
  font-size: 12px;
}

.field textarea {
  resize: vertical;
}

.form-error {
  margin: 0;
  font-size: 11px;
  color: #e09191;
}

.settings-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.settings-actions button {
  border: 1px solid rgba(214, 186, 122, 0.5);
  border-radius: 6px;
  padding: 6px 12px;
  background: rgba(214, 186, 122, 0.18);
  color: #f0dfb4;
  font-size: 12px;
  cursor: pointer;
}

.settings-actions .ghost {
  border-color: rgba(255, 255, 255, 0.16);
  background: transparent;
  color: #9fadb0;
}

.settings-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
