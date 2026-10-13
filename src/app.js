const http = require('http');
const os = require('os');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const env = require('./config/env');
const routes = require('./routes');
const registerSockets = require('./sockets');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: env.corsOrigin } });

app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());

app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

registerSockets(io);

// Địa chỉ IPv4 trong mạng LAN của máy (cho điện thoại thật cùng Wi-Fi).
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

// Ctrl+C / nodemon khởi động lại: dừng job nền, đóng socket, trả kết nối database ngay
// (Supabase session pooler chỉ cho 15 kết nối cho cả database). Tối đa 3 giây rồi thoát.
function shutdown(signal) {
  if (shutdown.started) return;
  shutdown.started = true;
  console.log(`\nNhận ${signal}, đang tắt server...`);
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  (async () => {
    require('./services/scheduler').stop();
    await require('./sockets/pause_listener').stop().catch(() => {});
    await new Promise((resolve) => io.close(() => resolve()));
    await new Promise((resolve) => server.close(() => resolve()));
    await require('./sockets/broadcast').drain(); // NOTIFY đang gửi cho backend khác
    await require('./config/db').pool.end().catch(() => {});
  })().finally(() => {
    // nodemon chờ tiến trình thoát bằng chính SIGUSR2 để khởi động lại.
    // (Windows: nodemon tự kết thúc tiến trình, không gửi SIGUSR2.)
    if (signal === 'SIGUSR2' && process.platform !== 'win32') process.kill(process.pid, 'SIGUSR2');
    else process.exit(0);
  });
}

if (require.main === module) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Cổng ${env.port} đang bị dùng (có thể đã chạy npm run dev ở cửa sổ khác)`);
      process.exit(1);
    }
    throw err;
  });
  ['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => shutdown(s)));
  process.once('SIGUSR2', () => shutdown('SIGUSR2'));

  // 0.0.0.0 để emulator Android (10.0.2.2) và điện thoại thật cùng mạng kết nối được
  server.listen(env.port, '0.0.0.0', () => {
    console.log(`BidVibe API đang chạy tại http://localhost:${env.port}`);
    console.log(`  Android Emulator: http://10.0.2.2:${env.port}`);
    lanAddresses().forEach((ip) => console.log(`  Điện thoại thật (cùng Wi-Fi): http://${ip}:${env.port}`));
    require('./services/scheduler').start();
    require('./sockets/pause_listener').start(); // BE1: auction:update khi tạm dừng / tiếp tục
  });
}

module.exports = { app, server, io };
