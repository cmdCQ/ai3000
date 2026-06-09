const config = require('./config.js');
const DysmsapiClient = require('@alicloud/dysmsapi20170525').default;
const { Config } = require('@alicloud/openapi-client');
const { RuntimeOptions } = require('@alicloud/tea-util');

const client = new DysmsapiClient(new Config({
  accessKeyId: config.alibaba.accessKeyId,
  accessKeySecret: config.alibaba.accessKeySecret,
  endpoint: 'dysmsapi.aliyuncs.com',
}));

async function main() {
  const runtime = new RuntimeOptions({});

  // 1. Query existing signatures
  console.log('=== 查询已有签名 ===');
  try {
    const { QuerySmsSignListRequest } = require('@alicloud/dysmsapi20170525');
    const req = new QuerySmsSignListRequest({ pageIndex: 1, pageSize: 10 });
    const resp = await client.querySmsSignListWithOptions(req, runtime);
    console.log(JSON.stringify(resp.body, null, 2));
  } catch (e) {
    console.error('Query error:', e.message);
  }

  // 2. Try to add signature
  console.log('\n=== 尝试添加签名 ===');
  try {
    const { AddSmsSignRequest } = require('@alicloud/dysmsapi20170525');
    const addReq = new AddSmsSignRequest({
      signName: '『AI三千问』',
      signSource: 1, // 1=网站
      remark: 'AI三千问平台用户注册登录短信验证码签名',
    });
    const addResp = await client.addSmsSignWithOptions(addReq, runtime);
    console.log(JSON.stringify(addResp.body, null, 2));
  } catch (e) {
    console.error('Add error:', e.message, e.data ? JSON.stringify(e.data) : '');
  }
}

main();
