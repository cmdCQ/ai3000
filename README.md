# AI三千问

一个基于 DeepSeek API 的玄学解忧 AI 应用，提供梅花易数、六爻等占卜方式的自动排盘和 AI 智能解析。

## 功能

- 🔮 **梅花易数** — 数字起卦、AI 智能解卦（含古籍引用）
- ⚛ **六爻** — 铜钱摇卦、纳甲排盘、AI 智能解卦
- 🤖 **AI 解析** — 基于 DeepSeek v4 Flash 模型，流式输出结果
- 📚 **RAG 知识库** — 向量检索古籍原文，AI 分析有据可依
- 👤 **用户系统** — 手机号注册登录、Token 额度管理
- 🔧 **管理后台** — 用户管理、命盘管理、书籍入库管理

## 技术栈

| 层       | 技术                          |
| -------- | ----------------------------- |
| 前端     | 原生 HTML/CSS/JS，暗调新中式  |
| 后端     | Node.js (原生 http 模块)      |
| 数据库   | MySQL                         |
| AI 模型  | DeepSeek v4 Flash (流式输出)  |
| 知识库   | 本地向量检索引擎 (RAG)        |
| 排盘引擎 | lunar-javascript              |

## 本地运行

### 1. 安装依赖

```bash
cd server
npm install
```

### 2. 配置

复制配置模板并填入实际值：

```bash
cp server/config.example.js server/config.js
```

编辑 `server/config.js`，填入：
- DeepSeek API Key ([获取地址](https://platform.deepseek.com/))
- MySQL 数据库连接信息
- 管理员密码

### 3. 初始化数据库

MySQL 中创建 `ai3000` 数据库，并导入 `schema.sql`（如有）。

### 4. 启动

**后端服务：**

```bash
cd server
node auth-server.js
```

**RAG 知识库服务（可选）：**

```bash
cd server
python3 rag-server.py
```

### 5. 访问

浏览器打开 `http://localhost:3301`（或配置的端口）。

## 项目结构

```
├── server/                # 后端
│   ├── auth-server.js     # 主服务（API + AI 流式调用）
│   ├── rag-server.py      # RAG 向量检索服务
│   ├── config.example.js  # 配置模板
│   └── config.js          # 实际配置（已 gitignore）
├── my/                    # "我的"页面
├── mhys/                  # 梅花易数
├── liuyao/                # 六爻
├── admin/                 # 管理后台
├── js/                    # 公共 JS
├── css/                   # 公共 CSS
├── charts/                # 命盘（八字/紫微斗数）
├── register/              # 注册页
├── login/                 # 登录页
└── data/                  # 运行时数据（已 gitignore）
```

## License

MIT
