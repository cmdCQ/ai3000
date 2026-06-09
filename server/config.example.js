// ===== AI三千问 配置示例 =====
// 复制此文件为 config.js 并填入实际值
// config.js 已被 .gitignore 忽略，不会提交到仓库

module.exports = {
  // DeepSeek API
  deepseek: {
    apiKey: 'sk-your-deepseek-api-key-here',
    baseURL: 'https://api.deepseek.com/v1',
  },

  // MySQL 数据库
  mysql: {
    host: 'localhost',
    user: 'your_mysql_user',
    password: 'your_mysql_password',
    database: 'ai3000',
  },

  // 管理员账号
  admin: {
    username: 'admin',
    password: 'your_admin_password',
  },

  // 服务器端口
  port: 3301,

  // 阿里云短信服务（用于手机号验证码登录）
  alibaba: {
    accessKeyId: 'your-aliyun-access-key-id',
    accessKeySecret: 'your-aliyun-access-key-secret',
    signName: '你的短信签名',
    templateCode: '短信模板CODE',
  },

  // JWT 密钥（用于生成用户 token）
  jwtSecret: 'your-jwt-secret-change-this',
};
