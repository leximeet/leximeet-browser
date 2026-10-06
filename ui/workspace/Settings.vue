<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { defaultCapturePolicy, type CapturePolicy } from "../../lib/capture-policy.ts";
import { browser } from "wxt/browser";
import { useWorkspace } from "./useWorkspace.ts";
import Dialog from "./Dialog.vue";
import CardSettings from "./CardSettings.vue";
import { CARD_PRESETS } from "../../lib/word-card-content.ts";
import type { WorkspacePreferences } from "../../lib/workspace-model.ts";
import Icon from "../Icon.vue";
import {
  readStorageHealth,
  storageSize,
  type StorageHealth,
} from "../../lib/storage-health.ts";
import { pronunciationUrl } from "../../lib/pronunciation.ts";
import type { IntegrationStatus } from "../../lib/application-services.ts";
import { call } from "../api.ts";
import { sitePattern } from "../../lib/site-access.ts";
import type { FloatingPreferences } from "../../lib/floating-preferences.ts";
import type { DiscoveryView } from "../../lib/desktop-discovery.ts";
import type { ConnectionView } from "../../lib/desktop-connection.ts";
const emit = defineEmits<{ onboard: [] }>(),
  ctx = useWorkspace(),
  { preferences, settings, audioState } = ctx;
const cardOpen = ref(false),
  cardInitialLevel = ref<WorkspacePreferences["card"]["level"]>("custom"),
  siteQuery = ref(""),
  sitePage = ref(1),
  floatingBusy = ref(false),
  voiceOpen = ref(false),
  voiceDraft = ref({ ...preferences.value.pronunciation }),
  testWord = ref("resilient"),
  health = ref<StorageHealth | null>(null),
  sites = ref<string[]>([]),
  integrations = ref<IntegrationStatus | null>(null),
  floating = ref<FloatingPreferences | null>(null);
const SITE_PAGE_SIZE = 6;
const filteredSites = computed(() =>
  sites.value.filter((site) =>
    site.toLowerCase().includes(siteQuery.value.trim().toLowerCase()),
  ),
);
const sitePages = computed(() =>
  Math.max(1, Math.ceil(filteredSites.value.length / SITE_PAGE_SIZE)),
);
const pageSites = computed(() =>
  filteredSites.value.slice(
    (sitePage.value - 1) * SITE_PAGE_SIZE,
    sitePage.value * SITE_PAGE_SIZE,
  ),
);
watch(siteQuery, () => {
  sitePage.value = 1;
});
watch(sitePages, (count) => {
  sitePage.value = Math.min(sitePage.value, count);
});
async function onCardChange(event: Event) {
  const select = event.target as HTMLSelectElement;
  const level = select.value as WorkspacePreferences["card"]["level"];
  // 打开编辑器并不提交设置，恢复原 select 值以保证取消后也正确显示。
  if (level === "custom" || level === "complete")
    select.value = preferences.value.card.level;
  if (!(await chooseCard(level))) select.value = preferences.value.card.level;
}
async function chooseCard(level: WorkspacePreferences["card"]["level"]) {
  // 完整和自定义都先确认字段；取消保持已有设置。
  if (level === "custom" || level === "complete") {
    cardInitialLevel.value = level;
    cardOpen.value = true;
    return true;
  }
  return ctx.savePreferences({
    ...preferences.value,
    card: { level, sections: [...CARD_PRESETS[level]] },
  });
}
async function saveCurrentSettings() {
  if (ctx.busy.value || capturePolicyBusy.value || floatingBusy.value) return;
  // 数值草稿先完整校验并确认采集设置，不能只保存另一组偏好后误报成功。
  if (!(await saveCapturePolicy(false))) return;
  await ctx.savePreferences({ ...preferences.value });
}
async function saveTheme(event: Event) {
  const select = event.target as HTMLSelectElement;
  const theme = select.value as typeof settings.value.theme;
  if (!(await ctx.work(() => ctx.library.updateSettings({ theme }), "设置已保存")))
    select.value = settings.value.theme;
}
async function savePractice(event: Event, key: "autoPronounce" | "soundFeedback") {
  const input = event.target as HTMLInputElement;
  if (
    !(await ctx.savePreferences({
      ...preferences.value,
      practice: { ...preferences.value.practice, [key]: input.checked },
    }))
  )
    input.checked = preferences.value.practice[key] !== false;
}
async function saveFloatingControl(event: Event, key: "enabled" | "locked") {
  const input = event.target as HTMLInputElement;
  if (!(await saveFloating({ [key]: input.checked })))
    input.checked = floating.value?.[key] ?? false;
}
async function saveFloating(patch: Record<string, unknown>) {
  if (floatingBusy.value) return false;
  floatingBusy.value = true;
  ctx.error.value = "";
  try {
    await call("floating-update", patch);
    await check();
    ctx.announce("设置已保存");
    return true;
  } catch (error) {
    ctx.notice.value = "";
    ctx.error.value = (error as Error).message;
    return false;
  } finally {
    floatingBusy.value = false;
  }
}
const connection = ref<ConnectionView | null>(null);
const discovery = ref<DiscoveryView | null>(null),
  pairingBusy = ref(false),
  pairingError = ref("");
