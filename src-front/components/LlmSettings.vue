<script setup lang="ts">
/**
 * LLM 设置面板：开局页与地图设置共用。
 * 模式与密钥只保存在后端，组件挂载时自行拉取最新状态。
 */
import { computed, onMounted, ref } from 'vue'
import { WorldApi } from '@/game/api/client'
import type { LlmMode, LlmStatusDTO } from '@shared/protocol'

const props = defineProps<{ lastError?: string }>()

const api = new WorldApi()
const status = ref<LlmStatusDTO | null>(null)
const draft = ref({ baseUrl: '', model: '', apiKey: '', mode: 'live' as LlmMode })
const error = ref('')
const notice = ref('')
const testing = ref(false)
const saving = ref(false)

const hasSavedKey = computed(() => status.value?.hasApiKey ?? false)
const shownError = computed(() => error.value || props.lastError || '')

function applyStatus(next: LlmStatusDTO): void {
  status.value = next
  draft.value.baseUrl = next.baseUrl
  draft.value.model = next.model
  draft.value.apiKey = ''
  draft.value.mode = next.mode
  error.value = next.lastError ?? ''
}

onMounted(async () => {
  try {
    applyStatus(await api.getLlm())
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : '无法读取 LLM 设置'
  }
})

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  notice.value = ''
  try {
    applyStatus(
      await api.setLlm({
        baseUrl: draft.value.baseUrl,
        model: draft.value.model,
        apiKey: draft.value.apiKey,
        mode: draft.value.mode,
      }),
    )
    notice.value = '设置已保存'
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : 'LLM 设置保存失败'
  } finally {
    saving.value = false
  }
}

async function test(): Promise<void> {
  if (testing.value) return
  testing.value = true
  notice.value = ''
  try {
    const result = await api.testLlm()
    if (result.ok) {
      error.value = ''
      notice.value = draft.value.mode === 'mock' ? '当前为模拟 LLM，无需联网' : '连接正常'
    } else {
      error.value = result.error ?? '无法连接 LLM 接口'
    }
  } catch (testError) {
    error.value = testError instanceof Error ? testError.message : '连接测试失败'
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div class="llm-settings">
    <label class="field">
      <span>模式</span>
      <select v-model="draft.mode">
        <option value="live">真实 LLM</option>
        <option value="mock">模拟 LLM（本地规则，不联网）</option>
      </select>
    </label>
    <template v-if="draft.mode === 'live'">
      <label class="field">
        <span>baseUrl</span>
        <input v-model="draft.baseUrl" type="text" placeholder="https://api.openai.com/v1" />
      </label>
      <label class="field">
        <span>model</span>
        <input v-model="draft.model" type="text" placeholder="gpt-4o-mini" />
      </label>
      <label class="field">
        <span>apiKey</span>
        <input
          v-model="draft.apiKey"
          type="password"
          :placeholder="hasSavedKey ? '已保存，留空保持不变' : '仅保存在后端服务'"
        />
      </label>
    </template>
    <div class="actions">
      <button type="button" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <button type="button" class="ghost" :disabled="testing" @click="test">
        {{ testing ? '测试中…' : '测试连接' }}
      </button>
    </div>
    <p v-if="shownError" class="llm-error">连接失败：{{ shownError }}</p>
    <p v-else-if="notice" class="llm-ok">{{ notice }}</p>
    <p class="meta">
      接口需兼容 OpenAI chat/completions。配置保存在后端，Key 不会下发到浏览器。模拟 LLM
      完全由服务端本地规则驱动，不发起任何网络请求。
    </p>
  </div>
</template>

<style scoped>
.llm-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field {
  display: flex;
  align-items: center;
  gap: 10px;
}

.field > span {
  flex: none;
  width: 74px;
  font-size: 12px;
  color: #9fadb0;
}

.field input,
.field select {
  flex: 1;
  min-width: 0;
  border: 1px solid rgba(214, 186, 122, 0.3);
  border-radius: 6px;
  padding: 6px 8px;
  background: rgba(8, 13, 17, 0.85);
  color: #e9e4d6;
  font-size: 12px;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.actions button {
  border: 1px solid rgba(214, 186, 122, 0.5);
  border-radius: 6px;
  padding: 6px 12px;
  background: rgba(214, 186, 122, 0.18);
  color: #f0dfb4;
  font-size: 12px;
  cursor: pointer;
}

.actions button.ghost {
  border-color: rgba(255, 255, 255, 0.16);
  background: transparent;
  color: #9fadb0;
}

.actions button:disabled {
  opacity: 0.45;
  cursor: default;
}

.llm-error,
.llm-ok {
  font-size: 11px;
  line-height: 1.5;
}

.llm-error {
  color: #e09191;
}

.llm-ok {
  color: #8fc4a3;
}

.meta {
  font-size: 11px;
  line-height: 1.6;
  color: #7d8d92;
}
</style>
