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
  server.listen(env.port, () => {
    console.log(`BidVibe API đang chạy tại http://localhost:${env.port}`);
  });
}

module.exports = { app, server, io };
