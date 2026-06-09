# AI三千问/算卦解析

> 作者：[CQ / 参群](https://github.com/cmdCQ/)

一个基于 DeepSeek API 的玄学解忧 AI 应用，提供梅花易数、六爻等占卜方式的自动排盘和 AI 智能解析。

👉 **GitHub 仓库：** [github.com/cmdCQ/AI3000](https://github.com/cmdCQ/AI3000)

---

## 简介

**AI三千问** 是一款将传统玄学与现代 AI 结合的应用。

你可以用它来：
- 🎴 **梅花易数** — 心里想一件事，输入几个数字，自动起卦、AI 解卦
- ⚛ **六爻** — 像古人一样摇铜钱，纳甲排盘，AI 分析吉凶
- 📊 **八字/紫微斗数** — 输入出生信息，AI 解析命盘
- 📖 **AI 智能解析** — 每次解析都会匹配古籍原文，有理有据，不是瞎编
- 🧠 **RAG 知识库** — 背后有 300+ 本古籍向量化，AI 分析时自动引用《渊海子平》《三命通会》《滴天髓》等经典

所有 AI 解析默认使用 **DeepSeek API**，古籍向量检索使用 **本地 Embedding 模型**（BAAI/bge-small-zh-v1.5），无需额外付费。

---

## 功能

| 功能 | 说明 |
|------|------|
| 🔮 **梅花易数** | 数字起卦、AI 智能解卦（含古籍引用） |
| ⚛ **六爻** | 铜钱摇卦、纳甲排盘、AI 智能解卦 |
| 📊 **八字/紫微斗数** | 排盘管理、AI 智能解析 |
| 🤖 **AI 解析** | 基于 DeepSeek API，流式输出 |
| 📚 **RAG 知识库** | 向量检索古籍原文，AI 分析有据可依 |
| 👤 **用户系统** | 手机号注册登录、Token 额度管理 |
| 🔧 **管理后台** | 用户管理、命盘管理、书籍入库 |

## 技术栈

| 层 | 技术 |
|------|--------|
| 前端 | 原生 HTML/CSS/JS，暗调新中式风格 |
| 后端 | Node.js（原生 http 模块） |
| 数据库 | MySQL |
| AI 模型 | DeepSeek API（流式输出） |
| 知识库 | ChromaDB + 本地 Embedding 模型 |
| 排盘引擎 | [lunar-javascript](https://github.com/6tail/lunar-javascript) |

---

## 快速开始

### 环境要求

- **Node.js** ≥ 18.0
- **Python** ≥ 3.10
- **MySQL** ≥ 8.0（或 MariaDB ≥ 10.5）

### 一键安装

```bash
git clone https://github.com/cmdCQ/AI3000.git
cd AI3000
bash setup.sh
```

安装向导会自动完成依赖安装、数据库初始化、配置文件生成等。

### 手动安装

#### 1. 安装后端依赖

```bash
cd server
npm install
```

#### 2. 配置 MySQL

```bash
mysql -u root -p -e "CREATE DATABASE ai3000 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p ai3000 < server/schema.sql
```

#### 3. 配置后端

```bash
cp server/config.example.js server/config.js
```

编辑 `server/config.js`，填入：

```js
module.exports = {
  deepseek: {
    apiKey: 'sk-你的DeepSeekAPIKey',     // ⚠️ 必填
    baseURL: 'https://api.deepseek.com/v1',
  },
  mysql: {
    host: 'localhost',
    user: '数据库用户名',
    password: '数据库密码',
    database: 'ai3000',
  },
  admin: {
    password: '管理员密码',               // ⚠️ 必填
  },
  port: 3301,
  jwtSecret: '填一个随机字符串',
};
```

#### 4. 配置 RAG 向量知识库

```bash
cd server/rag
cp config.yaml.example config.yaml
```

编辑 `server/rag/config.yaml`，填入 DeepSeek API Key。

安装 Python 依赖：

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

#### 5. 下载古籍文本

从以下仓库获取 300+ 本已整理好的命理古籍：

**🔗 https://github.com/garychowcmu/daizhigev20/tree/master/易藏**

下载后解压到 `server/data/books/`：

```bash
mkdir -p server/data/books
# 将下载的 .txt 文件放入 server/data/books/
```

#### 6. 启动服务

**终端 1 — 主服务：**

```bash
cd server
node auth-server.js
```

**终端 2 — RAG 服务：**

```bash
cd server/rag
source venv/bin/activate
python3 -m uvicorn src.main:app --host 0.0.0.0 --port 8800 --reload
```

浏览器打开 **http://localhost:3301**。

---

## 古籍入库

服务启动后，通过管理后台将古籍入库到向量知识库：

1. 访问 **http://localhost:3301/admin/**，用管理员账号登录
2. 点击「古籍管理」→「书籍入库」，选择要入库的书籍
3. 系统自动完成：文本分块 → 向量化 → 存储到 ChromaDB
4. 入库完成后，AI 解析会自动检索并引用古籍原文

### 命令行入库

```bash
cd server/rag
source venv/bin/activate
python scripts/ingest.py ../data/books/渊海子平.txt --book "渊海子平" --category bazi
```

可用分类：`bazi` `meihua` `liuyao` `qimen` `yijing` `general`

---

## Embedding 模式说明

| 模式 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| **local**（推荐） | 免费，离线可用 | 首次需下载模型 ~400MB | 大多数用户 |
| **remote** | 速度快，不占资源 | 需阿里云百炼 API Key | 低配服务器 |

---

## 管理后台

访问 `http://localhost:3301/admin/`

- **默认用户名：** `CQA`（可在 `server/auth-server.js` 中修改）
- **默认密码：** 在 `server/config.js` 中设置
- **功能：** 用户管理、命盘管理、古籍入库、系统设置

---

## 项目结构

```
├── server/                  # 后端
│   ├── auth-server.js       # 主服务
│   ├── config.example.js    # 配置模板
│   ├── schema.sql           # MySQL 建表语句
│   ├── rag/                 # RAG 向量知识库服务
│   │   ├── src/             # Python 源码
│   │   ├── scripts/         # 入库工具
│   │   └── start.sh         # 启动脚本
│   └── data/books/          # 古籍文本（需自行下载）
├── mhys/                    # 梅花易数
├── liuyao/                  # 六爻
├── admin/                   # 管理后台
├── charts/                  # 八字/紫微斗数排盘
├── setup.sh                 # 一键安装脚本
└── README.md
```

---

## License

GNU General Public License v3.0 — 详见 [LICENSE](./LICENSE) 文件。