const capturePolicy = ref<CapturePolicy>(defaultCapturePolicy()),
  capturePolicyBusy = ref(false);
// 数值输入保留字符串草稿，空值、小数和越界值都不能被默默转换成有效设置。
const captureDraft = ref({
  duplicateWindowDays: String(capturePolicy.value.duplicateWindowDays),
  contextMaxLength: String(capturePolicy.value.contextMaxLength),
  sensitiveRedactionEnabled: capturePolicy.value.sensitiveRedactionEnabled,
});
const captureValidation = computed(() => {
  const integerIn = (value: string, min: number, max: number) =>
    value.trim() !== "" &&
    Number.isInteger(Number(value)) &&
    Number(value) >= min &&
    Number(value) <= max;
  if (!integerIn(captureDraft.value.duplicateWindowDays, 0, 365))
    return "相同语境去重天数需为 0–365 的整数";
  if (!integerIn(captureDraft.value.contextMaxLength, 120, 2000))
    return "单句语境长度上限需为 120–2000 的整数";
  return "";
});
function resetCaptureDraft() {
  captureDraft.value = {
    duplicateWindowDays: String(capturePolicy.value.duplicateWindowDays),
    contextMaxLength: String(capturePolicy.value.contextMaxLength),
    sensitiveRedactionEnabled: capturePolicy.value.sensitiveRedactionEnabled,
  };
}
function editCaptureNumber(
  event: Event,
  key: "duplicateWindowDays" | "contextMaxLength",
) {
  captureDraft.value[key] = (event.target as HTMLInputElement).value;
  ctx.error.value = "";
  ctx.notice.value = "";
}
async function saveCapturePolicy(announce = true) {
  if (capturePolicyBusy.value) return false;
  if (captureValidation.value) {
    ctx.notice.value = "";
    ctx.error.value = captureValidation.value;
    return false;
  }
  capturePolicyBusy.value = true;
  ctx.notice.value = "";
  try {
    const draft: CapturePolicy = {
      duplicateWindowDays: Number(captureDraft.value.duplicateWindowDays),
      contextMaxLength: Number(captureDraft.value.contextMaxLength),
      sensitiveRedactionEnabled: captureDraft.value.sensitiveRedactionEnabled,
    };
    // 只提交用户改动的字段，另一管理页保存的其他字段继续由后台保留。
    const policy = Object.fromEntries(
      Object.entries(draft).filter(
        ([key, value]) => capturePolicy.value[key as keyof CapturePolicy] !== value,
      ),
    );
    capturePolicy.value = Object.keys(policy).length
      ? await call("update-capture-policy", { policy })
      : await call("capture-policy");
    resetCaptureDraft();
    ctx.error.value = "";
    if (announce) ctx.announce("设置已保存");
    return true;
  } catch (e) {
    ctx.error.value = (e as Error).message;
    return false;
  } finally {
    capturePolicyBusy.value = false;
  }
}
let connectionPoll: ReturnType<typeof setInterval> | undefined;
let mounted = true;
async function readConnection() {
  const next = await call<ConnectionView>("connection-state");
  const found = await call<DiscoveryView>("desktop-discovery-state");
  if (mounted) {
    connection.value = next;
    discovery.value = found;
  }
}
async function connectDesktop() {
  if (pairingBusy.value) return;
  pairingBusy.value = true;
  pairingError.value = "";
  try {
    discovery.value = await call("desktop-request-connection");
  } catch (cause) {
    pairingError.value = (cause as Error).message;
  } finally {
    pairingBusy.value = false;
  }
}
async function detectDesktop() {
  pairingBusy.value = true;
  pairingError.value = "";
  try {
    discovery.value = await call("desktop-check");
  } catch (cause) {
    pairingError.value = (cause as Error).message;
  } finally {
    pairingBusy.value = false;
  }
}
async function saveVoice() {
  try {
    pronunciationUrl("resilient", voiceDraft.value);
    if (
      await ctx.savePreferences({
        ...preferences.value,
        pronunciation: voiceDraft.value,
      })
    ) {
      ctx.audio.stop();
      voiceOpen.value = false;
    }
  } catch (e) {
    ctx.error.value = (e as Error).message;
  }
}
async function check(resetDraft = false) {
  const next = await call<CapturePolicy>("capture-policy");
  // 刷新其他设置时保留本页正在编辑的字段，未改字段跟随最新正式政策。
  const changedDraft = Object.fromEntries(
    Object.entries(captureDraft.value).filter(([key, value]) =>
      typeof value === "boolean"
        ? value !== capturePolicy.value[key as keyof CapturePolicy]
        : value.trim() === "" ||
          Number(value) !== capturePolicy.value[key as keyof CapturePolicy],
    ),
  );
  capturePolicy.value = next;
  resetCaptureDraft();
  if (!resetDraft) Object.assign(captureDraft.value, changedDraft);
  health.value = await readStorageHealth();
  // 已打开和已隐藏的普通网站分页显示；真正的访问授权继续由 Chrome 管理。
  const openedSites = [
    ...new Set(
      (await browser.tabs.query({}))
        .filter((t) => sitePattern(t.url))
        .map((t) => new URL(t.url!).origin),
    ),
  ];
  floating.value = await call("floating-config");
  sites.value = [
    ...new Set([...openedSites, ...(floating.value?.hiddenOrigins || [])]),
  ].sort();
  integrations.value = await call("integration-status");
  await readConnection();
}
function manageSites() {
  return browser.tabs.create({
    url: `chrome://extensions/?id=${browser.runtime.id}`,
  });
}
onMounted(() => {
  void check(true).catch((e) => (ctx.error.value = (e as Error).message));
  connectionPoll = setInterval(() => void readConnection().catch(() => {}), 2000);
});
onUnmounted(() => {
  mounted = false;
  clearInterval(connectionPoll);
  ctx.audio.stop();
});
</script>
<template>
  <section class="v3-settings">
    <section>
      <small class="v3-eyebrow">APPEARANCE</small>
      <h2>外观与词卡</h2>
      <div class="v3-setting-row">
        <div><strong>主题</strong></div>
        <select
          :value="settings.theme"
          aria-label="主题"
          :disabled="ctx.busy.value"
          @change="saveTheme"
        >
          <option value="system">跟随系统</option>
          <option value="light">明亮</option>
          <option value="dark">深色</option>
        </select>
      </div>
      <div class="v3-setting-row">
        <strong>词卡内容</strong
        ><select
          :value="preferences.card.level"
          aria-label="词卡密度"
          :disabled="ctx.busy.value"
          @change="onCardChange"
        >
          <option value="minimal">极简</option>
          <option value="moderate">适中</option>
          <option value="detailed">详细</option>
          <option value="complete">完整</option>
          <option value="custom">自定义</option>
        </select>
        <button
          v-if="preferences.card.level === 'custom'"
          class="v3-secondary"
          @click="chooseCard('custom')"
        >
          选择词卡内容
        </button>
      </div>
    </section>
    <section>
      <small class="v3-eyebrow">PRONUNCIATION</small>
      <h2>发音</h2>
      <div class="v3-setting-row">
        <div>
          <strong>{{
            preferences.pronunciation.provider === "youdao" ? "有道" : "自定义服务"
          }}</strong
          ><small
            >{{ preferences.pronunciation.accent === "uk" ? "英式" : "美式" }} ·
            {{ preferences.pronunciation.rate }} 倍速</small
          >
        </div>
        <button
          class="v3-secondary"
          @click="
            voiceDraft = { ...preferences.pronunciation };
            voiceOpen = true;
          "
        >
          发音设置
        </button>
      </div>
    </section>
    <section>
      <small class="v3-eyebrow">PRACTICE</small>
      <h2>练习反馈</h2>
      <label
        v-for="[key, label] in [
          ['autoPronounce', '拼写完成后发音'],
          ['soundFeedback', '打字与答题音效'],
        ] as const"
        :key="key"
        class="v3-setting-row"
      >
        <span>{{ label }}</span
        ><input
          type="checkbox"
          :checked="preferences.practice[key] !== false"
          :disabled="ctx.busy.value"
          @change="savePractice($event, key)"
        />
      </label>
    </section>
    <section aria-label="采集隐私与重复语境">
      <small class="v3-eyebrow">CAPTURE</small>
      <h2>采集隐私与重复语境</h2>
      <label class="v3-setting-row"
        ><span>相同语境去重天数<small>0 表示允许重复记录</small></span
        ><input
          aria-label="相同语境去重天数"
          type="number"
          min="0"
          max="365"
          :value="captureDraft.duplicateWindowDays"
          :aria-invalid="!!captureValidation"
          @input="editCaptureNumber($event, 'duplicateWindowDays')"
          :disabled="capturePolicyBusy"
          @change="saveCapturePolicy()"
      /></label>
      <label class="v3-setting-row"
        ><span>敏感内容替换为 xxx</span
        ><input
          aria-label="敏感内容替换为 xxx"
          type="checkbox"
          v-model="captureDraft.sensitiveRedactionEnabled"
          :disabled="capturePolicyBusy"
          @change="saveCapturePolicy()"
      /></label>
      <label class="v3-setting-row"
        ><span>单句语境长度上限</span
        ><input
          aria-label="单句语境长度上限"
          type="number"
          min="120"
          max="2000"
          :value="captureDraft.contextMaxLength"
          :aria-invalid="!!captureValidation"
          @input="editCaptureNumber($event, 'contextMaxLength')"
          :disabled="capturePolicyBusy"
          @change="saveCapturePolicy()"
      /></label>
      <p v-if="captureValidation" class="settings-validation" role="alert">
        {{ captureValidation }}；修改尚未保存。
      </p>
    </section>
    <section>
      <small class="v3-eyebrow">READING</small>
      <h2>网页阅读</h2>
      <div v-if="floating" class="v3-setting-row">
        <label class="v3-check-row"
          ><input
            :checked="floating.enabled"
            type="checkbox"
            :disabled="floatingBusy"
            @change="saveFloatingControl($event, 'enabled')"
          />悬浮球</label
        ><label class="v3-check-row"
          ><input
            :checked="floating.locked"
            type="checkbox"
            :disabled="floatingBusy"
            @change="saveFloatingControl($event, 'locked')"
          />固定位置</label
        >
      </div>
      <div class="v3-setting-row" v-if="floating?.hiddenOrigins.length">
        <strong>已隐藏网站</strong
        ><button class="v3-secondary" @click="saveFloating({ restoreHiddenSites: true })">
          恢复已隐藏网站的悬浮球
        </button>
      </div>
      <div class="v3-setting-row">
        <strong>网站授权</strong
        ><button class="v3-secondary" @click="manageSites">管理网站访问权限</button>
      </div>
      <div v-if="sites.length" class="site-settings" aria-label="网站授权列表">
        <label class="site-search"
          ><span>查找网站</span
          ><input
            v-model="siteQuery"
            type="search"
            aria-label="查找网站"
            placeholder="输入网站地址"
        /></label>
        <div v-for="site in pageSites" :key="site" class="v3-setting-row site-row">
          <span>{{ site }}</span>
          <span v-if="floating?.hiddenOrigins.includes(site)" class="site-hidden"
            >悬浮球已隐藏</span
          >
          <button
            v-else
            class="v3-secondary"
            title="在此网站隐藏悬浮球"
            :disabled="floatingBusy"
            @click="saveFloating({ hideOrigin: site })"
          >
            隐藏悬浮球
          </button>
        </div>
        <p v-if="!filteredSites.length" class="site-empty">没有匹配的网站</p>
        <nav class="site-pagination" aria-label="网站授权分页">
          <button class="v3-secondary" :disabled="sitePage <= 1" @click="sitePage--">
            上一页
          </button>
          <span
            >{{ sitePage }} / {{ sitePages }} · {{ filteredSites.length }} 个网站</span
          >
          <button
            class="v3-secondary"
            :disabled="sitePage >= sitePages"
            @click="sitePage++"
          >
            下一页
          </button>
        </nav>
      </div>
      <div class="v3-setting-row">
        <strong>使用教学</strong
        ><button class="v3-secondary" @click="emit('onboard')">重新进入教学</button>
      </div>
    </section>
    <section>
      <small class="v3-eyebrow">LOCAL DATA</small>
      <h2>本机资料</h2>
      <div class="v3-setting-row">
        <div>
          <strong>浏览器存储</strong
          ><small>{{
            health
              ? `已使用 ${storageSize(health.usageBytes)} / ${storageSize(health.quotaBytes)}`
              : "正在读取"
          }}</small>
        </div>
        <button class="v3-secondary" @click="check()">检查存储</button>
      </div>
    </section>
    <section>
      <small class="v3-eyebrow">INTEGRATIONS</small>
      <h2>账号与桌面端</h2>
      <div class="v3-setting-row">
        <strong>登录账号</strong
        ><button
          class="v3-secondary"
          disabled
          :title="
            integrations?.account.status === 'unavailable'
              ? integrations.account.reason
              : ''
          "
        >
          后续版本
        </button>
      </div>
      <div class="desktop-pairing">
        <div>
          <strong>连接词遇桌面端</strong>
          <p>
            {{
              discovery?.available
                ? `${discovery.desktop?.displayName} 已就绪`
                : "打开桌面应用后，浏览器会自动发现。"
            }}
          </p>
        </div>
        <div class="desktop-pairing-form">
          <button
            class="mg-primary"
            :disabled="pairingBusy || !discovery?.available"
            :aria-busy="pairingBusy"
            @click="connectDesktop"
          >
            连接桌面端
          </button>
          <button class="v3-secondary" :disabled="pairingBusy" @click="detectDesktop">
            检测桌面端
          </button>
        </div>
        <small>原独立资料封存，不上传、不合并。明确断开后恢复。</small>
        <p v-if="discovery?.notification === 'denied'" role="status">
          浏览器通知未允许，可在这里直接连接。
        </p>
        <p v-if="pairingError" class="desktop-pairing-error" role="alert">
          {{ pairingError }}
        </p>
        <p v-else-if="connection?.message" role="status">
          {{ connection.message }}
        </p>
      </div>
    </section>
    <footer class="settings-save-actions">
      <p>修改会自动保存，也可以在这里再次保存当前设置。</p>
      <button
        class="mg-primary"
        :disabled="ctx.busy.value || capturePolicyBusy || floatingBusy"
        @click="saveCurrentSettings"
      >
        {{ ctx.busy.value ? "正在保存…" : "保存设置" }}
      </button>
    </footer>
    <CardSettings
      v-if="cardOpen"
      :initial-level="cardInitialLevel"
      @close="cardOpen = false"
    />
    <Dialog
      v-if="voiceOpen"
      title="发音设置"
      @close="
        voiceOpen = false;
        ctx.audio.stop();
      "
      ><label class="v3-form-field"
        >发音服务<select v-model="voiceDraft.provider">
          <option value="youdao">有道</option>
          <option value="custom">自定义音频服务</option>
          <option disabled>微软兼容服务 · 待接入</option>
        </select></label
      ><label v-if="voiceDraft.provider === 'custom'" class="v3-form-field"
        >HTTPS 音频地址<input
          v-model="voiceDraft.customUrl"
          placeholder="https://example.com/audio?word={word}"
      /></label>
      <div class="voice-controls">
        <label class="v3-form-field"
          ><span>口音</span
          ><select v-model="voiceDraft.accent" aria-label="口音">
            <option value="us">美式</option>
            <option value="uk">英式</option>
          </select></label
        ><label class="v3-form-field"
          ><span>语速</span
          ><select v-model.number="voiceDraft.rate" aria-label="语速">
            <option :value="0.75">0.75 倍</option>
            <option :value="1">正常</option>
            <option :value="1.25">1.25 倍</option>
          </select></label
        >
      </div>
      <label class="v3-form-field"
        >试听单词<input v-model="testWord" maxlength="160"
      /></label>
      <div class="voice-preview">
        <button class="v3-secondary" @click="ctx.audio.play(testWord, voiceDraft)">
          <Icon name="volume" />试听发音
        </button>
        <p>仅向所选服务发送当前词头。需要联网。</p>
      </div>
      <p v-if="audioState.phase === 'error'" role="status">
        {{ audioState.message }}
      </p>
      <footer class="v3-dialog-actions">
        <button
          class="v3-secondary"
          @click="
            voiceOpen = false;
            ctx.audio.stop();
          "
        >
          取消</button
        ><button class="mg-primary" @click="saveVoice">保存发音设置</button>
      </footer></Dialog
    >
  </section>
