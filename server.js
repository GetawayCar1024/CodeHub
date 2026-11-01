#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp, VERSION } from './src/app.js';

const HELP = `CodeHub ${VERSION}

用法: node server.js [--host 0.0.0.0] [--port 8088] [--data <目录>] [--reset-admin]

  --host         监听地址（默认 0.0.0.0）
  --port         端口（默认 8088）
  --data         数据目录（默认 ./data，或环境变量 CODEHUB_DATA）
  --reset-admin  把管理员密码重置为 123456
  --version      显示版本
`;

const args = process.argv.slice(2);
const defaultData = process.env.CODEHUB_DATA ? path.resolve(process.env.CODEHUB_DATA) : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const opt = { host: '0.0.0.0', port: 8088, data: defaultData, resetAdmin: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--host') opt.host = args[++i];
  else if (a === '--port') opt.port = Number(args[++i]);
  else if (a === '--data') opt.data = path.resolve(args[++i]);
  else if (a === '--reset-admin') opt.resetAdmin = true;
  else if (a === '--version' || a === '-v') {
    console.log(VERSION);
    process.exit(0);
  } else if (a === '--help' || a === '-h') {
    console.log(HELP);
    process.exit(0);
  } else {
    console.error('未知参数: ' + a + '\n\n' + HELP);
    process.exit(1);
  }
}

const app = createApp({ dataDir: opt.data, resetAdmin: opt.resetAdmin });
app.server.listen(opt.port, opt.host, () => {
  app.ctx.log(`CodeHub ${VERSION} listening on http://${opt.host}:${opt.port}/ (data: ${opt.data})`);
  app.start();
});
app.server.on('error', (e) => {
  console.error(e.message);
  process.exit(1);
});

const shutdown = () => {
  app.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
