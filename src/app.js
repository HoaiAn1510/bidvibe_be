const http = require('http');
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

// Cho phép route/service truy cập io qua req.app.get('io')
app.set('io', io);

app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

registerSockets(io);

if (require.main === module) {
  // 0.0.0.0 để emulator Android (10.0.2.2) và điện thoại thật cùng mạng kết nối được
  server.listen(env.port, '0.0.0.0', () => {
    console.log(`BidVibe API đang chạy tại http://localhost:${env.port}`);
    require('./services/scheduler').start();
    require('./sockets/pause_listener').start(); // BE1: auction:update khi tạm dừng / tiếp tục
  });
}

module.exports = { app, server, io };