</template>

<style scoped>
.settings-validation {
  color: var(--danger, #a63333);
  font-size: 12px;
  line-height: 1.8;
}
.v3-setting-row {
  flex-wrap: wrap;
}
.v3-setting-row > :first-child {
  min-width: 0;
}
.v3-setting-row small,
.site-row > span {
  overflow-wrap: anywhere;
}
.voice-controls {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  border-bottom: 1px solid var(--line);
}
.voice-controls .v3-form-field {
  min-width: 0;
}
.voice-controls select {
  width: 100%;
}
.voice-preview {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 18px;
  margin: 18px 0;
}
.voice-preview p {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.8;
}
.site-search {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 18px 0 0;
  color: var(--muted);
  font-size: 12px;
}
.site-search input {
  width: min(300px, 100%);
}
.site-row > span:first-child {
  flex: 1;
  font-size: 12px;
  min-width: min(200px, 100%);
}
.site-hidden,
.site-empty {
  color: var(--muted);
  font-size: 12px;
}
.site-pagination {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 18px 0;
  color: var(--muted);
  font-size: 12px;
}
.settings-save-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 26px 0 8px;
}
.settings-save-actions p {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
}
@media (max-width: 480px) {
  .voice-controls {
    grid-template-columns: 1fr;
    gap: 0;
  }
  .v3-setting-row > select {
    max-width: 100%;
  }
  .settings-save-actions .mg-primary {
    width: 100%;
  }
}

.desktop-pairing {
  display: grid;
  gap: 16px;
  padding: 20px 0;
}
.desktop-pairing p {
  color: var(--muted);
  margin: 8px 0 0;
  line-height: 1.8;
}
.desktop-pairing-form {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.desktop-pairing-form label {
  display: grid;
  gap: 7px;
  color: var(--muted);
  font-size: 11px;
}
.desktop-pairing-form input {
  width: 175px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text);
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 15px;
  letter-spacing: 0.14em;
}
.desktop-pairing-form button {
  min-height: 43px;
}
.desktop-pairing > small {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.8;
}
.desktop-pairing-confirm {
  padding-left: 20px;
  line-height: 2;
  color: var(--muted);
}
.desktop-pairing-message {
  border-left: 2px solid var(--accent);
  padding-left: 12px;
}
.desktop-pairing-error {
  color: var(--danger);
}
@media (max-width: 420px) {
  .desktop-pairing-form {
    display: grid;
  }
  .desktop-pairing-form input {
    width: 100%;
  }
}
</style>
