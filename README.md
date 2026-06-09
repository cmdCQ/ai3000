# AI三千问/算卦解析

> 作者：[CQ / 参群](https://github.com/cmdCQ/)

一个基于 DeepSeek API 的玄学解忧 AI 应用，提供梅花易数、六爻等占卜方式的自动排盘和 AI 智能解析。

👉 **GitHub 仓库：** [github.com/cmdCQ/ai3000](https://github.com/cmdCQ/ai3000)

## 功能

- 🔮 **梅花易数** — 数字起卦、AI 智能解卦（含古籍引用）
- ⚛ **六爻** — 铜钱摇卦、纳甲排盘、AI 智能解卦
- 🤖 **AI 解析** — 基于 DeepSeek API，流式输出结果
- 📚 **RAG 知识库** — 向量检索古籍原文，AI 分析有据可依
- 👤 **用户系统** — 手机号注册登录、Token 额度管理
- 🔧 **管理后台** — 用户管理、命盘管理、书籍入库管理
- 🧠 **本地向量检索** — 使用 BAAI/bge-small-zh-v1.5 本地 embedding 模型，免费无需 API

## 技术栈

| 层       | 技术                      |
| -------- | ------------------------- |
| 前端     | 原生 HTML/CSS/JS          |
| 后端     | Node.js (原生 http 模块)  |
| 数据库   | MySQL                     |
| AI 模型  | DeepSeek API（流式输出）  |
| 知识库   | ChromaDB + 本地 Embedding |
| 排盘引擎 | lunar-javascript          |

---
<<<<<<< Updated upstream

## 快速开始
=======
>>>>>>> Stashed changes

## 快速开始

### 环境要求

- **Node.js** ≥ 18.0（[下载](https://nodejs.org/)）
- **Python** ≥ 3.10
- **MySQL** ≥ 8.0（或 MariaDB ≥ 10.5）
- **系统**：Linux / macOS / Windows WSL

### 一键安装

```bash
# 1. 克隆项目
git clone https://github.com/cmdCQ/ai3000.git
cd ai3000

# 2. 运行安装向导
bash setup.sh
```

安装向导会自动完成依赖安装、数据库初始化、RAG 服务配置等步骤。

### 手动安装

#### 第一步：安装后端依赖

```bash
cd server
npm install
```

#### 第二步：配置 MySQL 数据库

```bash
# 创建数据库
mysql -u root -p -e "CREATE DATABASE ai3000 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 导入表结构
mysql -u root -p ai3000 < server/schema.sql
```

> `schema.sql` 会创建 6 张表：`users`（用户）、`charts`（命盘）、`mhys_records`（梅花易数记录）、`liuyao_records`（六爻记录）、`reference_books`（参考书籍）、`suggestions`（用户建议）。

#### 第三步：配置后端

```bash
cp server/config.example.js server/config.js
```

<<<<<<< Updated upstream
编辑 `server/config.js`，填入各项配置（见下方说明）。
=======
编辑 `server/config.js`，填入以下信息：
>>>>>>> Stashed changes

```js
module.exports = {
  deepseek: {
    apiKey: 'sk-你的DeepSeekAPIKey',     // ⚠️ 必填
    baseURL: 'https://api.deepseek.com/v1',
  },
  mysql: {
    host: 'localhost',
    user: '数据库用户名',                   // ⚠️ 必填
    password: '数据库密码',
    database: 'ai3000',
  },
  admin: {
    password: '管理员密码',                 // ⚠️ 必填
  },
  port: 3301,
  // 阿里云短信（选填，手机号登录用）
  alibaba: { /* ... */ },
  jwtSecret: '随意填一个随机字符串',
};
```

#### 第四步：配置 RAG 向量知识库

```bash
cd server/rag
cp config.yaml.example config.yaml
```

编辑 `server/rag/config.yaml`，填入：

```yaml
# DeepSeek API Key（与上面保持一致）
llm:
  api_key: "sk-你的DeepSeekAPIKey"

# Embedding 模式推荐用 local（免费本地 ONNX 模型）
# 如果服务器性能较差，可改为 remote 使用阿里云百炼 API
embedding:
  mode: "local"           # local = 免费本地模型
  model_name: "BAAI/bge-small-zh-v1.5"
  dimension: 512
```

##### 关于 Embedding 模型的说明

| 模式 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| **local**（推荐） | 免费，无 API 调用费用 | 首次加载需下载模型（~400MB），CPU 模式略慢 | 大多数用户 |
| **remote** | 速度快，不占本地资源 | 需要阿里云百炼 API Key，有调用费用 | 服务器配置低或已使用阿里云 |

**local 模式首次运行会自动下载 bge-small-zh-v1.5 模型**（约 400MB），仅在首次入库时下载一次，之后离线可用。

**remote 模式** 需在 [阿里云百炼](https://bailian.console.aliyun.com/) 开通并获取 API Key，配置如下：

```yaml
embedding:
  mode: "remote"
  remote_api_base: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  remote_api_key: "sk-你的阿里云百炼APIKey"
  remote_model_name: "text-embedding-v4"
```

安装 Python 依赖：

```bash
# 推荐使用虚拟环境
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

#### 第五步：下载古籍文本

古籍文本文件约 300+ 本，可从以下仓库获取（已整理为纯文本格式）：

**🔗 古籍下载地址：https://github.com/garychowcmu/daizhigev20/tree/master/易藏**

下载后解压到 `server/data/books/` 目录：

```bash
mkdir -p server/data/books
# 将下载的古籍 .txt 文件放入 server/data/books/
```

#### 第六步：启动服务

需要同时启动两个服务：

**终端 1 — 主后端服务：**

```bash
cd server
node auth-server.js
```

**终端 2 — RAG 知识库服务：**

```bash
cd server/rag
source venv/bin/activate
python3 -m uvicorn src.main:app --host 0.0.0.0 --port 8800 --reload
```

或使用启动脚本：

```bash
cd server/rag && bash start.sh
```

访问 **http://localhost:3301** 即可使用。

---

## 古籍入库到 RAG 知识库

服务启动后，通过管理后台将古籍入库到向量知识库：

1. 访问 **http://localhost:3301/admin/**，用管理员账号登录
2. 点击「古籍管理」→「书籍入库」，选择要入库的书籍
3. 系统会自动：文本分块 → 向量化 → 存储到 ChromaDB
4. 入库完成后，AI 解析时会自动检索并引用古籍原文

### 命令行批量入库

如果古籍文件很多，可以使用批量入库脚本：

```bash
cd server/rag
source venv/bin/activate

# 单文件入库
python scripts/ingest.py ../data/books/渊海子平.txt --book "渊海子平" --category bazi

# 查看参数帮助
python scripts/ingest.py --help
```

可用的分类（category）：
- `bazi` — 四柱八字
- `meihua` — 梅花易数
- `liuyao` — 六爻
- `qimen` — 奇门遁甲
- `yijing` — 易经（通用知识库）
- `general` — 通用术数

---

## 管理后台使用指南

### 1. 访问后台

浏览器打开 `http://你的域名/admin/`。

### 2. 登录

默认管理员账号在 `server/config.js` 中配置：

```js
admin: {
  password: '你设置的密码',  // 首次启动时以此密码初始化
}
```

默认用户名：`CQA`（如需修改，直接编辑 `server/auth-server.js` 中 `defaultAdmin` 的 `username` 字段）

### 3. 修改管理员密码

登录后台后 → 点击右上角「系统设置」→ 点击「修改密码」，输入当前密码和新密码即可。

### 4. 忘记管理员密码

如果忘记了密码，可以：

**方案一：删除数据文件重新初始化**
```bash
rm data/admin.json
# 重启服务后自动用 config.js 中的密码重建
```

**方案二：手动重置**
编辑 `data/admin.json`，将 `passwordHash` 字段置空或删掉，重启服务后自动用 `config.js` 中的密码重新初始化。

### 5. 后台功能一览

| 功能 | 说明 |
|------|------|
| 📊 **仪表盘** | 总用户数、总命盘数、AI 解析统计 |
| 👥 **用户管理** | 查看用户、修改等级、调整 Token 用量 |
| 🔮 **命盘管理** | 查看所有排盘记录（八字/紫微斗数） |
| 📋 **排盘记录** | 梅花易数/六爻记录，支持搜索和删除 |
| 📖 **古籍管理** | 上传书籍 → 入库到 RAG 向量知识库 |
| ✉️ **用户建议** | 查看用户反馈评分和内容 |
| ⚙️ **系统设置** | 修改管理员密码、查看模型配置 |

### 6. 用户等级说明

| 等级 | 名称 | Token 限额 |
|------|------|-----------|
| 0 | 普通用户 | 100,000 Token（约 66 次解析） |
| 1 | 普通会员 | 5,000,000 Token |
| 2 | SVIP | 无限 |

在后台「用户管理」中，点击每行右侧的等级下拉框即可修改。

### 7. 调整用户 Token 用量

在后台「用户管理」中，点击每行右侧的 **Token** 按钮，输入新数值即可。

---

## 项目结构

```
├── server/                  # 后端
│   ├── auth-server.js       # 主服务（API + AI 流式调用）
│   ├── config.example.js    # 配置模板
│   ├── config.js            # 实际配置（已 gitignore）
│   ├── schema.sql           # MySQL 建表语句
│   ├── rag/                 # RAG 向量知识库服务
│   │   ├── config.yaml.example  # RAG 配置模板
│   │   ├── config.yaml          # 实际配置（已 gitignore）
│   │   ├── requirements.txt     # Python 依赖
│   │   ├── start.sh             # 启动脚本
│   │   ├── src/                 # 源码
│   │   │   ├── main.py          # FastAPI 服务入口
│   │   │   ├── chunker.py       # 文本分块器
│   │   │   ├── embedder.py      # 向量嵌入器（本地/远程）
│   │   │   ├── vector_store.py  # ChromaDB 向量存储
│   │   │   ├── rag_pipeline.py  # RAG 检索增强生成
│   │   │   └── models.py        # 数据模型（Pydantic）
│   │   ├── scripts/
│   │   │   ├── ingest.py        # 命令行入库工具
│   │   │   └── batch_ingest.py  # MySQL 批量入库
│   │   └── vector_db/           # ChromaDB 持久化数据（运行时生成）
│   └── data/books/              # 古籍文本文件（需自行下载）
├── my/                      # "我的"页面
├── mhys/                    # 梅花易数
├── liuyao/                  # 六爻
├── admin/                   # 管理后台
├── js/                      # 公共 JS
├── css/                     # 公共 CSS
├── charts/                  # 命盘（八字/紫微斗数）
├── data/                    # 运行时数据（已 gitignore）
├── setup.sh                 # 一键安装脚本
└── README.md
```

## 常见问题

### Q: RAG 服务无法启动？

**A:** 确保已安装所有 Python 依赖：
```bash
cd server/rag
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Q: 本地 embedding 模型下载失败？

**A:** bge-small-zh-v1.5 首次运行时会自动下载到 `~/.cache/huggingface/`。如果下载慢，可以手动下载模型文件后放到缓存目录，或切换到 remote 模式使用阿里云 API。

### Q: 古籍入库后 AI 解析没有引用古籍？

**A:** 检查：
1. RAG 服务是否在运行（`http://localhost:8800/health` 应返回 ok）
2. 书籍是否已入库（管理后台古籍管理查看状态）
3. `server/config.js` 中的 DeepSeek API Key 是否正确

### Q: 手机验证码登录怎么配置？

**A:** 需要在 `server/config.js` 中配置阿里云短信服务。如果不想配置，可以在数据库中直接为用户设置密码，通过用户名+密码登录。

## License

GNU General Public License v3.0 — 详见 [LICENSE](./LICENSE) 文件。

使用本项目的代码或修改版本时，必须同样以 GPL v3 协议开源。
