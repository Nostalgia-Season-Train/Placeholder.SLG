<script setup lang="ts">
/**
 * 性格选择浮窗：按维度列出标签，同维度互斥、跨维度由冲突表决定能否共存。
 * 只负责挑选，确定后由角色表单写入草稿。
 */
import { computed, ref, watch } from 'vue'
import {
  PERSONALITY_AXES,
  personalityAxisOf,
  personalityConflicts,
  personalitySummary,
  type PersonalityTag,
} from '@shared/types'

const props = defineProps<{ selected: PersonalityTag[] }>()
const emit = defineEmits<{
  confirm: [tags: PersonalityTag[]]
  close: []
}>()

const draft = ref<PersonalityTag[]>([...props.selected])
watch(
  () => props.selected,
  (value) => {
    draft.value = [...value]
  },
)

/** 与已选标签跨维度冲突时才禁用；同维度的其他标签保持可点，用于切换 */
function isBlocked(tag: PersonalityTag): boolean {
  return draft.value.some(
    (item) =>
      personalityAxisOf(item) !== personalityAxisOf(tag) && personalityConflicts(item, tag),
  )
}

/** 每个维度必选一个：点同维度其他标签即替换，点冲突标签无效，点已选标签保持不变 */
function select(tag: PersonalityTag): void {
  if (isBlocked(tag)) return
  const axis = personalityAxisOf(tag)
  const others = draft.value.filter((item) => personalityAxisOf(item) !== axis)
  draft.value = [...others, tag]
}

const summary = computed(() => personalitySummary(draft.value))
</script>

<template>
  <div class="picker-mask" @click.self="emit('close')">
    <section class="picker" role="dialog" aria-modal="true" aria-label="选择性格">
      <header class="picker-head">
        <h3>选择性格</h3>
        <button type="button" class="close" aria-label="关闭" @click="emit('close')">×</button>
      </header>

      <div class="picker-body">
        <div v-for="group in PERSONALITY_AXES" :key="group.axis" class="picker-group">
          <div class="picker-axis">
            <span>{{ group.axis }}</span>
            <p>{{ group.hint }}</p>
          </div>
          <div class="picker-tags">
            <button
              v-for="tag in group.tags"
              :key="tag"
              type="button"
              :class="['tag-btn', { active: draft.includes(tag), blocked: isBlocked(tag) }]"
              :disabled="isBlocked(tag)"
              :title="isBlocked(tag) ? '与已选标签语义冲突' : ''"
              @click="select(tag)"
            >
              {{ tag }}
            </button>
          </div>
        </div>

        <p class="picker-note">{{ summary.behavior }}</p>
      </div>

      <footer class="picker-actions">
        <button type="button" class="ghost" @click="emit('close')">取消</button>
        <button type="button" @click="emit('confirm', draft)">完成</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.picker-mask {
  position: fixed;
  inset: 0;
  z-index: 140;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(4, 8, 11, 0.45);
}

.picker {
  width: min(360px, 100%);
  max-height: min(80vh, 520px);
  display: flex;
  flex-direction: column;
  padding: 14px 16px 14px;
  border: 1px solid rgba(214, 186, 122, 0.42);
  border-radius: 12px;
  background: rgba(14, 22, 27, 0.99);
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.55);
  color: #e9e4d6;
}

.picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.picker-head h3 {
  font-size: 13px;
  letter-spacing: 0.16em;
  color: #f1e6c8;
}

.picker-head .close {
  border: none;
  background: transparent;
  color: #9fadb0;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.picker-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 10px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.picker-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.picker-axis {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.picker-axis span {
  flex: none;
  font-size: 12px;
  color: #d4b270;
}

.picker-axis p {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: #6f7d82;
}

.picker-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-btn {
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  color: #a9b6b9;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.tag-btn:hover {
  border-color: rgba(212, 178, 112, 0.55);
  color: #e8dcc0;
}

.tag-btn.active {
  border-color: #d4b270;
  background: rgba(212, 178, 112, 0.2);
  color: #f3e7c9;
}

.tag-btn.blocked {
  cursor: not-allowed;
  opacity: 0.35;
  border-style: dashed;
}

.tag-btn.blocked:hover {
  border-color: rgba(255, 255, 255, 0.18);
  color: #a9b6b9;
}

.picker-note {
  margin: 0;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 11px;
  line-height: 1.6;
  color: #8c9a9d;
}

.picker-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 12px;
}

.picker-actions button {
  border: 1px solid rgba(214, 186, 122, 0.5);
  border-radius: 6px;
  padding: 6px 14px;
  background: rgba(214, 186, 122, 0.18);
  color: #f0dfb4;
  font-size: 12px;
  cursor: pointer;
}

.picker-actions .ghost {
  border-color: rgba(255, 255, 255, 0.16);
  background: transparent;
  color: #9fadb0;
}

.picker-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
