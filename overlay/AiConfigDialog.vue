<template>
  <el-dialog
    class="aiConfigDialog"
    :title="$t('ai.AIConfiguration')"
    :visible.sync="aiConfigDialogVisible"
    width="550px"
    append-to-body
  >
    <div class="aiConfigBox">
      <el-form
        :model="ruleForm"
        :rules="rules"
        ref="ruleFormRef"
        label-width="100px"
      >
        <p class="title">{{ $t('ai.VolcanoArkLargeModelConfiguration') }}</p>
        <p class="desc">
          {{ $t('ai.configTip') }}<a href="https://mp.weixin.qq.com/s/JNb7PH4sCjWzIZ9G8wStGQ" target="_blank">{{ $t('ai.course') }}</a
          >。
        </p>
        <el-form-item :label="$t('ai.provider')" prop="provider" v-if="showProvider">
          <el-select
            v-model="ruleForm.provider"
            style="width: 100%"
            @change="onProviderChange"
          >
            <el-option
              v-for="item in providers"
              :key="item.id"
              :label="item.name"
              :value="item.id"
            ></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="API Key" prop="key">
          <el-input v-model="ruleForm.key" show-password></el-input>
        </el-form-item>
        <el-form-item :label="$t('ai.modelUrl')" prop="api">
          <el-input v-model="ruleForm.api"></el-input>
        </el-form-item>
        <el-form-item :label="$t('ai.inferenceAccessPoint')" prop="model">
          <el-input v-model="ruleForm.model"></el-input>
        </el-form-item>
      </el-form>
    </div>
    <div slot="footer" class="dialog-footer">
      <el-button @click="cancel">{{ $t('ai.cancel') }}</el-button>
      <el-button type="primary" @click="confirm">{{
        $t('ai.confirm')
      }}</el-button>
    </div>
  </el-dialog>
</template>

<script>
import { mapState, mapMutations } from 'vuex'

// 内置供应商兜底表（与 DSH 工作台服务端 /ai/providers 保持一致）。
// 作为独立 Web 版运行时拿不到服务端列表，用这张表照常可用。
const FALLBACK_PROVIDERS = [
  {
    id: 'volcengine',
    name: '火山方舟（豆包）',
    url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    model: ''
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini'
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    url: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'moonshot-v1-8k'
  },
  {
    id: 'dashscope',
    name: '阿里云通义千问',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-flash'
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    model: 'deepseek-ai/DeepSeek-V3'
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    url: 'http://127.0.0.1:11434/v1/chat/completions',
    model: 'qwen2.5:7b'
  },
  { id: 'custom', name: '自定义（OpenAI 兼容）', url: '', model: '' }
]

// DSH 工作台服务端的供应商列表接口；独立运行时请求失败即用上面的兜底表。
const PROVIDERS_ENDPOINT = '/api/dsh-mind-workbench/ai/providers'

export default {
  model: {
    prop: 'visible',
    event: 'change'
  },
  props: {
    visible: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      aiConfigDialogVisible: false,
      providers: FALLBACK_PROVIDERS,
      showProvider: true,
      ruleForm: {
        provider: 'custom',
        api: '',
        key: '',
        model: '',
        port: '',
        method: ''
      },
      rules: {
        key: [
          {
            required: true,
            message: this.$t('ai.keyValidateTip'),
            trigger: 'blur'
          }
        ],
        api: [
          {
            required: true,
            message: this.$t('ai.apiValidateTip'),
            trigger: 'blur'
          }
        ],
        model: [
          {
            required: true,
            message: this.$t('ai.modelValidateTip'),
            trigger: 'blur'
          }
        ]
      }
    }
  },
  computed: {
    ...mapState(['aiConfig'])
  },
  watch: {
    visible(val) {
      this.aiConfigDialogVisible = val
    },
    aiConfigDialogVisible(val, oldVal) {
      if (!val && oldVal) {
        this.close()
      }
    }
  },
  created() {
    this.initFormData()
    this.loadProviders()
  },
  methods: {
    ...mapMutations(['setLocalConfig']),

    close() {
      this.$emit('change', false)
    },

    // 从服务端取供应商列表（DSH 工作台内可用）；失败保持兜底表，不影响配置。
    async loadProviders() {
      try {
        const res = await fetch(PROVIDERS_ENDPOINT, { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        const list = data && Array.isArray(data.providers) ? data.providers : []
        const mapped = list
          .filter(item => item && item.id)
          .map(item => ({
            id: item.id,
            name: item.name || item.id,
            url: item.chatUrl || (item.baseUrl ? `${item.baseUrl}/chat/completions` : ''),
            model: item.model || ''
          }))
        if (mapped.length) {
          this.providers = mapped.concat([
            { id: 'custom', name: '自定义（OpenAI 兼容）', url: '', model: '' }
          ])
          this.ruleForm.provider = this.matchProvider(this.ruleForm.api)
        }
      } catch (error) {
        // 独立运行或接口未就绪：兜底表足够
      }
    },

    // 用已保存的 URL 反推供应商，保证打开弹窗时下拉框显示正确。
    matchProvider(url) {
      if (!url) return 'custom'
      const hit = this.providers.find(item => item.url && item.url === url)
      return hit ? hit.id : 'custom'
    },

    onProviderChange(id) {
      const preset = this.providers.find(item => item.id === id)
      if (!preset) return
      if (preset.url) this.ruleForm.api = preset.url
      if (preset.model) this.ruleForm.model = preset.model
    },

    initFormData() {
      Object.keys(this.aiConfig).forEach(key => {
        this.ruleForm[key] = this.aiConfig[key]
      })
      this.ruleForm.provider = this.matchProvider(this.ruleForm.api)
    },

    cancel() {
      this.close()
      this.initFormData()
    },

    confirm() {
      this.$refs.ruleFormRef.validate(valid => {
        if (valid) {
          this.close()
          // provider 只是本弹窗的辅助字段，不写进 aiConfig（store 会忽略未知键之外的键）
          const { provider, ...rest } = this.ruleForm
          this.setLocalConfig({
            ...rest
          })
          this.$message.success(this.$t('ai.configSaveSuccessTip'))
        }
      })
    }
  }
}
</script>

<style lang="less" scoped>
.aiConfigDialog {
  /deep/ .el-dialog__body {
    padding: 12px 20px;
  }

  .aiConfigBox {
    a {
      color: #409eff;
    }

    .title {
      margin-bottom: 12px;
      font-weight: bold;
    }

    .desc {
      margin-bottom: 12px;
      padding-left: 12px;
      border-left: 5px solid #ccc;
    }
  }
}
</style>
